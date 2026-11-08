"""
Tile cache manager for local DTM GeoTIFF storage and verification.
Supports downloading full GeoTIFFs or extracting windowed sub-regions from Cloud-Optimized GeoTIFFs (COGs).
"""

import os
import json
import logging
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

    def _get_target_dir(self, layer: str = "dtm") -> Path:
        return self.dsm_dir if layer.lower() == "dsm" else self.cache_dir

    def is_tile_cached(self, filename: str, layer: str = "dtm") -> bool:
        """Check if a tile exists on disk in the target layer directory and is a valid readable GeoTIFF."""
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

        temp_path = target_dir / f"{filename}.tmp"
        logger.info(f"Downloading {layer.upper()} from {url} to {temp_path}...")
        
        headers = {"User-Agent": "LuxTerra-ElevationClient/1.0"}
        response = requests.get(url, stream=True, timeout=timeout, headers=headers)
        response.raise_for_status()

        with open(temp_path, "wb") as f:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    f.write(chunk)

        # Validate that the downloaded file is a readable raster
        try:
            with rasterio.open(temp_path) as src:
                logger.info(
                    f"Validated {layer.upper()} {filename}: {src.width}x{src.height}, CRS={src.crs}, res={src.res}"
                )
        except Exception as e:
            if temp_path.exists():
                temp_path.unlink()
            raise ValueError(f"Downloaded file from {url} is not a valid GeoTIFF raster: {e}")

        # Atomic move
        temp_path.replace(final_path)
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
        
        logger.info(f"Streaming windowed extraction from COG: {cog_url} for bbox {wgs84_bbox} into {layer.upper()}...")
        with rasterio.Env(CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif", GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR"):
            with rasterio.open(vsi_url) as src:
                src_crs_str = src.crs.to_string() if hasattr(src.crs, 'to_string') else str(src.crs)
                patch_wgs84 = box(min_lon, min_lat, max_lon, max_lat)
                patch_native = transform_geometry(patch_wgs84, "EPSG:4326", src_crs_str)
                
                window = from_bounds(*patch_native.bounds, src.transform)
                data = src.read(1, window=window)
                window_transform = rasterio.windows.transform(window, src.transform)
                
                temp_path = target_dir / f"{filename}.tmp"
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
                    nodata=src.nodata if src.nodata is not None else -9999.0,
                    compress='lzw'
                ) as dst:
                    dst.write(data, 1)

        temp_path.replace(final_path)
        logger.info(f"Extracted and saved local {layer.upper()} COG tile: {final_path} ({data.shape[1]}x{data.shape[0]})")
        self.update_manifest()
        return final_path

    def get_tile_pair(
        self,
        min_lon: float,
        min_lat: float,
        max_lon: float,
        max_lat: float
    ) -> Tuple[Optional[Path], Optional[Path]]:
        """
        Locates the cached DTM and DSM tile pair intersecting the bounding box.
        Returns (dtm_path, dsm_path). If DSM is missing, returns (dtm_path, None).
        """
        manifest = self.load_manifest()
        patch_box = box(min_lon, min_lat, max_lon, max_lat)

        for tile in manifest.get("tiles", []):
            tile_wgs84 = box(*tile["bounds_wgs84"])
            if tile_wgs84.intersects(patch_box):
                dtm_candidate = self.cache_dir / tile["filename"]
                if not dtm_candidate.exists():
                    dtm_candidate = Path(tile["path"])
                
                if dtm_candidate.exists():
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
                        # Fallback: check matching stem in dsm_dir
                        stem_guess = dtm_candidate.name.replace("dtm", "dsm")
                        dsm_p = self.dsm_dir / stem_guess
                        if dsm_p.exists():
                            dsm_candidate = dsm_p

                    return (dtm_candidate, dsm_candidate)

        return (None, None)

    def update_manifest(self) -> Dict[str, Any]:
        """
        Scans all GeoTIFF files in cache_dir and dsm_dir, updating manifest.json with paired spatial metadata.
        """
        manifest = {"tiles": []}
        for tif_file in self.cache_dir.glob("*.tif"):
            try:
                with rasterio.open(tif_file) as src:
                    src_crs_str = src.crs.to_string() if hasattr(src.crs, 'to_string') else str(src.crs)
                    geom_wgs84 = transform_geometry(box(*src.bounds), src_crs_str, "EPSG:4326")
                    min_lon, min_lat, max_lon, max_lat = geom_wgs84.bounds

                    # Check for paired DSM tile
                    dsm_filename = None
                    dsm_path = None
                    has_dsm = False

                    # Check pattern replacements e.g. dtm_foo -> dsm_foo
                    possible_dsm_names = [
                        tif_file.name.replace("dtm", "dsm"),
                        tif_file.name.replace("DTM", "DSM"),
                        tif_file.name
                    ]
                    for dsm_name in possible_dsm_names:
                        candidate_dsm = self.dsm_dir / dsm_name
                        if candidate_dsm.exists() and candidate_dsm.stat().st_size > 0:
                            dsm_filename = candidate_dsm.name
                            dsm_path = str(candidate_dsm)
                            has_dsm = True
                            break

                    tile_info = {
                        "filename": tif_file.name,
                        "path": str(tif_file),
                        "crs": src_crs_str,
                        "width": src.width,
                        "height": src.height,
                        "resolution": list(src.res),
                        "bounds_native": list(src.bounds),
                        "bounds_wgs84": [min_lon, min_lat, max_lon, max_lat],
                        "nodata": src.nodata,
                        "filesize_bytes": tif_file.stat().st_size,
                        "has_dsm": has_dsm,
                        "dsm_filename": dsm_filename,
                        "dsm_path": dsm_path
                    }
                    manifest["tiles"].append(tile_info)
            except Exception as e:
                logger.warning(f"Could not read tile {tif_file.name} for manifest: {e}")

        with open(self.manifest_path, "w") as f:
            json.dump(manifest, f, indent=2)

        self._manifest_cache = manifest
        self._manifest_mtime = self.manifest_path.stat().st_mtime
        return manifest

    def load_manifest(self) -> Dict[str, Any]:
        """Load manifest.json with in-memory mtime caching, or build it if missing."""
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
        except Exception:
            return self.update_manifest()
