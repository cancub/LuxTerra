"""
Tile cache manager for local DTM GeoTIFF storage and verification.
Supports downloading full GeoTIFFs or extracting windowed sub-regions from Cloud-Optimized GeoTIFFs (COGs).
"""

import json
import logging
import threading
import uuid
from pathlib import Path
from typing import Dict, Any, List, Optional, Tuple
import requests
import rasterio
from rasterio.windows import from_bounds
from shapely.geometry import box

from .geo_utils import transform_geometry

logger = logging.getLogger(__name__)

DEFAULT_CACHE_DIR = Path(__file__).resolve().parents[4] / "data" / "dtm"
DEFAULT_DSM_DIR = Path(__file__).resolve().parents[4] / "data" / "dsm"


class TileCacheManager:
    """
    Manages local storage, downloading, and validation of GeoTIFF elevation tiles
    for both bare-earth DTM and surface/canopy DSM layers.
    """

    def __init__(self, cache_dir: Optional[Path] = None, dsm_dir: Optional[Path] = None):
        self.cache_dir = Path(cache_dir) if cache_dir else DEFAULT_CACHE_DIR
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        
        if dsm_dir:
            self.dsm_dir = Path(dsm_dir)
        else:
            if self.cache_dir.name == "dtm":
                self.dsm_dir = self.cache_dir.parent / "dsm"
            else:
                self.dsm_dir = self.cache_dir / "dsm"
        self.dsm_dir.mkdir(parents=True, exist_ok=True)

        self.manifest_path = self.cache_dir / "manifest.json"
        self._manifest_cache: Optional[Dict[str, Any]] = None
        self._manifest_mtime: Optional[float] = None
        self._lock = threading.RLock()

    def _get_target_dir(self, layer: str = "dtm") -> Path:
        return self.dsm_dir if layer.lower() == "dsm" else self.cache_dir

    def is_tile_cached(self, filename: str, layer: str = "dtm") -> bool:
        """Check if a tile exists on disk in the target layer directory and is a valid readable GeoTIFF."""
        with self._lock:
            target_dir = self._get_target_dir(layer)
            filepath = target_dir / filename
            if not filepath.exists() or filepath.stat().st_size == 0:
                return False

            # Fast-path: check if already verified in the manifest
            if self._manifest_cache:
                for tile in self._manifest_cache.get("tiles", []):
                    fn_key = "dsm_filename" if layer.lower() == "dsm" else "filename"
                    if tile.get(fn_key) == filename and tile.get("width", 0) > 0:
                        return True

            try:
                with rasterio.open(filepath) as src:
                    return src.width > 0 and src.height > 0
            except Exception:
                return False

    def download_tile(self, url: str, filename: str, layer: str = "dtm", timeout: int = 60) -> Path:
        """
        Downloads a GeoTIFF tile from a remote URL to the local cache directory for the specified layer.
        Downloads to a temporary file first and atomically renames upon validation.
        """
        target_dir = self._get_target_dir(layer)
        final_path = target_dir / filename
        if self.is_tile_cached(filename, layer=layer):
            logger.info(f"{layer.upper()} tile {filename} is already cached. Skipping download.")
            return final_path

        temp_path = target_dir / f"{filename}.{uuid.uuid4().hex}.tmp"
        logger.info(f"Downloading {layer.upper()} from {url} to {temp_path}...")

        headers = {"User-Agent": "LuxTerra-ElevationClient/1.0"}
        try:
            response = requests.get(url, stream=True, timeout=timeout, headers=headers)
            response.raise_for_status()

            with open(temp_path, "wb") as f:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if chunk:
                        f.write(chunk)

            # Validate that the downloaded file is a readable raster
            with rasterio.open(temp_path) as src:
                logger.info(
                    f"Validated {layer.upper()} {filename}: {src.width}x{src.height}, CRS={src.crs}, res={src.res}"
                )

            # Atomic move
            temp_path.replace(final_path)
        except Exception as e:
            if temp_path.exists():
                temp_path.unlink(missing_ok=True)
            if isinstance(e, requests.RequestException):
                raise
            raise ValueError(f"Downloaded file from {url} is not a valid GeoTIFF raster: {e}") from e

        self.update_manifest()
        return final_path

    def extract_cog_window(
        self,
        cog_url: str,
        wgs84_bbox: List[float],
        filename: str,
        layer: str = "dtm"
    ) -> Path:
        """
        Extracts a localized sub-region directly from a remote Cloud-Optimized GeoTIFF (COG)
        via GDAL virtual filesystem (/vsicurl/) without downloading the entire massive tile.
        """
        target_dir = self._get_target_dir(layer)
        final_path = target_dir / filename
        if self.is_tile_cached(filename, layer=layer):
            logger.info(f"{layer.upper()} tile {filename} already exists in cache. Skipping COG extraction.")
            return final_path

        min_lon, min_lat, max_lon, max_lat = wgs84_bbox
        vsi_url = f"/vsicurl/{cog_url}" if not cog_url.startswith("/vsi") else cog_url
        
        temp_path = target_dir / f"{filename}.{uuid.uuid4().hex}.tmp"
        logger.info(f"Streaming windowed extraction from COG: {cog_url} for bbox {wgs84_bbox} into {layer.upper()}...")
        try:
            with rasterio.Env(
                CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif",
                GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
                GDAL_HTTP_TIMEOUT="30",
                GDAL_HTTP_MAX_RETRY="3"
            ):
                with rasterio.open(vsi_url) as src:
                    src_crs_str = src.crs.to_string() if hasattr(src.crs, 'to_string') else str(src.crs)
                    patch_wgs84 = box(min_lon, min_lat, max_lon, max_lat)
                    patch_native = transform_geometry(patch_wgs84, "EPSG:4326", src_crs_str)

                    nodata_val = src.nodata if src.nodata is not None else -9999.0
                    window = from_bounds(*patch_native.bounds, src.transform)
                    data = src.read(1, window=window, boundless=True, fill_value=nodata_val)
                    window_transform = rasterio.windows.transform(window, src.transform)

                    with rasterio.open(
                        temp_path,
                        'w',
                        driver='GTiff',
                        height=data.shape[0],
                        width=data.shape[1],
                        count=1,
                        dtype=data.dtype,
                        crs=src.crs,
                        transform=window_transform,
                        nodata=nodata_val,
                        compress='lzw'
                    ) as dst:
                        dst.write(data, 1)

            temp_path.replace(final_path)
        except Exception:
            if temp_path.exists():
                temp_path.unlink(missing_ok=True)
            raise
        logger.info(f"Extracted and saved local {layer.upper()} COG tile: {final_path} ({data.shape[1]}x{data.shape[0]})")
        self.upsert_manifest_tile(final_path, layer=layer)
        return final_path

    def get_tile_pairs(
        self,
        min_lon: float,
        min_lat: float,
        max_lon: float,
        max_lat: float
    ) -> List[Tuple[Path, Optional[Path]]]:
        """
        Locates all cached DTM and DSM tile pairs intersecting the bounding box,
        ordered with verified DSM-paired tiles first.
        """
        with self._lock:
            manifest = self.load_manifest()
            patch_box = box(min_lon, min_lat, max_lon, max_lat)

            paired_candidates: List[Tuple[Path, Optional[Path]]] = []
            dtm_only_candidates: List[Tuple[Path, Optional[Path]]] = []

            for tile in manifest.get("tiles", []):
                tile_wgs84 = box(*tile["bounds_wgs84"])
                if not tile_wgs84.intersects(patch_box):
                    continue

                dtm_candidate = self.cache_dir / tile["filename"]
                if not dtm_candidate.exists() and tile.get("path"):
                    dtm_candidate = Path(tile["path"])

                if not dtm_candidate.exists():
                    continue

                dsm_candidate = None
                if tile.get("has_dsm") and tile.get("dsm_filename"):
                    dsm_p = self.dsm_dir / tile["dsm_filename"]
                    if dsm_p.exists():
                        dsm_candidate = dsm_p
                elif tile.get("dsm_path"):
                    dsm_p = Path(tile["dsm_path"])
                    if dsm_p.exists():
                        dsm_candidate = dsm_p
                else:
                    stem_guess = dtm_candidate.name.replace("dtm", "dsm")
                    dsm_p = self.dsm_dir / stem_guess
                    if dsm_p.exists():
                        dsm_candidate = dsm_p

                if dsm_candidate is not None and dsm_candidate.exists():
                    paired_candidates.append((dtm_candidate, dsm_candidate))
                else:
                    dtm_only_candidates.append((dtm_candidate, None))

            return paired_candidates + dtm_only_candidates

    def get_tile_pair(
        self,
        min_lon: float,
        min_lat: float,
        max_lon: float,
        max_lat: float
    ) -> Tuple[Optional[Path], Optional[Path]]:
        """
        Locates the cached DTM and DSM tile pair intersecting the bounding box.
        Prioritizes candidate tile pairs that have a valid surface/canopy DSM.
        Returns (dtm_path, dsm_path). If DSM is missing across all candidates, returns (dtm_path, None).
        """
        pairs = self.get_tile_pairs(min_lon, min_lat, max_lon, max_lat)
        return pairs[0] if pairs else (None, None)

    def _find_paired_dsm(self, dtm_filename: str) -> Optional[str]:
        possible_dsm_names = [
            dtm_filename.replace("dtm", "dsm"),
            dtm_filename.replace("DTM", "DSM"),
            dtm_filename,
        ]
        for dsm_name in possible_dsm_names:
            candidate_dsm = self.dsm_dir / dsm_name
            if candidate_dsm.exists() and candidate_dsm.stat().st_size > 0:
                return candidate_dsm.name
        return None

    def _build_tile_info(self, tif_file: Path) -> Dict[str, Any]:
        with rasterio.open(tif_file) as src:
            src_crs_str = src.crs.to_string() if hasattr(src.crs, "to_string") else str(src.crs)
            geom_wgs84 = transform_geometry(box(*src.bounds), src_crs_str, "EPSG:4326")
            min_lon, min_lat, max_lon, max_lat = geom_wgs84.bounds

            dsm_filename = self._find_paired_dsm(tif_file.name)
            dsm_rel_path = f"{self.dsm_dir.name}/{dsm_filename}" if dsm_filename else None
            dtm_rel_path = f"{self.cache_dir.name}/{tif_file.name}"

            return {
                "filename": tif_file.name,
                "path": dtm_rel_path,
                "crs": src_crs_str,
                "width": src.width,
                "height": src.height,
                "resolution": list(src.res),
                "bounds_native": list(src.bounds),
                "bounds_wgs84": [min_lon, min_lat, max_lon, max_lat],
                "nodata": src.nodata,
                "filesize_bytes": tif_file.stat().st_size,
                "has_dsm": dsm_filename is not None,
                "dsm_filename": dsm_filename,
                "dsm_path": dsm_rel_path,
            }

    def _write_manifest_if_changed(self, manifest: Dict[str, Any]) -> Dict[str, Any]:
        manifest["tiles"].sort(key=lambda t: t.get("filename", ""))
        with self._lock:
            if self.manifest_path.exists():
                try:
                    with open(self.manifest_path, "r") as f:
                        existing_manifest = json.load(f)
                    if existing_manifest == manifest:
                        self._manifest_cache = manifest
                        self._manifest_mtime = self.manifest_path.stat().st_mtime
                        return manifest
                except Exception as e:
                    logger.debug(f"Could not compare existing manifest: {e}")

            temp_manifest = self.cache_dir / f"manifest.{uuid.uuid4().hex}.tmp"
            try:
                with open(temp_manifest, "w") as f:
                    json.dump(manifest, f, indent=2)
                temp_manifest.replace(self.manifest_path)
            except Exception:
                if temp_manifest.exists():
                    temp_manifest.unlink(missing_ok=True)
                raise

            self._manifest_cache = manifest
            self._manifest_mtime = self.manifest_path.stat().st_mtime
            return manifest

    def upsert_manifest_tile(self, filepath: Path, layer: str = "dtm") -> Dict[str, Any]:
        """Incrementally add or update a single extracted tile in manifest.json without rescanning all .tif files."""
        with self._lock:
            if not self.manifest_path.exists():
                return self.update_manifest()

            manifest = self.load_manifest()
            tiles = [dict(t) for t in manifest.get("tiles", [])]

            if layer.lower() == "dsm":
                updated = False
                for tile in tiles:
                    fn = tile.get("filename", "")
                    if filepath.name in (fn.replace("dtm", "dsm"), fn.replace("DTM", "DSM"), fn):
                        tile["has_dsm"] = True
                        tile["dsm_filename"] = filepath.name
                        tile["dsm_path"] = f"{self.dsm_dir.name}/{filepath.name}"
                        updated = True
                if not updated:
                    return manifest
                return self._write_manifest_if_changed({"tiles": tiles})

            try:
                tile_info = self._build_tile_info(filepath)
            except Exception as e:
                logger.warning(f"Could not read tile {filepath.name} for manifest: {e}")
                return manifest

            tiles = [t for t in tiles if t.get("filename") != filepath.name]
            tiles.append(tile_info)
            return self._write_manifest_if_changed({"tiles": tiles})

    def update_manifest(self) -> Dict[str, Any]:
        """
        Scans all GeoTIFF files in cache_dir and dsm_dir, updating manifest.json with paired spatial metadata.
        """
        with self._lock:
            manifest = {"tiles": []}
            for tif_file in self.cache_dir.glob("*.tif"):
                try:
                    manifest["tiles"].append(self._build_tile_info(tif_file))
                except Exception as e:
                    logger.warning(f"Could not read tile {tif_file.name} for manifest: {e}")

            return self._write_manifest_if_changed(manifest)

    def load_manifest(self) -> Dict[str, Any]:
        """Load manifest.json with in-memory mtime caching, or build it if missing."""
        with self._lock:
            if not self.manifest_path.exists():
                return self.update_manifest()

            try:
                current_mtime = self.manifest_path.stat().st_mtime
                if self._manifest_cache is not None and self._manifest_mtime == current_mtime:
                    return self._manifest_cache

                with open(self.manifest_path, "r") as f:
                    manifest = json.load(f)
                self._manifest_cache = manifest
                self._manifest_mtime = current_mtime
                return manifest
            except Exception as e:
                logger.warning(f"Failed to load manifest.json, rebuilding: {e}")
                return self.update_manifest()
