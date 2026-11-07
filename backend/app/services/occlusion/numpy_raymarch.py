"""
Vectorized CPU Ray-Marcher using NumPy.
Provides a robust fallback if CUDA or CuPy is unavailable.
"""

import math
import numpy as np

from ...interfaces.occlusion_engine import OcclusionEngine


class NumPyOcclusionEngine(OcclusionEngine):
    """
    CPU-based ray-marcher using vectorized NumPy operations.
    """

    def compute_shadow_mask(
        self,
        elevation_grid: np.ndarray,
        patch_slice_y: slice,
        patch_slice_x: slice,
        solar_azimuth_deg: float,
        solar_elevation_deg: float,
        resolution_m: float = 1.0,
        max_search_radius_m: float = 500.0
    ) -> np.ndarray:
        """
        Computes binary shadow mask using vectorized CPU NumPy stepping.
        """
        patch_H = patch_slice_y.stop - patch_slice_y.start
        patch_W = patch_slice_x.stop - patch_slice_x.start

        if solar_elevation_deg <= 0.0:
            return np.zeros((patch_H, patch_W), dtype=np.uint8)

        H, W = elevation_grid.shape
        patch_y_offset = patch_slice_y.start
        patch_x_offset = patch_slice_x.start

        # Ray direction towards the sun
        azimuth_rad = math.radians(solar_azimuth_deg)
        step_dc = math.sin(azimuth_rad) / resolution_m
        step_dr = -math.cos(azimuth_rad) / resolution_m

        tan_alpha = math.tan(math.radians(solar_elevation_deg))
        step_dist = float(resolution_m)
        max_steps = int(math.ceil(max_search_radius_m / resolution_m))

        # Coordinate grids for the target patch
        py_indices, px_indices = np.indices((patch_H, patch_W))
        r0 = py_indices + patch_y_offset
        c0 = px_indices + patch_x_offset
        z0 = elevation_grid[r0, c0]

        # 1 = unshaded, 0 = shaded
        unshaded_mask = np.ones((patch_H, patch_W), dtype=bool)

        # Step along rays
        for s in range(1, max_steps + 1):
            if not np.any(unshaded_mask):
                break # All cells already shaded

            r_f = r0 + (s * step_dr)
            c_f = c0 + (s * step_dc)

            r = np.rint(r_f).astype(np.int32)
            c = np.rint(c_f).astype(np.int32)

            in_bounds = (r >= 0) & (r < H) & (c >= 0) & (c < W) & unshaded_mask

            if not np.any(in_bounds):
                continue

            z_ray = z0[in_bounds] + (s * step_dist * tan_alpha)
            z_terrain = elevation_grid[r[in_bounds], c[in_bounds]]

            occluded = z_terrain > z_ray
            if np.any(occluded):
                # Update cells that hit an obstacle
                active_r = py_indices[in_bounds]
                active_c = px_indices[in_bounds]
                unshaded_mask[active_r[occluded], active_c[occluded]] = False

        return unshaded_mask.astype(np.uint8)
