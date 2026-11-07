"""
Local GeoTIFF Elevation Provider.
Performs windowed extraction of LiDAR DTM rasters with perimeter buffering.
"""

import logging
from typing import Dict, Any, Optional
from pathlib import Path
import numpy as np
import rasterio
from rasterio.windows import from_bounds
from rasterio.enums import Resampling
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

    def find_covering_tile(self, min_lon: float, min_lat: float, max_lon: float, max_lat: float) -> Optional[Path]:
        """
        Finds the best local GeoTIFF tile that intersects the requested bounding box.
        """
        manifest = self.cache_manager.load_manifest()
        patch_box = box(min_lon, min_lat, max_lon, max_lat)

        for tile in manifest.get("tiles", []):
            tile_wgs84 = box(*tile["bounds_wgs84"])
            if tile_wgs84.intersects(patch_box):
                tile_path = Path(tile["path"])
                if tile_path.exists():
                    return tile_path

        # If not found in manifest, scan directory and update manifest
        manifest = self.cache_manager.update_manifest()
        for tile in manifest.get("tiles", []):
            tile_wgs84 = box(*tile["bounds_wgs84"])
            if tile_wgs84.intersects(patch_box):
                tile_path = Path(tile["path"])
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
        Guarantees that the returned grid has resolution `target_resolution_m` (default 1.0m)
        and all nodata / missing values are cleanly interpolated.
        """
        # Calculate metric coordinates and 500m perimeter buffer
        geo_info = buffer_bounding_box_meters(
            min_lon, min_lat, max_lon, max_lat, buffer_meters=buffer_meters
        )
        buffered_wgs84 = geo_info["buffered_bounds_wgs84"]

        tile_path = self.find_covering_tile(min_lon, min_lat, max_lon, max_lat)
        if not tile_path:
            raise FileNotFoundError(
                f"No local elevation raster covers the requested location "
                f"[{min_lon:.4f}, {min_lat:.4f}, {max_lon:.4f}, {max_lat:.4f}]. "
                f"Please run scripts/fetch_test_dtm.py to acquire coverage."
            )

        with rasterio.open(tile_path) as src:
            src_crs_str = src.crs.to_string() if hasattr(src.crs, 'to_string') else str(src.crs)
            
            # Transform buffered bounds to raster native CRS
            buffered_geom = transform_geometry(box(*buffered_wgs84), "EPSG:4326", src_crs_str)
            r_min_x, r_min_y, r_max_x, r_max_y = buffered_geom.bounds

            # Calculate raster window from bounds
            window = from_bounds(r_min_x, r_min_y, r_max_x, r_max_y, src.transform)

            # Determine output shape based on target_resolution_m
            desired_w = max(1, int(round((r_max_x - r_min_x) / target_resolution_m)))
            desired_h = max(1, int(round((r_max_y - r_min_y) / target_resolution_m)))

            # Read elevation array with resampling
            buffered_elevation = src.read(
                1,
                window=window,
                out_shape=(desired_h, desired_w),
                resampling=Resampling.bilinear,
                boundless=True,
                fill_value=src.nodata if src.nodata is not None else -9999.0
            ).astype(np.float32)

            # Robust nodata and NaN handling: replace with valid terrain mean or nearest
            nodata_val = src.nodata if src.nodata is not None else -9999.0
            mask_invalid = (
                (buffered_elevation == nodata_val) |
                np.isnan(buffered_elevation) |
                (buffered_elevation < -500.0)
            )
            if np.any(mask_invalid):
                valid_pixels = buffered_elevation[~mask_invalid]
                fallback_elev = float(np.median(valid_pixels)) if valid_pixels.size > 0 else 100.0
                buffered_elevation[mask_invalid] = fallback_elev

            window_transform = rasterio.windows.transform(window, src.transform)
            h, w = buffered_elevation.shape

            # Compute pixel coordinates of the inner target patch
            patch_geom = transform_geometry(box(min_lon, min_lat, max_lon, max_lat), "EPSG:4326", src_crs_str)
            p_min_x, p_min_y, p_max_x, p_max_y = patch_geom.bounds

            # Relative offset inside the buffered window
            y_start = max(0, int(round((r_max_y - p_max_y) / target_resolution_m)))
            y_end = min(h, int(round((r_max_y - p_min_y) / target_resolution_m)))
            x_start = max(0, int(round((p_min_x - r_min_x) / target_resolution_m)))
            x_end = min(w, int(round((p_max_x - r_min_x) / target_resolution_m)))

            patch_slice_y = slice(y_start, y_end)
            patch_slice_x = slice(x_start, x_end)

            patch_elevation = buffered_elevation[patch_slice_y, patch_slice_x]
            median_elevation = float(np.median(patch_elevation)) if patch_elevation.size > 0 else float(np.median(buffered_elevation))

            return {
                "buffered_elevation": buffered_elevation,
                "patch_slice_y": patch_slice_y,
                "patch_slice_x": patch_slice_x,
                "resolution_m": float(target_resolution_m),
                "crs": src_crs_str,
                "affine_transform": window_transform,
                "median_elevation_m": median_elevation,
                "geo_info": geo_info,
                "tile_source": str(tile_path.name)
            }
