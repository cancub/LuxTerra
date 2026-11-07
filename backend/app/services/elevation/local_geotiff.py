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
import pyproj
from shapely.geometry import box
from shapely.ops import transform

from ...interfaces.elevation_source import ElevationProvider
from .tile_cache import TileCacheManager
from .geo_utils import buffer_bounding_box_meters

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

        # If not found in manifest, check any .tif in directory directly
        for tif in self.cache_manager.cache_dir.glob("*.tif"):
            try:
                with rasterio.open(tif) as src:
                    transformer = pyproj.Transformer.from_crs(src.crs, "EPSG:4326", always_xy=True).transform
                    wgs84_bounds = transform(transformer, box(*src.bounds)).bounds
                    if box(*wgs84_bounds).intersects(patch_box):
                        return tif
            except Exception:
                continue

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
                f"Please run scripts/fetch_test_dtm.py to download coverage."
            )

        with rasterio.open(tile_path) as src:
            # Transform buffered bounds to raster native CRS
            to_raster_crs = pyproj.Transformer.from_crs("EPSG:4326", src.crs, always_xy=True).transform
            buffered_geom = transform(to_raster_crs, box(*buffered_wgs84))
            r_min_x, r_min_y, r_max_x, r_max_y = buffered_geom.bounds

            # Calculate raster window from bounds
            window = from_bounds(r_min_x, r_min_y, r_max_x, r_max_y, src.transform)

            # Read elevation array
            buffered_elevation = src.read(
                1,
                window=window,
                resampling=Resampling.bilinear,
                boundless=True,
                fill_value=src.nodata if src.nodata is not None else 0.0
            ).astype(np.float32)

            # Clean any nodata or invalid values
            if src.nodata is not None:
                mask_nodata = (buffered_elevation == src.nodata) | np.isnan(buffered_elevation)
                if np.any(mask_nodata):
                    valid_mean = float(np.mean(buffered_elevation[~mask_nodata])) if np.any(~mask_nodata) else 100.0
                    buffered_elevation[mask_nodata] = valid_mean

            window_transform = rasterio.windows.transform(window, src.transform)
            h, w = buffered_elevation.shape

            # Compute pixel coordinates of the inner target patch
            patch_geom = transform(to_raster_crs, box(min_lon, min_lat, max_lon, max_lat))
            p_min_x, p_min_y, p_max_x, p_max_y = patch_geom.bounds

            # Relative offset inside the buffered window
            y_res = abs(src.res[1])
            x_res = abs(src.res[0])
            
            # Row 0 is at maximum Y (top) in standard raster grids
            y_start = max(0, int(round((r_max_y - p_max_y) / y_res)))
            y_end = min(h, int(round((r_max_y - p_min_y) / y_res)))
            x_start = max(0, int(round((p_min_x - r_min_x) / x_res)))
            x_end = min(w, int(round((p_max_x - r_min_x) / x_res)))

            patch_slice_y = slice(y_start, y_end)
            patch_slice_x = slice(x_start, x_end)

            patch_elevation = buffered_elevation[patch_slice_y, patch_slice_x]
            median_elevation = float(np.median(patch_elevation)) if patch_elevation.size > 0 else float(np.median(buffered_elevation))

            return {
                "buffered_elevation": buffered_elevation,
                "patch_slice_y": patch_slice_y,
                "patch_slice_x": patch_slice_x,
                "resolution_m": float(x_res),
                "crs": str(src.crs),
                "affine_transform": window_transform,
                "median_elevation_m": median_elevation,
                "geo_info": geo_info,
                "tile_source": str(tile_path.name)
            }
