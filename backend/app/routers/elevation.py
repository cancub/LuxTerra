"""
FastAPI router for elevation metadata, cached tiles, and Quebec test location presets.
"""

from fastapi import APIRouter, Depends
from typing import List

from ..schemas.elevation import (
    LocationPreset,
    ElevationLocationsResponse,
    ElevationManifestResponse,
    ElevationStatusResponse,
    ElevationTileInfo
)
from ..constants import TEST_LOCATION_PRESETS
from ..services.elevation.tile_cache import TileCacheManager
from ..dependencies import get_tile_cache_manager

router = APIRouter(prefix="/api/elevation", tags=["Elevation"])


def _build_location_presets(cache_manager: TileCacheManager) -> List[LocationPreset]:
    locations: List[LocationPreset] = []
    for key, p in TEST_LOCATION_PRESETS.items():
        is_cached = cache_manager.is_tile_cached(p["filename"])
        locations.append(
            LocationPreset(
                id=key,
                name=p["name"],
                center_lon=p["center_lon"],
                center_lat=p["center_lat"],
                bbox=p["bbox"],
                utm_crs=p["utm_crs"],
                elevation_base_m=p["elevation_base"],
                description=p.get("description", ""),
                is_cached=is_cached
            )
        )
    return locations


@router.get(
    "/locations",
    response_model=ElevationLocationsResponse,
    summary="List Quebec Test Location Presets",
    description="Returns preloaded benchmark test locations with coordinates and caching status."
)
def get_locations(cache_manager: TileCacheManager = Depends(get_tile_cache_manager)) -> ElevationLocationsResponse:
    """
    Returns verified Quebec test locations with caching status.
    """
    return ElevationLocationsResponse(locations=_build_location_presets(cache_manager))


@router.get(
    "/manifest",
    response_model=ElevationManifestResponse,
    summary="List Cached Elevation Tiles",
    description="Returns metadata of all locally cached LiDAR GeoTIFF rasters."
)
def get_manifest(cache_manager: TileCacheManager = Depends(get_tile_cache_manager)) -> ElevationManifestResponse:
    """
    Returns spatial metadata for all locally cached GeoTIFF tiles.
    """
    manifest_data = cache_manager.load_manifest()
    tiles = [ElevationTileInfo(**tile) for tile in manifest_data.get("tiles", [])]
    return ElevationManifestResponse(tiles=tiles)


@router.get(
    "/status",
    response_model=ElevationStatusResponse,
    summary="Elevation Pipeline & Cache Status",
    description="Returns overall elevation tile cache status, benchmark locations, and manifest summary."
)
def get_status(cache_manager: TileCacheManager = Depends(get_tile_cache_manager)) -> ElevationStatusResponse:
    """
    Returns comprehensive elevation status as specified in the architecture blueprint.
    """
    manifest_data = cache_manager.load_manifest()
    tiles = [ElevationTileInfo(**tile) for tile in manifest_data.get("tiles", [])]
    locations = _build_location_presets(cache_manager)
    return ElevationStatusResponse(
        status="ready" if len(tiles) > 0 else "empty",
        cached_tile_count=len(tiles),
        locations=locations,
        tiles=tiles
    )
