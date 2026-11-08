"""
Pydantic schemas for the simulation request and response payloads.
"""

from typing import List, Optional
from datetime import date
from pydantic import BaseModel, Field, field_validator, model_validator

from .domain import GeoBoundingBox, DeploymentMode
from ..services.elevation.geo_utils import calculate_bbox_area_meters, calculate_polygon_area_meters


class SimulateRequest(BaseModel):
    """
    Request payload for POST /api/simulate.
    Supports both axis-aligned bounding boxes and arbitrary oblong/irregular polygons.
    """
    bbox: GeoBoundingBox = Field(..., description="Target patch bounding box in WGS84")
    polygon: Optional[List[List[float]]] = Field(
        default=None,
        description="Optional closed polygon coordinates [[lon, lat], ...] defining exact oblong/irregular boundary within bbox"
    )
    date: str = Field(..., description="Simulation date in YYYY-MM-DD format (e.g. 2026-06-21)")
    time_step_minutes: int = Field(default=1, ge=1, le=60, description="Interval in minutes between frames")
    deployment_mode: DeploymentMode = Field(default=DeploymentMode.ROOFTOP, description="rooftop (100% GCR) or ground_mount (45% GCR)")
    module_efficiency: Optional[float] = Field(default=None, ge=0.05, le=0.40, description="Solar module efficiency override (e.g. 0.20)")
    system_derate: Optional[float] = Field(default=None, ge=0.40, le=1.00, description="System performance ratio derate override (e.g. 0.80)")
    gcr: Optional[float] = Field(default=None, ge=0.10, le=1.00, description="Ground Coverage Ratio override (0.1 to 1.0)")
    buffer_meters: float = Field(default=500.0, ge=100.0, le=2000.0, description="Outward shadow search perimeter buffer")
    resolution_m: float = Field(default=1.0, ge=0.5, le=10.0, description="Simulation grid resolution in meters")
    include_tree_canopy: bool = Field(default=True, description="Enable vegetative tree canopy and structure ray-marching")
    canopy_mode: str = Field(default="seasonal", description="Canopy phenology mode: 'seasonal', 'leaf_on', 'leaf_off', 'bare_terrain'")

    @field_validator("date")
    @classmethod
    def validate_date(cls, v: str) -> str:
        try:
            date.fromisoformat(v)
            return v
        except ValueError:
            raise ValueError(f"Invalid date format '{v}'. Expected YYYY-MM-DD.")

    @model_validator(mode="after")
    def validate_simulation_area(self) -> "SimulateRequest":
        if self.polygon and len(self.polygon) >= 3:
            poly_area = calculate_polygon_area_meters(self.polygon)
            if poly_area > 100000.0:
                raise ValueError(
                    f"Selected polygon area ({poly_area:,.1f} m²) exceeds the maximum allowable limit of 100,000 m²."
                )
        else:
            bbox = self.bbox
            area = calculate_bbox_area_meters(bbox.min_lon, bbox.min_lat, bbox.max_lon, bbox.max_lat)
            if area > 100000.0:
                raise ValueError(
                    f"Selected area ({area:,.1f} m²) exceeds the maximum allowable limit of 100,000 m²."
                )
        return self


class SimulateMetadata(BaseModel):
    """
    Spatial and simulation context metadata.
    """
    patch_width_m: float
    patch_height_m: float
    patch_area_m2: float
    patch_bounds_wgs84: List[float] = Field(..., description="[min_lon, min_lat, max_lon, max_lat] for map canvas projection")
    grid_rows: int
    grid_cols: int
    median_elevation_m: float
    crs: str
    tile_source: str
    dsm_tile_source: Optional[str] = None
    has_canopy_data: bool = False
    include_tree_canopy: bool = True
    canopy_mode: str = "seasonal"
    date: str
    time_step_minutes: int
    buffer_meters: float
    resolution_m: float
    deployment_mode: str
    effective_gcr: float
    module_efficiency: float
    system_derate: float


class DailySummary(BaseModel):
    """
    Aggregated energy metrics across the full 24-hour cycle.
    """
    total_daily_kwh: float = Field(..., description="Total cumulative usable AC electrical energy in kWh")
    unshaded_daily_kwh: float = Field(default=0.0, description="Total clear-sky unshaded electrical energy in kWh")
    canopy_loss_kwh: float = Field(default=0.0, description="Total cumulative energy lost to tree canopy shading in kWh")
    canopy_loss_pct: float = Field(default=0.0, description="Percentage of potential energy lost to tree canopy")
    peak_power_kw: float = Field(..., description="Maximum instantaneous power achieved in kW")
    unshaded_peak_kw: float = Field(default=0.0, description="Maximum potential instantaneous power achieved in kW")
    peak_time: Optional[str] = Field(None, description="Timestamp of peak generation")
    sunrise_time: Optional[str] = Field(None, description="Sunrise timestamp")
    sunset_time: Optional[str] = Field(None, description="Sunset timestamp")
    daylight_hours: float = Field(..., description="Total hours of daylight")
    avg_shaded_pct: float = Field(..., description="Average percentage of patch shaded during daylight")
    avg_canopy_shaded_pct: float = Field(default=0.0, description="Average percentage of patch shaded by canopy during daylight")


class TimestepMetric(BaseModel):
    """
    Simulation metrics for a single time frame.
    """
    timestamp: str = Field(..., description="ISO 8601 timestamp")
    solar_azimuth_deg: float
    solar_elevation_deg: float
    power_kw: float
    unshaded_power_kw: float = Field(default=0.0, description="Clear-sky unshaded power in kW without terrain or canopy shadows")
    canopy_loss_kw: float = Field(default=0.0, description="Power lost specifically to vegetative tree canopy shade in kW")
    percent_shaded: float
    canopy_shaded_pct: float = Field(default=0.0, description="Percentage of patch shaded by tree canopy")
    is_daylight: bool
    mask_index: Optional[int] = Field(None, description="Index in masks list if daylight, null if night")


class SimulateResponse(BaseModel):
    """
    Complete response payload for full-day simulation.
    """
    metadata: SimulateMetadata
    daily_summary: DailySummary
    timeseries: List[TimestepMetric]
    mask_encoding: str = Field(default="bitmask_base64", description="Encoding format for 2D shadow masks")
    masks: List[str] = Field(default_factory=list, description="Base64 encoded bit-packed binary masks for daytime frames (terrain)")
    canopy_masks: List[str] = Field(default_factory=list, description="Base64 encoded bit-packed binary masks for daytime frames (canopy)")
    canopy_transmittance: float = Field(default=0.15, description="Fractional direct beam canopy transmittance")
    night_mask: Optional[str] = Field(default=None, description="Base64 bitmask for nighttime frames (shaded inside shape, transparent outside)")
    night_canopy_mask: Optional[str] = Field(default=None, description="Base64 bitmask for nighttime frames for canopy layer")
