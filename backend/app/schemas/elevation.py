"""
Pydantic schemas for elevation metadata and location presets.
"""

from typing import List, Optional
from pydantic import BaseModel, Field


class LocationPreset(BaseModel):
    """
    Metadata for preloaded benchmark/test locations in Quebec.
    """
    id: str
    name: str
    center_lon: float
    center_lat: float
    bbox: List[float] = Field(..., description="[min_lon, min_lat, max_lon, max_lat]")
    utm_crs: str
    elevation_base_m: float
    description: str
    is_cached: bool


class ElevationLocationsResponse(BaseModel):
    """
    Response schema for GET /api/elevation/locations.
    """
    locations: List[LocationPreset]


class ElevationTileInfo(BaseModel):
    """
    Metadata for locally cached DTM GeoTIFF tiles.
    """
    filename: str
    path: str
    crs: str
    width: int
    height: int
    resolution: List[float]
    bounds_native: List[float]
    bounds_wgs84: List[float]
    nodata: Optional[float]
    filesize_bytes: int


class ElevationManifestResponse(BaseModel):
    """
    Response schema for GET /api/elevation/manifest.
    """
    tiles: List[ElevationTileInfo]


class ElevationStatusResponse(BaseModel):
    """
    Response schema for GET /api/elevation/status.
    """
    status: str = "ready"
    cached_tile_count: int
    locations: List[LocationPreset]
    tiles: List[ElevationTileInfo]
