"""
Vectorized CPU Ray-Marcher using NumPy.
Provides a robust fallback if CUDA or CuPy is unavailable.
"""

from typing import List, Tuple
import numpy as np

from ...interfaces.occlusion_engine import OcclusionEngine
from .ray_math import calculate_ray_step


class NumPyOcclusionEngine(OcclusionEngine):
    """
    CPU-based ray-marcher using vectorized NumPy operations.
    """

    def _validate_slices(self, elevation_grid: np.ndarray, patch_slice_y: slice, patch_slice_x: slice) -> Tuple[int, int, int, int]:
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
        patch_H, patch_W, y_offset, x_offset = self._validate_slices(elevation_grid, patch_slice_y, patch_slice_x)
        ray_params = calculate_ray_step(solar_azimuth_deg, solar_elevation_deg, resolution_m, max_search_radius_m)

        if not ray_params.is_daylight:
            return np.zeros((patch_H, patch_W), dtype=np.uint8)

        H, W = elevation_grid.shape

        # Coordinate grids for the target patch
        py_indices, px_indices = np.indices((patch_H, patch_W))
        r0 = py_indices + y_offset
        c0 = px_indices + x_offset
        z0 = elevation_grid[r0, c0]

        unshaded_mask = np.ones((patch_H, patch_W), dtype=bool)

        r0_f = r0.astype(np.float32)
        c0_f = c0.astype(np.float32)
        s_dr = np.float32(ray_params.step_dr)
        s_dc = np.float32(ray_params.step_dc)
        t_alpha = np.float32(ray_params.tan_alpha)
        s_dist = np.float32(ray_params.step_dist)

        for s in range(1, ray_params.max_steps + 1):
            if not np.any(unshaded_mask):
                break

            r_f = r0_f + (np.float32(s) * s_dr)
            c_f = c0_f + (np.float32(s) * s_dc)

            in_bounds = (r_f >= 0.0) & (r_f < float(H - 1)) & (c_f >= 0.0) & (c_f < float(W - 1)) & unshaded_mask

            if not np.any(in_bounds):
                continue

            rf_ib = r_f[in_bounds]
            cf_ib = c_f[in_bounds]

            r0_i = np.floor(rf_ib).astype(np.int32)
            c0_i = np.floor(cf_ib).astype(np.int32)
            r1_i = r0_i + 1
            c1_i = c0_i + 1

            dr = rf_ib - r0_i.astype(np.float32)
            dc = cf_ib - c0_i.astype(np.float32)

            z00 = elevation_grid[r0_i, c0_i]
            z01 = elevation_grid[r0_i, c1_i]
            z10 = elevation_grid[r1_i, c0_i]
            z11 = elevation_grid[r1_i, c1_i]

            z_top = (1.0 - dc) * z00 + dc * z01
            z_bottom = (1.0 - dc) * z10 + dc * z11
            z_terrain = (1.0 - dr) * z_top + dr * z_bottom

            z_ray = z0[in_bounds] + (np.float32(s) * s_dist * t_alpha)

            occluded = z_terrain > z_ray
            if np.any(occluded):
                active_r = py_indices[in_bounds]
                active_c = px_indices[in_bounds]
                unshaded_mask[active_r[occluded], active_c[occluded]] = False

        return unshaded_mask.astype(np.uint8)

    def compute_shadow_masks_batch(
        self,
        elevation_grid: np.ndarray,
        patch_slice_y: slice,
        patch_slice_x: slice,
        sun_angles: List[Tuple[float, float]],
        resolution_m: float = 1.0,
        max_search_radius_m: float = 500.0
    ) -> List[np.ndarray]:
        """
        Batch-computes shadow masks across multiple sun angles on CPU.
        """
        return [
            self.compute_shadow_mask(
                elevation_grid, patch_slice_y, patch_slice_x, az, el, resolution_m, max_search_radius_m
            )
            for az, el in sun_angles
        ]
