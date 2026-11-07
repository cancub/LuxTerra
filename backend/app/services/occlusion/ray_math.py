"""
Shared ray-marching vector geometry and coordinate conversion utilities.
"""

import math
from typing import Tuple, NamedTuple


class RayStepParameters(NamedTuple):
    step_dc: float
    step_dr: float
    tan_alpha: float
    step_dist: float
    max_steps: int
    is_daylight: bool


def calculate_ray_step(
    solar_azimuth_deg: float,
    solar_elevation_deg: float,
    resolution_m: float = 1.0,
    max_search_radius_m: float = 500.0
) -> RayStepParameters:
    """
    Calculates 2D stepping parameters along the solar azimuth vector towards the sun.
    In raster coordinates:
      - Column index c increases East (sin(azimuth))
      - Row index r increases South (-cos(azimuth))
    """
    if solar_elevation_deg <= 0.0:
        return RayStepParameters(
            step_dc=0.0,
            step_dr=0.0,
            tan_alpha=0.0,
            step_dist=float(resolution_m),
            max_steps=0,
            is_daylight=False
        )

    azimuth_rad = math.radians(solar_azimuth_deg)
    step_dc = math.sin(azimuth_rad) / resolution_m
    step_dr = -math.cos(azimuth_rad) / resolution_m

    tan_alpha = math.tan(math.radians(solar_elevation_deg))
    step_dist = float(resolution_m)
    max_steps = int(math.ceil(max_search_radius_m / resolution_m))

    return RayStepParameters(
        step_dc=float(step_dc),
        step_dr=float(step_dr),
        tan_alpha=float(tan_alpha),
        step_dist=step_dist,
        max_steps=max_steps,
        is_daylight=True
    )
