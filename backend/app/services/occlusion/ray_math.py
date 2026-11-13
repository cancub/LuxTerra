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
    ground_stand_height_m: float = 1.5,
    top_of_canopy: bool = False
) -> np.ndarray:
    """
    Computes the receiver origin altitude z0(r, c) across the target grid.
    
    Physical logic:
      - Rooftop Mode (is_rooftop=True): Solar panels sit directly on building rooftops or atop
        canopy structures at z0 = max(z_dtm, z_dsm).
      - Ground-Mount Mode (is_rooftop=False):
        - PV receiver altitude (top_of_canopy=False): z0 = z_dtm + ground_stand_height_m.
        - Visual top-of-canopy mode (top_of_canopy=True): z0 = max(z_dtm + ground_stand_height_m, z_dsm)
          so shadows are only shown on canopy squares if they fall *on top of* the canopy element.
    """
    if is_rooftop:
        if dsm is not None:
            return np.maximum(dtm, dsm).astype(np.float32)
        return dtm.astype(np.float32)
    else:
        base = (dtm + float(ground_stand_height_m)).astype(np.float32)
        if top_of_canopy and dsm is not None:
            return np.maximum(base, dsm.astype(np.float32))
        return base


def calculate_ray_step(
    solar_azimuth_deg: float,
    solar_elevation_deg: float,
    resolution_m: float = 1.0,
    max_search_radius_m: float = 1000.0
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


def validate_patch_slices(
    elevation_grid: np.ndarray,
    patch_slice_y: slice,
    patch_slice_x: slice
) -> Tuple[int, int, int, int]:
    """
    Validates and clamps patch slices to grid dimensions.
    Returns (patch_H, patch_W, y_offset, x_offset).
    """
    H, W = elevation_grid.shape
    py_start = max(0, patch_slice_y.start)
    py_stop = min(H, patch_slice_y.stop)
    px_start = max(0, patch_slice_x.start)
    px_stop = min(W, patch_slice_x.stop)

    patch_H = max(0, py_stop - py_start)
    patch_W = max(0, px_stop - px_start)

    if patch_H == 0 or patch_W == 0:
        raise ValueError(f"Invalid patch slice: dimensions {patch_H}x{patch_W} within grid of shape {H}x{W}.")

    return patch_H, patch_W, py_start, px_start


REFERENCE_TREE_PATH_M = 5.0


def compute_canopy_step_3d_m(step_dist: float, tan_alpha: float) -> float:
    """
    Computes the 3D ray path length traversed per horizontal ray step,
    clamped at 4x horizontal step for near-zenith angles.
    """
    return float(step_dist) * min(4.0, math.sqrt(1.0 + float(tan_alpha) * float(tan_alpha)))


def compute_canopy_transmittance_grid(
    canopy_path_m: np.ndarray,
    canopy_transmittance: float,
    reference_path_m: float = REFERENCE_TREE_PATH_M
) -> np.ndarray:
    """
    Applies the Beer-Lambert law to cumulative 3D canopy path length (meters):
      T(r, c) = exp(-mu * L(r, c))
    where mu = -ln(tau) / reference_path_m, calibrated so a single reference tree
    of thickness `reference_path_m` (default 5m) transmits `canopy_transmittance`.
    Two 5m trees along a ray yield L = 10m and T = tau^2, matching one 10m tree.
    """
    path = np.asarray(canopy_path_m, dtype=np.float32)
    tau = float(canopy_transmittance)
    if tau >= 1.0:
        return np.ones(path.shape, dtype=np.float32)
    if tau <= 0.0:
        return np.where(path > 0.0, np.float32(0.0), np.float32(1.0)).astype(np.float32)

    mu = np.float32(-math.log(tau) / max(0.5, float(reference_path_m)))
    return np.exp(-mu * np.maximum(path, np.float32(0.0))).astype(np.float32)


def quantize_canopy_shade_levels(
    canopy_path_m: np.ndarray,
    canopy_transmittance: float,
    reference_path_m: float = REFERENCE_TREE_PATH_M
) -> np.ndarray:
    """
    Quantizes stacked canopy shade (1 - T_canopy) into discrete step-function levels:
      - 0: unshaded (T >= 0.99)
      - 1..6: progressively darker green canopy shade steps
      - 7: maximum shade (T < 0.015, effectively blocked by stacked trees)
    """
    t_grid = compute_canopy_transmittance_grid(canopy_path_m, canopy_transmittance, reference_path_m)
    shade = 1.0 - t_grid
    levels = np.zeros(t_grid.shape, dtype=np.uint8)
    # 6 green steps across (0.01, 0.985]
    in_green = (t_grid < 0.99) & (t_grid >= 0.015)
    if np.any(in_green):
        # Map shade in (0.01, 0.985] -> 1..6
        scaled = np.clip(np.ceil((shade[in_green] / 0.985) * 6.0), 1, 6).astype(np.uint8)
        levels[in_green] = scaled
    levels[t_grid < 0.015] = 7
    return levels

