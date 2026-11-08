"""
Local GeoTIFF Elevation Provider.
Performs windowed extraction of LiDAR DTM rasters with perimeter buffering.
"""

import logging
from typing import Dict, Any, Optional, Tuple
from pathlib import Path
import numpy as np
import rasterio
from rasterio.warp import reproject, Resampling
from shapely.geometry import box

from ...interfaces.elevation_source import ElevationProvider
from .tile_cache import TileCacheManager
from .geo_utils import buffer_bounding_box_meters, transform_geometry

logger = logging.getLogger(__name__)

# Minimum elevation offset above ground to classify as tree canopy or elevated structure (NRCan standard)
MIN_CANOPY_HEIGHT_METERS = 1.5


def _reproject_raster_to_grid(
    raster_path: Path,
    dst_transform: Any,
    dst_crs: Any,
    desired_h: int,
    desired_w: int,
    floor_grid: Optional[np.ndarray] = None
) -> Tuple[np.ndarray, bool]:
    """
    Reprojects band 1 of a GeoTIFF raster into a target (desired_h, desired_w) metric UTM grid.
    Handles nodata, NaN, and out-of-bounds elevation clamping.
    If floor_grid is provided, clamps output values to be >= floor_grid and fills invalid cells from floor_grid.
    Returns (grid, is_valid).
    """
    if not raster_path.exists():
        if floor_grid is not None:
            return floor_grid.copy(), False
        return np.zeros((desired_h, desired_w), dtype=np.float32), False

    with rasterio.open(raster_path) as src:
        nodata_val = src.nodata if src.nodata is not None else -9999.0
        grid = np.full((desired_h, desired_w), nodata_val, dtype=np.float32)

        reproject(
            source=rasterio.band(src, 1),
            destination=grid,
            src_transform=src.transform,
            src_crs=src.crs,
            dst_transform=dst_transform,
            dst_crs=dst_crs,
            resampling=Resampling.bilinear
        )

        invalid = (grid == nodata_val) | np.isnan(grid) | (grid < -500.0)
        if np.any(invalid):
            if floor_grid is not None:
                grid[invalid] = floor_grid[invalid]
            else:
                valid_pixels = grid[~invalid]
                fallback_elev = float(np.median(valid_pixels)) if valid_pixels.size > 0 else 100.0
                grid[invalid] = fallback_elev

        if floor_grid is not None:
            grid = np.maximum(floor_grid, grid)

        return grid, True


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

    def find_covering_tile_pair(
        self,
        min_lon: float,
        min_lat: float,
        max_lon: float,
        max_lat: float
    ) -> Tuple[Optional[Path], Optional[Path]]:
        """
        Locates the cached DTM and DSM tile pair covering the requested bounding box.
        Returns (dtm_path, dsm_path). If DSM is missing, returns (dtm_path, None).
        """
        dtm_path, dsm_path = self.cache_manager.get_tile_pair(min_lon, min_lat, max_lon, max_lat)
        if dtm_path and dtm_path.exists():
            return (dtm_path, dsm_path)

        patch_box = box(min_lon, min_lat, max_lon, max_lat)
        manifest = self.cache_manager.load_manifest()
        matching_tiles: List[Tuple[Path, Optional[Path]]] = []

        for tile in manifest.get("tiles", []):
            tile_wgs84 = box(*tile["bounds_wgs84"])
            if tile_wgs84.intersects(patch_box):
                tile_path = self._resolve_tile_path(tile)
                if tile_path.exists():
                    candidate_dsm = self.cache_manager.dsm_dir / tile_path.name.replace("dtm", "dsm")
                    dsm_p = candidate_dsm if (candidate_dsm.exists() and candidate_dsm.stat().st_size > 0) else None
                    if dsm_p is not None:
                        return (tile_path, dsm_p)
                    matching_tiles.append((tile_path, dsm_p))

        if matching_tiles:
            return matching_tiles[0]

        return (None, None)

    def find_covering_tile(self, min_lon: float, min_lat: float, max_lon: float, max_lat: float) -> Optional[Path]:
        """
        Finds the best local GeoTIFF tile that intersects the requested bounding box.
        """
        dtm_path, _ = self.find_covering_tile_pair(min_lon, min_lat, max_lon, max_lat)
        return dtm_path

    def acquire_covering_tile_pair(
        self,
        min_lon: float,
        min_lat: float,
        max_lon: float,
        max_lat: float,
        buffer_meters: float = 500.0
    ) -> Tuple[Optional[Path], Optional[Path]]:
        """
        Dynamically discovers and acquires a 1m LiDAR DTM and paired DSM raster from official NRCan STAC & S3 COG catalog
        covering the requested bounding box and perimeter buffer.
        """
        try:
            from .nrcan_client import NRCanClient
            client = NRCanClient(timeout=20)

            logger.info(f"Querying NRCan STAC for LiDAR DTM/DSM covering [{min_lon:.4f}, {min_lat:.4f}, {max_lon:.4f}, {max_lat:.4f}]...")
            tiles = client.query_tiles_by_bbox(min_lon, min_lat, max_lon, max_lat, limit=5)
            if not tiles:
                logger.warning(f"No NRCan LiDAR tiles found for bbox [{min_lon}, {min_lat}, {max_lon}, {max_lat}]")
                return (None, None)

            dtm_url = None
            dsm_url = None
            for t in tiles:
                if t.get("dtm_url"):
                    dtm_url = t["dtm_url"]
                    dsm_url = t.get("dsm_url")
                    break

            if not dtm_url:
                logger.warning("No DTM asset URL found in matching NRCan STAC records")
                return (None, None)

            # Calculate buffered bounds to ensure full raymarching search radius is contained (+200m margin)
            geo_info = buffer_bounding_box_meters(
                min_lon, min_lat, max_lon, max_lat, buffer_meters=buffer_meters + 200.0
            )
            wgs84_buffered = geo_info["buffered_bounds_wgs84"]

            center_lon = (min_lon + max_lon) / 2.0
            center_lat = (min_lat + max_lat) / 2.0
            dtm_filename = f"dtm_auto_{center_lat:.3f}_{center_lon:.3f}.tif"
            dsm_filename = f"dsm_auto_{center_lat:.3f}_{center_lon:.3f}.tif"

            logger.info(f"Extracting on-demand LiDAR DTM window for [{center_lat:.4f}, {center_lon:.4f}] from {dtm_url}...")
            cached_dtm = self.cache_manager.extract_cog_window(
                cog_url=dtm_url,
                wgs84_bbox=list(wgs84_buffered),
                filename=dtm_filename,
                layer="dtm"
            )

            cached_dsm = None
            if dsm_url:
                try:
                    logger.info(f"Extracting on-demand LiDAR DSM window for [{center_lat:.4f}, {center_lon:.4f}] from {dsm_url}...")
                    cached_dsm = self.cache_manager.extract_cog_window(
                        cog_url=dsm_url,
                        wgs84_bbox=list(wgs84_buffered),
                        filename=dsm_filename,
                        layer="dsm"
                    )
                except Exception as e:
                    logger.warning(f"Failed to extract on-demand DSM window ({e}). Proceeding with bare DTM.")

            return (cached_dtm, cached_dsm)
        except Exception as e:
            logger.error(f"On-demand elevation acquisition failed: {e}", exc_info=True)
            return (None, None)

    def acquire_covering_tile(
        self,
        min_lon: float,
        min_lat: float,
        max_lon: float,
        max_lat: float,
        buffer_meters: float = 500.0
    ) -> Optional[Path]:
        """
        Dynamically discovers and acquires a 1m LiDAR DTM raster from official NRCan STAC & S3 COG catalog.
        """
        dtm_path, _ = self.acquire_covering_tile_pair(min_lon, min_lat, max_lon, max_lat, buffer_meters=buffer_meters)
        return dtm_path

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

        dtm_path, dsm_path = self.find_covering_tile_pair(min_lon, min_lat, max_lon, max_lat)
        if not dtm_path or not dsm_path:
            logger.info(
                f"Local elevation coverage incomplete (dtm={dtm_path is not None}, dsm={dsm_path is not None}) "
                f"for [{min_lon:.4f}, {min_lat:.4f}, {max_lon:.4f}, {max_lat:.4f}]. Attempting on-demand acquisition..."
            )
            acq_dtm, acq_dsm = self.acquire_covering_tile_pair(min_lon, min_lat, max_lon, max_lat, buffer_meters=buffer_meters)
            if not dtm_path and acq_dtm:
                dtm_path = acq_dtm
            if not dsm_path and acq_dsm:
                dsm_path = acq_dsm

        if not dtm_path:
            raise FileNotFoundError(
                f"No elevation raster available for the requested location "
                f"[{min_lon:.4f}, {min_lat:.4f}, {max_lon:.4f}, {max_lat:.4f}]. "
                f"Location is outside official NRCan HRDEM LiDAR coverage."
            )

        b_min_x, b_min_y, b_max_x, b_max_y = geo_info["buffered_bounds_metric"]
        p_min_x, p_min_y, p_max_x, p_max_y = geo_info["patch_bounds_metric"]

        desired_w = max(1, int(round((b_max_x - b_min_x) / target_resolution_m)))
        desired_h = max(1, int(round((b_max_y - b_min_y) / target_resolution_m)))

        dst_transform = rasterio.transform.from_bounds(
            b_min_x, b_min_y, b_max_x, b_max_y, desired_w, desired_h
        )

        # 1. Reproject bare-earth DTM
        buffered_elevation, _ = _reproject_raster_to_grid(
            dtm_path, dst_transform, target_crs, desired_h, desired_w
        )

        # 2. Reproject surface DSM (clamped to bare DTM floor)
        buffered_dsm = buffered_elevation.copy()
        has_canopy = False
        if dsm_path and dsm_path.exists():
            try:
                buffered_dsm, success = _reproject_raster_to_grid(
                    dsm_path, dst_transform, target_crs, desired_h, desired_w, floor_grid=buffered_elevation
                )
                has_canopy = success
            except Exception as e:
                logger.warning(f"Could not reproject DSM from {dsm_path}: {e}. Falling back to DTM.")
                buffered_dsm = buffered_elevation.copy()

        # 3. Compute Canopy Height Model (CHM)
        raw_chm = buffered_dsm - buffered_elevation
        # Filter low noise below 1.5m as bare ground per plan_canopy.md
        buffered_chm = np.where(raw_chm >= MIN_CANOPY_HEIGHT_METERS, raw_chm, 0.0).astype(np.float32)

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
            "dtm": buffered_elevation,
            "dsm": buffered_dsm,
            "chm": buffered_chm,
            "has_canopy": has_canopy,
            "patch_slice_y": patch_slice_y,
            "patch_slice_x": patch_slice_x,
            "resolution_m": float(target_resolution_m),
            "crs": target_crs,
            "affine_transform": dst_transform,
            "median_elevation_m": median_elevation,
            "geo_info": geo_info,
            "tile_source": str(dtm_path.name),
            "dsm_tile_source": str(dsm_path.name) if dsm_path else None
        }
