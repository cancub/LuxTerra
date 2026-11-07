"""
Tile cache manager for local DTM GeoTIFF storage and verification.
Supports downloading full GeoTIFFs or extracting windowed sub-regions from Cloud-Optimized GeoTIFFs (COGs).
"""

import os
import json
import logging
from pathlib import Path
from typing import Dict, Any, List, Optional
import requests
import rasterio
from rasterio.windows import from_bounds
from shapely.geometry import box

from .geo_utils import transform_geometry

logger = logging.getLogger(__name__)

DEFAULT_CACHE_DIR = Path(__file__).resolve().parents[4] / "data" / "dtm"


class TileCacheManager:
    """
    Manages local storage, downloading, and validation of GeoTIFF elevation tiles.
    """

    def __init__(self, cache_dir: Optional[Path] = None):
        self.cache_dir = Path(cache_dir) if cache_dir else DEFAULT_CACHE_DIR
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.manifest_path = self.cache_dir / "manifest.json"

    def is_tile_cached(self, filename: str) -> bool:
        """Check if a tile exists on disk and is a valid readable GeoTIFF."""
        filepath = self.cache_dir / filename
        if not filepath.exists():
            return False
        try:
            with rasterio.open(filepath) as src:
                return src.width > 0 and src.height > 0
        except Exception:
            return False

    def download_tile(self, url: str, filename: str, timeout: int = 60) -> Path:
        """
        Downloads a GeoTIFF tile from a remote URL to the local cache directory.
        Downloads to a temporary file first and atomically renames upon validation.
        """
        final_path = self.cache_dir / filename
        if self.is_tile_cached(filename):
            logger.info(f"Tile {filename} is already cached. Skipping download.")
            return final_path

        temp_path = self.cache_dir / f"{filename}.tmp"
        logger.info(f"Downloading DTM from {url} to {temp_path}...")
        
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
                    f"Validated {filename}: {src.width}x{src.height}, CRS={src.crs}, res={src.res}"
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
        filename: str
    ) -> Path:
        """
        Extracts a localized sub-region directly from a remote Cloud-Optimized GeoTIFF (COG)
        via GDAL virtual filesystem (/vsicurl/) without downloading the entire massive tile.
        """
        final_path = self.cache_dir / filename
        if self.is_tile_cached(filename):
            logger.info(f"Tile {filename} already exists in cache. Skipping COG extraction.")
            return final_path

        min_lon, min_lat, max_lon, max_lat = wgs84_bbox
        vsi_url = f"/vsicurl/{cog_url}" if not cog_url.startswith("/vsi") else cog_url
        
        logger.info(f"Streaming windowed extraction from COG: {cog_url} for bbox {wgs84_bbox}...")
        with rasterio.open(vsi_url) as src:
            src_crs_str = src.crs.to_string() if hasattr(src.crs, 'to_string') else str(src.crs)
            patch_wgs84 = box(min_lon, min_lat, max_lon, max_lat)
            patch_native = transform_geometry(patch_wgs84, "EPSG:4326", src_crs_str)
            
            window = from_bounds(*patch_native.bounds, src.transform)
            data = src.read(1, window=window)
            window_transform = rasterio.windows.transform(window, src.transform)
            
            temp_path = self.cache_dir / f"{filename}.tmp"
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
        logger.info(f"Extracted and saved local COG tile: {final_path} ({data.shape[1]}x{data.shape[0]})")
        self.update_manifest()
        return final_path

    def update_manifest(self) -> Dict[str, Any]:
        """
        Scans all GeoTIFF files in the cache directory and updates manifest.json with spatial metadata.
        """
        manifest = {"tiles": []}
        for tif_file in self.cache_dir.glob("*.tif"):
            try:
                with rasterio.open(tif_file) as src:
                    src_crs_str = src.crs.to_string() if hasattr(src.crs, 'to_string') else str(src.crs)
                    geom_wgs84 = transform_geometry(box(*src.bounds), src_crs_str, "EPSG:4326")
                    min_lon, min_lat, max_lon, max_lat = geom_wgs84.bounds

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
                        "filesize_bytes": tif_file.stat().st_size
                    }
                    manifest["tiles"].append(tile_info)
            except Exception as e:
                logger.warning(f"Could not read tile {tif_file.name} for manifest: {e}")

        with open(self.manifest_path, "w") as f:
            json.dump(manifest, f, indent=2)

        return manifest

    def load_manifest(self) -> Dict[str, Any]:
        """Load manifest.json, or build it if missing."""
        if not self.manifest_path.exists():
            return self.update_manifest()
        try:
            with open(self.manifest_path, "r") as f:
                return json.load(f)
        except Exception:
            return self.update_manifest()
