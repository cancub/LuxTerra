"""
Tile cache manager for local DTM GeoTIFF storage and verification.
"""

import os
import json
import logging
from pathlib import Path
from typing import Dict, Any, List, Optional
import requests
import rasterio

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

    def update_manifest(self) -> Dict[str, Any]:
        """
        Scans all GeoTIFF files in the cache directory and updates manifest.json with spatial metadata.
        """
        manifest = {"tiles": []}
        for tif_file in self.cache_dir.glob("*.tif"):
            try:
                with rasterio.open(tif_file) as src:
                    # Convert bounds to WGS84 for manifest indexing
                    import pyproj
                    from shapely.geometry import box
                    from shapely.ops import transform
                    
                    transformer = pyproj.Transformer.from_crs(src.crs, "EPSG:4326", always_xy=True).transform
                    geom_wgs84 = transform(transformer, box(*src.bounds))
                    min_lon, min_lat, max_lon, max_lat = geom_wgs84.bounds

                    tile_info = {
                        "filename": tif_file.name,
                        "path": str(tif_file),
                        "crs": str(src.crs),
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
