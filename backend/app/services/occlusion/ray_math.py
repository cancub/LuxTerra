"""
Shared ray-marching vector geometry and coordinate conversion utilities.
"""

import math
from typing import Tuple, NamedTuple, Optional
import numpy as np


class RayStepParameters(NamedTuple):
    step_dc: float
    step_dr: float
    tan_alpha: float
    step_dist: float
    max_steps: int
    is_daylight: bool


def compute_receiver_altitude_grid(
    dtm: np.ndarray,
    dsm: Optional[np.ndarray] = None,
    is_rooftop: bool = True,
    ground_stand_height_m: float = 1.5
) -> np.ndarray:
    """
    Computes the receiver origin altitude z0(r, c) across the target grid.
    
    Physical logic:
      - Rooftop Mode (is_rooftop=True): Solar panels sit directly on building rooftops or atop
        canopy structures at z0 = z_dsm. The building surface itself does not self-shadow the panels,
        but taller overhanging trees or adjacent elevated buildings will cast shadows if the solar ray
        intersects them. If DSM is not provided, defaults to bare DTM.
      - Ground-Mount Mode (is_rooftop=False): Solar panels sit on ground racking elevated by
        ground_stand_height_m (default 1.5m) above bare earth: z0 = z_dtm + 1.5m.
        Any nearby tree, canopy grove, or building taller than 1.5m above ground will cast shade.
    """
    if is_rooftop:
        if dsm is not None:
            # Panels sit on top of surface structures/roofs (z_dsm >= z_dtm)
            return np.maximum(dtm, dsm).astype(np.float32)
        return dtm.astype(np.float32)
    else:
        # Panels sit on ground racking 1.5m above bare earth
        return (dtm + float(ground_stand_height_m)).astype(np.float32)


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
