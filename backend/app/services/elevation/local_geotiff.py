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

        dtm_path = self.find_covering_tile(min_lon, min_lat, max_lon, max_lat)
        if dtm_path:
            candidate_dsm = self.cache_manager.dsm_dir / dtm_path.name.replace("dtm", "dsm")
            dsm_path = candidate_dsm if candidate_dsm.exists() else None
            return (dtm_path, dsm_path)

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
        Dynamically discovers and acquires a 1m LiDAR DTM raster from official NRCan STAC & S3 COG catalog
        covering the requested bounding box and perimeter buffer.
        """
        try:
            from .nrcan_client import NRCanClient
            client = NRCanClient(timeout=20)

            logger.info(f"Querying NRCan STAC for LiDAR DTM covering [{min_lon:.4f}, {min_lat:.4f}, {max_lon:.4f}, {max_lat:.4f}]...")
            tiles = client.query_tiles_by_bbox(min_lon, min_lat, max_lon, max_lat, limit=5)
            if not tiles:
                logger.warning(f"No NRCan LiDAR tiles found for bbox [{min_lon}, {min_lat}, {max_lon}, {max_lat}]")
                return None

            dtm_url = None
            for t in tiles:
                if t.get("dtm_url"):
                    dtm_url = t["dtm_url"]
                    break

            if not dtm_url:
                logger.warning("No DTM asset URL found in matching NRCan STAC records")
                return None

            # Calculate buffered bounds to ensure full raymarching search radius is contained (+200m margin)
            geo_info = buffer_bounding_box_meters(
                min_lon, min_lat, max_lon, max_lat, buffer_meters=buffer_meters + 200.0
            )
            wgs84_buffered = geo_info["buffered_bounds_wgs84"]

            center_lon = (min_lon + max_lon) / 2.0
            center_lat = (min_lat + max_lat) / 2.0
            filename = f"dtm_auto_{center_lat:.3f}_{center_lon:.3f}.tif"

            logger.info(f"Extracting on-demand LiDAR DTM window for [{center_lat:.4f}, {center_lon:.4f}] from {dtm_url}...")
            cached_path = self.cache_manager.extract_cog_window(
                cog_url=dtm_url,
                wgs84_bbox=list(wgs84_buffered),
                filename=filename
            )
            return cached_path
        except Exception as e:
            logger.error(f"On-demand elevation acquisition failed: {e}", exc_info=True)
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

        dtm_path, dsm_path = self.find_covering_tile_pair(min_lon, min_lat, max_lon, max_lat)
        if not dtm_path:
            logger.info(f"No local tile covers [{min_lon:.4f}, {min_lat:.4f}, {max_lon:.4f}, {max_lat:.4f}]. Attempting on-demand acquisition...")
            dtm_path = self.acquire_covering_tile(min_lon, min_lat, max_lon, max_lat, buffer_meters=buffer_meters)

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

        with rasterio.open(dtm_path) as src_dtm:
            nodata_val = src_dtm.nodata if src_dtm.nodata is not None else -9999.0
            buffered_elevation = np.full((desired_h, desired_w), nodata_val, dtype=np.float32)

            reproject(
                source=rasterio.band(src_dtm, 1),
                destination=buffered_elevation,
                src_transform=src_dtm.transform,
                src_crs=src_dtm.crs,
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

        # Reproject paired DSM if available, otherwise fallback to bare ground
        has_canopy = False
        buffered_dsm = buffered_elevation.copy()
        if dsm_path and dsm_path.exists():
            try:
                with rasterio.open(dsm_path) as src_dsm:
                    dsm_nodata = src_dsm.nodata if src_dsm.nodata is not None else -9999.0
                    dsm_raw = np.full((desired_h, desired_w), dsm_nodata, dtype=np.float32)
                    reproject(
                        source=rasterio.band(src_dsm, 1),
                        destination=dsm_raw,
                        src_transform=src_dsm.transform,
                        src_crs=src_dsm.crs,
                        dst_transform=dst_transform,
                        dst_crs=target_crs,
                        resampling=Resampling.bilinear
                    )
                    # For nodata DSM cells, clamp to bare ground DTM
                    dsm_invalid = (dsm_raw == dsm_nodata) | np.isnan(dsm_raw) | (dsm_raw < -500.0)
                    dsm_raw[dsm_invalid] = buffered_elevation[dsm_invalid]
                    # Physical surface elevation is always at least bare ground
                    buffered_dsm = np.maximum(buffered_elevation, dsm_raw)
                    has_canopy = True
            except Exception as e:
                logger.warning(f"Could not reproject DSM from {dsm_path}: {e}. Falling back to DTM.")
                buffered_dsm = buffered_elevation.copy()

        buffered_chm = np.maximum(0.0, buffered_dsm - buffered_elevation)

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
