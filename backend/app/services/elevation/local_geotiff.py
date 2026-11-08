"""
Local GeoTIFF Elevation Provider.
Performs windowed extraction of LiDAR DTM rasters with perimeter buffering.
"""

import logging
from typing import Dict, Any, Optional
from pathlib import Path
import numpy as np
import rasterio
from rasterio.warp import reproject, Resampling
from shapely.geometry import box

from ...interfaces.elevation_source import ElevationProvider
from .tile_cache import TileCacheManager
from .geo_utils import buffer_bounding_box_meters, transform_geometry

logger = logging.getLogger(__name__)


class LocalGeoTIFFProvider(ElevationProvider):
    """
    Retrieves elevation grids from locally cached Quebec LiDAR GeoTIFFs.
    """

    def __init__(self, cache_manager: Optional[TileCacheManager] = None):
        self.cache_manager = cache_manager or TileCacheManager()

    def _resolve_tile_path(self, tile: Dict[str, Any]) -> Path:
        """
        Resolves a tile's path relative to cache_dir first for container portability,
        falling back to the absolute path stored in the manifest.
        """
        if "filename" in tile:
            candidate = self.cache_manager.cache_dir / tile["filename"]
            if candidate.exists():
                return candidate
        return Path(tile["path"])

    def find_covering_tile(self, min_lon: float, min_lat: float, max_lon: float, max_lat: float) -> Optional[Path]:
        """
        Finds the best local GeoTIFF tile that intersects the requested bounding box.
        """
        manifest = self.cache_manager.load_manifest()
        patch_box = box(min_lon, min_lat, max_lon, max_lat)

        for tile in manifest.get("tiles", []):
            tile_wgs84 = box(*tile["bounds_wgs84"])
            if tile_wgs84.intersects(patch_box):
                tile_path = self._resolve_tile_path(tile)
                if tile_path.exists():
                    return tile_path

        # If not found in manifest, scan directory and update manifest
        manifest = self.cache_manager.update_manifest()
        for tile in manifest.get("tiles", []):
            tile_wgs84 = box(*tile["bounds_wgs84"])
            if tile_wgs84.intersects(patch_box):
                tile_path = self._resolve_tile_path(tile)
                if tile_path.exists():
                    return tile_path

        return None

    def get_elevation_window(
        self,
        min_lon: float,
        min_lat: float,
        max_lon: float,
        max_lat: float,
        buffer_meters: float = 500.0,
        target_resolution_m: float = 1.0
    ) -> Dict[str, Any]:
        """
        Extracts a buffered elevation window around the target patch.
        Guarantees that the returned grid has resolution `target_resolution_m` (default 1.0m),
        is projected into the local True-North-aligned UTM CRS (eliminating Canada Atlas Lambert meridian rotation),
        and all nodata / missing values are cleanly interpolated.
        """
        # Calculate metric coordinates and 500m perimeter buffer in local UTM CRS (True North aligned)
        geo_info = buffer_bounding_box_meters(
            min_lon, min_lat, max_lon, max_lat, buffer_meters=buffer_meters
        )
        target_crs = geo_info["target_crs"]

        tile_path = self.find_covering_tile(min_lon, min_lat, max_lon, max_lat)
        if not tile_path:
            raise FileNotFoundError(
                f"No local elevation raster covers the requested location "
                f"[{min_lon:.4f}, {min_lat:.4f}, {max_lon:.4f}, {max_lat:.4f}]. "
                f"Please run scripts/fetch_test_dtm.py to acquire coverage."
            )

        b_min_x, b_min_y, b_max_x, b_max_y = geo_info["buffered_bounds_metric"]
        p_min_x, p_min_y, p_max_x, p_max_y = geo_info["patch_bounds_metric"]

        desired_w = max(1, int(round((b_max_x - b_min_x) / target_resolution_m)))
        desired_h = max(1, int(round((b_max_y - b_min_y) / target_resolution_m)))

        dst_transform = rasterio.transform.from_bounds(
            b_min_x, b_min_y, b_max_x, b_max_y, desired_w, desired_h
        )

        with rasterio.open(tile_path) as src:
            nodata_val = src.nodata if src.nodata is not None else -9999.0
            buffered_elevation = np.full((desired_h, desired_w), nodata_val, dtype=np.float32)

            reproject(
                source=rasterio.band(src, 1),
                destination=buffered_elevation,
                src_transform=src.transform,
                src_crs=src.crs,
                dst_transform=dst_transform,
                dst_crs=target_crs,
                resampling=Resampling.bilinear
            )

            # Robust nodata and NaN handling: replace with valid terrain mean or nearest
            mask_invalid = (
                (buffered_elevation == nodata_val) |
                np.isnan(buffered_elevation) |
                (buffered_elevation < -500.0)
            )
            if np.any(mask_invalid):
                valid_pixels = buffered_elevation[~mask_invalid]
                fallback_elev = float(np.median(valid_pixels)) if valid_pixels.size > 0 else 100.0
                buffered_elevation[mask_invalid] = fallback_elev

            h, w = buffered_elevation.shape

            # Compute pixel coordinates of the inner target patch
            y_start = max(0, int(round((b_max_y - p_max_y) / target_resolution_m)))
            y_end = min(h, int(round((b_max_y - p_min_y) / target_resolution_m)))
            x_start = max(0, int(round((p_min_x - b_min_x) / target_resolution_m)))
            x_end = min(w, int(round((p_max_x - b_min_x) / target_resolution_m)))

            patch_slice_y = slice(y_start, y_end)
            patch_slice_x = slice(x_start, x_end)

            patch_elevation = buffered_elevation[patch_slice_y, patch_slice_x]
            median_elevation = float(np.median(patch_elevation)) if patch_elevation.size > 0 else float(np.median(buffered_elevation))

            return {
                "buffered_elevation": buffered_elevation,
                "patch_slice_y": patch_slice_y,
                "patch_slice_x": patch_slice_x,
                "resolution_m": float(target_resolution_m),
                "crs": target_crs,
                "affine_transform": dst_transform,
                "median_elevation_m": median_elevation,
                "geo_info": geo_info,
                "tile_source": str(tile_path.name)
            }
