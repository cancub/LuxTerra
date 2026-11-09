"""
Vectorized CPU Ray-Marcher using NumPy.
Provides a robust fallback if CUDA or CuPy is unavailable.
"""

from typing import List, Tuple
import numpy as np

from ...interfaces.occlusion_engine import OcclusionEngine
from .ray_math import calculate_ray_step, compute_receiver_altitude_grid, validate_patch_slices


class NumPyOcclusionEngine(OcclusionEngine):
    """
    CPU-based ray-marcher using vectorized NumPy operations.
    """

    def _validate_slices(self, elevation_grid: np.ndarray, patch_slice_y: slice, patch_slice_x: slice) -> Tuple[int, int, int, int]:
        return validate_patch_slices(elevation_grid, patch_slice_y, patch_slice_x)

    def compute_shadow_mask(
        self,
        elevation_grid: np.ndarray,
        patch_slice_y: slice,
        patch_slice_x: slice,
        solar_azimuth_deg: float,
        solar_elevation_deg: float,
        resolution_m: float = 1.0,
        max_search_radius_m: float = 1000.0
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
        max_search_radius_m: float = 1000.0
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

    def compute_dual_shadow_mask(
        self,
        dtm_grid: np.ndarray,
        dsm_grid: np.ndarray,
        patch_slice_y: slice,
        patch_slice_x: slice,
        solar_azimuth_deg: float,
        solar_elevation_deg: float,
        resolution_m: float = 1.0,
        max_search_radius_m: float = 1000.0,
        is_rooftop: bool = True,
        ground_stand_height_m: float = 1.5,
        include_tree_canopy: bool = True
    ) -> Tuple[np.ndarray, np.ndarray]:
        """
        Computes dual binary shadow masks (terrain_mask, canopy_mask) on CPU.
        """
        patch_H, patch_W, y_offset, x_offset = self._validate_slices(dtm_grid, patch_slice_y, patch_slice_x)
        ray_params = calculate_ray_step(solar_azimuth_deg, solar_elevation_deg, resolution_m, max_search_radius_m)

        if not ray_params.is_daylight:
            zeros = np.zeros((patch_H, patch_W), dtype=np.uint8)
            return zeros, zeros.copy()

        H, W = dtm_grid.shape

        py_indices, px_indices = np.indices((patch_H, patch_W))
        r0 = py_indices + y_offset
        c0 = px_indices + x_offset

        z_dtm_0 = dtm_grid[r0, c0]
        z_dsm_0 = dsm_grid[r0, c0]
        z0 = compute_receiver_altitude_grid(
            z_dtm_0, z_dsm_0, is_rooftop=is_rooftop, ground_stand_height_m=ground_stand_height_m
        )

        terrain_unshaded = np.ones((patch_H, patch_W), dtype=bool)
        canopy_unshaded = np.ones((patch_H, patch_W), dtype=bool)

        r0_f = r0.astype(np.float32)
        c0_f = c0.astype(np.float32)
        s_dr = np.float32(ray_params.step_dr)
        s_dc = np.float32(ray_params.step_dc)
        t_alpha = np.float32(ray_params.tan_alpha)
        s_dist = np.float32(ray_params.step_dist)

        for s in range(1, ray_params.max_steps + 1):
            if not np.any(terrain_unshaded):
                break

            r_f = r0_f + (np.float32(s) * s_dr)
            c_f = c0_f + (np.float32(s) * s_dc)

            in_bounds = (r_f >= 0.0) & (r_f < float(H - 1)) & (c_f >= 0.0) & (c_f < float(W - 1)) & terrain_unshaded

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

            # Bilinear DTM
            z_dtm_00 = dtm_grid[r0_i, c0_i]
            z_dtm_01 = dtm_grid[r0_i, c1_i]
            z_dtm_10 = dtm_grid[r1_i, c0_i]
            z_dtm_11 = dtm_grid[r1_i, c1_i]
            z_dtm_top = (1.0 - dc) * z_dtm_00 + dc * z_dtm_01
            z_dtm_bot = (1.0 - dc) * z_dtm_10 + dc * z_dtm_11
            z_dtm_sampled = (1.0 - dr) * z_dtm_top + dr * z_dtm_bot

            z_ray = z0[in_bounds] + (np.float32(s) * s_dist * t_alpha)

            active_r = py_indices[in_bounds]
            active_c = px_indices[in_bounds]

            # 1. Terrain block
            terrain_occluded = z_dtm_sampled > z_ray
            if np.any(terrain_occluded):
                tr = active_r[terrain_occluded]
                tc = active_c[terrain_occluded]
                terrain_unshaded[tr, tc] = False
                canopy_unshaded[tr, tc] = False

            # 2. Canopy block (for rays not blocked by terrain)
            if include_tree_canopy:
                # Bilinear DSM
                z_dsm_00 = dsm_grid[r0_i, c0_i]
                z_dsm_01 = dsm_grid[r0_i, c1_i]
                z_dsm_10 = dsm_grid[r1_i, c0_i]
                z_dsm_11 = dsm_grid[r1_i, c1_i]
                z_dsm_top = (1.0 - dc) * z_dsm_00 + dc * z_dsm_01
                z_dsm_bot = (1.0 - dc) * z_dsm_10 + dc * z_dsm_11
                z_dsm_sampled = np.maximum(z_dtm_sampled, (1.0 - dr) * z_dsm_top + dr * z_dsm_bot)

                canopy_occluded = (~terrain_occluded) & (z_dsm_sampled > z_ray)
                if np.any(canopy_occluded):
                    cr = active_r[canopy_occluded]
                    cc = active_c[canopy_occluded]
                    canopy_unshaded[cr, cc] = False

        return terrain_unshaded.astype(np.uint8), canopy_unshaded.astype(np.uint8)

    def compute_dual_shadow_masks_batch(
        self,
        dtm_grid: np.ndarray,
        dsm_grid: np.ndarray,
        patch_slice_y: slice,
        patch_slice_x: slice,
        sun_angles: List[Tuple[float, float]],
        resolution_m: float = 1.0,
        max_search_radius_m: float = 1000.0,
        is_rooftop: bool = True,
        ground_stand_height_m: float = 1.5,
        include_tree_canopy: bool = True
    ) -> Tuple[List[np.ndarray], List[np.ndarray]]:
        terrain_list = []
        canopy_list = []
        for az, el in sun_angles:
            t_m, c_m = self.compute_dual_shadow_mask(
                dtm_grid, dsm_grid, patch_slice_y, patch_slice_x,
                az, el, resolution_m, max_search_radius_m,
                is_rooftop, ground_stand_height_m, include_tree_canopy
            )
            terrain_list.append(t_m)
            canopy_list.append(c_m)
        return terrain_list, canopy_list

    def compute_sky_view_factor(
        self,
        dtm_grid: np.ndarray,
        dsm_grid: np.ndarray,
        patch_slice_y: slice,
        patch_slice_x: slice,
        resolution_m: float = 1.0,
        max_search_radius_m: float = 500.0,
        num_azimuths: int = 32,
        is_rooftop: bool = False,
        ground_stand_height_m: float = 1.5,
        include_tree_canopy: bool = True,
        canopy_transmittance: float = 0.15
    ) -> np.ndarray:
        """
        Computes a 2D Sky View Factor (SVF) map in [0.05, 1.0] across the patch on CPU.
        Integrates horizon elevation angles across `num_azimuths` directions around 360 degrees.
        """
        patch_H, patch_W, y_offset, x_offset = self._validate_slices(dtm_grid, patch_slice_y, patch_slice_x)
        H, W = dtm_grid.shape
        max_steps = max(2, int(np.ceil(max_search_radius_m / max(0.1, resolution_m))))
        n_az = max(4, int(num_azimuths))

        py_indices, px_indices = np.indices((patch_H, patch_W))
        r0 = py_indices + y_offset
        c0 = px_indices + x_offset

        z_dtm_0 = dtm_grid[r0, c0].astype(np.float32)
        z_dsm_0 = np.maximum(z_dtm_0, dsm_grid[r0, c0].astype(np.float32))

        if is_rooftop and include_tree_canopy:
            z0 = z_dsm_0 + np.float32(0.5)
        else:
            z0 = z_dtm_0 + np.float32(ground_stand_height_m)

        overhead_tan = np.zeros((patch_H, patch_W), dtype=np.float32)
        if include_tree_canopy and not is_rooftop:
            overhead_mask = z_dsm_0 > (z0 + np.float32(0.5))
            overhead_tan[overhead_mask] = (z_dsm_0 - z0)[overhead_mask]

        r0_f = r0.astype(np.float32)
        c0_f = c0.astype(np.float32)
        svf_sum = np.zeros((patch_H, patch_W), dtype=np.float32)

        for a in range(n_az):
            phi = (2.0 * np.pi * float(a)) / float(n_az)
            step_dr = np.float32(-np.cos(phi))
            step_dc = np.float32(np.sin(phi))

            max_tan_dtm = np.zeros((patch_H, patch_W), dtype=np.float32)
            max_tan_dsm = overhead_tan.copy()

            for s in range(2, max_steps + 1):
                r_f = r0_f + np.float32(s) * step_dr
                c_f = c0_f + np.float32(s) * step_dc

                in_bounds = (r_f >= 0.0) & (r_f < float(H - 1)) & (c_f >= 0.0) & (c_f < float(W - 1))
                if not np.any(in_bounds):
                    break

                rf_ib = r_f[in_bounds]
                cf_ib = c_f[in_bounds]

                r0_i = np.floor(rf_ib).astype(np.int32)
                c0_i = np.floor(cf_ib).astype(np.int32)
                r1_i = r0_i + 1
                c1_i = c0_i + 1

                dr = rf_ib - r0_i.astype(np.float32)
                dc = cf_ib - c0_i.astype(np.float32)

                z_dtm_00 = dtm_grid[r0_i, c0_i]
                z_dtm_01 = dtm_grid[r0_i, c1_i]
                z_dtm_10 = dtm_grid[r1_i, c0_i]
                z_dtm_11 = dtm_grid[r1_i, c1_i]
                z_dtm_sampled = (1.0 - dr) * ((1.0 - dc) * z_dtm_00 + dc * z_dtm_01) + dr * ((1.0 - dc) * z_dtm_10 + dc * z_dtm_11)

                dist = np.float32(s * resolution_m)
                tan_t = (z_dtm_sampled - z0[in_bounds]) / dist

                active_r = py_indices[in_bounds]
                active_c = px_indices[in_bounds]

                max_tan_dtm[active_r, active_c] = np.maximum(max_tan_dtm[active_r, active_c], tan_t)
                max_tan_dsm[active_r, active_c] = np.maximum(max_tan_dsm[active_r, active_c], tan_t)

                if include_tree_canopy:
                    z_dsm_00 = dsm_grid[r0_i, c0_i]
                    z_dsm_01 = dsm_grid[r0_i, c1_i]
                    z_dsm_10 = dsm_grid[r1_i, c0_i]
                    z_dsm_11 = dsm_grid[r1_i, c1_i]
                    z_dsm_sampled = np.maximum(
                        z_dtm_sampled,
                        (1.0 - dr) * ((1.0 - dc) * z_dsm_00 + dc * z_dsm_01) + dr * ((1.0 - dc) * z_dsm_10 + dc * z_dsm_11)
                    )
                    tan_s = (z_dsm_sampled - z0[in_bounds]) / dist
                    max_tan_dsm[active_r, active_c] = np.maximum(max_tan_dsm[active_r, active_c], tan_s)

            svf_terrain = 1.0 / (1.0 + max_tan_dtm * max_tan_dtm)
            svf_surface = 1.0 / (1.0 + max_tan_dsm * max_tan_dsm)
            sector_svf = svf_surface + (svf_terrain - svf_surface) * np.float32(canopy_transmittance)
            svf_sum += sector_svf

        return np.clip(svf_sum / np.float32(n_az), 0.05, 1.0).astype(np.float32)
