"""
Domain models and validation schemas for LuxTerra solar and occlusion simulation.
"""

from enum import Enum
from typing import Optional, List, Dict, Any
from datetime import datetime
from pydantic import BaseModel, Field, model_validator

from ..services.elevation.geo_utils import normalize_bbox, validate_patch_area


class DeploymentMode(str, Enum):
    ROOFTOP = "rooftop"
    GROUND_MOUNT = "ground_mount"


class GeoBoundingBox(BaseModel):
    """
    WGS84 bounding box with automatic coordinate normalization and 100,000 m² validation.
    """
    min_lon: float = Field(..., description="Western longitude")
    min_lat: float = Field(..., description="Southern latitude")
    max_lon: float = Field(..., description="Eastern longitude")
    max_lat: float = Field(..., description="Northern latitude")

    @model_validator(mode="before")
    @classmethod
    def normalize_and_validate(cls, data: Any) -> Any:
        if isinstance(data, dict):
            min_lon = data.get("min_lon")
            min_lat = data.get("min_lat")
            max_lon = data.get("max_lon")
            max_lat = data.get("max_lat")
            if all(v is not None for v in (min_lon, min_lat, max_lon, max_lat)):
                n_min_lon, n_min_lat, n_max_lon, n_max_lat = normalize_bbox(
                    float(min_lon), float(min_lat), float(max_lon), float(max_lat)
                )
                data["min_lon"] = n_min_lon
                data["min_lat"] = n_min_lat
                data["max_lon"] = n_max_lon
                data["max_lat"] = n_max_lat

                is_valid, area, msg = validate_patch_area(n_min_lon, n_min_lat, n_max_lon, n_max_lat, max_area_m2=250000.0)
                if not is_valid:
                    raise ValueError(msg)
        return data

    @property
    def as_tuple(self):
        return (self.min_lon, self.min_lat, self.max_lon, self.max_lat)


class SolarAngles(BaseModel):
    """
    Solar position and tilt geometry angles in degrees.
    """
    azimuth_deg: float = Field(..., description="Solar azimuth in degrees (180° = True South)")
    elevation_deg: float = Field(..., description="Solar elevation angle above horizon in degrees")
    zenith_deg: float = Field(..., description="Solar zenith angle from vertical in degrees")
    optimal_tilt_deg: float = Field(..., description="Optimal panel tilt matching solar zenith")
    incident_angle_deg: float = Field(..., description="Angle between panel normal and solar ray")


class IrradianceComponents(BaseModel):
    """
    Atmospheric solar radiation components in W/m².
    """
    dni_w_m2: float = Field(..., description="Direct Normal Irradiance")
    dhi_w_m2: float = Field(..., description="Diffuse Horizontal Irradiance")
    poa_direct_w_m2: float = Field(..., description="Plane-of-array unshaded direct beam irradiance")
    poa_diffuse_w_m2: float = Field(..., description="Plane-of-array diffuse sky irradiance")
    poa_global_w_m2: float = Field(..., description="Total unshaded global plane-of-array irradiance")


class PVConfig(BaseModel):
    """
    Configuration parameters for PV system performance and ground coverage.
    """
    deployment_mode: DeploymentMode = Field(default=DeploymentMode.ROOFTOP)
    module_efficiency: float = Field(default=0.20, ge=0.05, le=0.40, description="Module efficiency (default: 20%)")
    system_derate: float = Field(default=0.80, ge=0.40, le=1.00, description="System performance ratio derate (default: 80%)")
    gcr: Optional[float] = Field(default=None, ge=0.10, le=1.00, description="Ground Coverage Ratio override")

    @property
    def effective_gcr(self) -> float:
        """Returns explicitly set GCR or defaults based on deployment mode."""
        if self.gcr is not None:
            return self.gcr
        return 1.0 if self.deployment_mode == DeploymentMode.ROOFTOP else 0.45


class SimulationTimestep(BaseModel):
    """
    Result metrics for a single simulation timestep.
    """
    timestamp: datetime
    solar_angles: SolarAngles
    irradiance: IrradianceComponents
    instantaneous_power_kw: float
    percent_shaded: float
    is_daylight: bool
