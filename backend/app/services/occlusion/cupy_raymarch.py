"""
GPU-accelerated Terrain Occlusion Engine using CuPy.
Dispatches parallel ray-marching across the local NVIDIA GPU (RTX 4070 Ti).
"""

from typing import List, Tuple, Optional
import numpy as np

from ...interfaces.occlusion_engine import OcclusionEngine
from .cuda_kernels import (
    get_compiled_raymarch_kernel,
    get_compiled_dual_raymarch_kernel,
    get_compiled_ground_and_top_kernel,
    get_compiled_svf_kernel,
)
from .ray_math import calculate_ray_step, compute_canopy_step_3d_m, validate_patch_slices


class CuPyOcclusionEngine(OcclusionEngine):
    """
    High-performance GPU ray-marcher using compiled CUDA kernels via CuPy.
    Supports single-surface terrain, dual-surface terrain + canopy ray-marching,
    and 360-degree Horizon Sky View Factor (SVF) ambient occlusion.
    """

    def __init__(self):
        try:
            import cupy as cp
            self.cp = cp
            self.kernel = get_compiled_raymarch_kernel()
            self.dual_kernel = get_compiled_dual_raymarch_kernel()
            self.ground_and_top_kernel = get_compiled_ground_and_top_kernel()
            self.svf_kernel = get_compiled_svf_kernel()
            self._gpu_available = True
        except Exception as e:
            self._gpu_available = False
            raise RuntimeError(f"CuPy GPU acceleration initialization failed: {e}")

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
        Computes binary shadow mask for a single sun position.
        """
        patch_H, patch_W, y_offset, x_offset = self._validate_slices(elevation_grid, patch_slice_y, patch_slice_x)
        ray_params = calculate_ray_step(solar_azimuth_deg, solar_elevation_deg, resolution_m, max_search_radius_m)

        if not ray_params.is_daylight:
            return np.zeros((patch_H, patch_W), dtype=np.uint8)

        cp = self.cp
        H, W = elevation_grid.shape

        d_elevation = cp.asarray(elevation_grid, dtype=cp.float32)
        d_mask = cp.empty((patch_H, patch_W), dtype=cp.uint8)

        block_dim = (16, 16, 1)
        grid_dim = (
            (patch_W + block_dim[0] - 1) // block_dim[0],
            (patch_H + block_dim[1] - 1) // block_dim[1],
            1
        )

        self.kernel(
            grid_dim,
            block_dim,
            (
                d_elevation,
                d_mask,
                np.int32(H),
                np.int32(W),
                np.int32(y_offset),
                np.int32(x_offset),
                np.int32(patch_H),
                np.int32(patch_W),
                np.float32(ray_params.step_dr),
                np.float32(ray_params.step_dc),
                np.float32(ray_params.tan_alpha),
                np.float32(ray_params.step_dist),
                np.int32(ray_params.max_steps),
            )
        )

        return cp.asnumpy(d_mask)

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
        Batch-computes shadow masks across multiple sun angles.
        Uploads elevation_grid to VRAM ONCE, minimizing PCIe host-to-device traffic.
        """
        patch_H, patch_W, y_offset, x_offset = self._validate_slices(elevation_grid, patch_slice_y, patch_slice_x)
        cp = self.cp
        H, W = elevation_grid.shape

        # Single upload of elevation field to GPU
        d_elevation = cp.asarray(elevation_grid, dtype=cp.float32)
        d_mask = cp.empty((patch_H, patch_W), dtype=cp.uint8)

        block_dim = (16, 16, 1)
        grid_dim = (
            (patch_W + block_dim[0] - 1) // block_dim[0],
            (patch_H + block_dim[1] - 1) // block_dim[1],
            1
        )

        results = []
        for azimuth, elevation in sun_angles:
            ray_params = calculate_ray_step(azimuth, elevation, resolution_m, max_search_radius_m)
            if not ray_params.is_daylight:
                results.append(np.zeros((patch_H, patch_W), dtype=np.uint8))
                continue

            self.kernel(
                grid_dim,
                block_dim,
                (
                    d_elevation,
                    d_mask,
                    np.int32(H),
                    np.int32(W),
                    np.int32(y_offset),
                    np.int32(x_offset),
                    np.int32(patch_H),
                    np.int32(patch_W),
                    np.float32(ray_params.step_dr),
                    np.float32(ray_params.step_dc),
                    np.float32(ray_params.tan_alpha),
                    np.float32(ray_params.step_dist),
                    np.int32(ray_params.max_steps),
                )
            )
            results.append(cp.asnumpy(d_mask))

        return results

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
        include_tree_canopy: bool = True,
        top_of_canopy: bool = False
    ) -> Tuple[np.ndarray, np.ndarray]:
        """
        Computes dual binary shadow masks (terrain_mask, canopy_mask) for a single sun angle.
        - terrain_mask: 1 = unshaded by solid terrain, 0 = terrain shaded
        - canopy_mask: 1 = unshaded by tree canopy/structure, 0 = canopy shaded
        """
        patch_H, patch_W, y_offset, x_offset = self._validate_slices(dtm_grid, patch_slice_y, patch_slice_x)
        ray_params = calculate_ray_step(solar_azimuth_deg, solar_elevation_deg, resolution_m, max_search_radius_m)

        if not ray_params.is_daylight:
            zeros = np.zeros((patch_H, patch_W), dtype=np.uint8)
            return zeros, zeros.copy()

        cp = self.cp
        H, W = dtm_grid.shape

        d_dtm = cp.asarray(dtm_grid, dtype=cp.float32)
        d_dsm = cp.asarray(dsm_grid, dtype=cp.float32)
        d_terrain_mask = cp.empty((patch_H, patch_W), dtype=cp.uint8)
        d_canopy_mask = cp.empty((patch_H, patch_W), dtype=cp.uint8)

        block_dim = (16, 16, 1)
        grid_dim = (
            (patch_W + block_dim[0] - 1) // block_dim[0],
            (patch_H + block_dim[1] - 1) // block_dim[1],
            1
        )

        step_3d_m = compute_canopy_step_3d_m(ray_params.step_dist, ray_params.tan_alpha)
        self.dual_kernel(
            grid_dim,
            block_dim,
            (
                d_dtm,
                d_dsm,
                d_terrain_mask,
                d_canopy_mask,
                np.uintp(0),
                np.int32(H),
                np.int32(W),
                np.int32(y_offset),
                np.int32(x_offset),
                np.int32(patch_H),
                np.int32(patch_W),
                np.float32(ray_params.step_dr),
                np.float32(ray_params.step_dc),
                np.float32(ray_params.tan_alpha),
                np.float32(ray_params.step_dist),
                np.float32(step_3d_m),
                np.int32(ray_params.max_steps),
                np.int32(1 if is_rooftop else 0),
                np.float32(ground_stand_height_m),
                np.int32(1 if include_tree_canopy else 0),
                np.int32(1 if top_of_canopy else 0),
            )
        )

        return cp.asnumpy(d_terrain_mask), cp.asnumpy(d_canopy_mask)

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
        include_tree_canopy: bool = True,
        top_of_canopy: bool = False
    ) -> Tuple[List[np.ndarray], List[np.ndarray]]:
        t_list, c_list, _ = self.compute_dual_shadow_masks_with_path_batch(
            dtm_grid, dsm_grid, patch_slice_y, patch_slice_x, sun_angles,
            resolution_m, max_search_radius_m, is_rooftop, ground_stand_height_m,
            include_tree_canopy, top_of_canopy, include_path=False
        )
        return t_list, c_list

    def compute_dual_shadow_masks_with_path_batch(
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
        include_tree_canopy: bool = True,
        top_of_canopy: bool = False,
        include_path: bool = True
    ) -> Tuple[List[np.ndarray], List[np.ndarray], List[np.ndarray]]:
        """
        Batch-computes dual shadow masks (and optional 3D canopy path length in meters)
        across multiple sun angles. Uploads both DTM and DSM fields to VRAM ONCE.
        """
        patch_H, patch_W, y_offset, x_offset = self._validate_slices(dtm_grid, patch_slice_y, patch_slice_x)
        cp = self.cp
        H, W = dtm_grid.shape

        # Single upload of both DTM and DSM fields to GPU VRAM
        d_dtm = cp.asarray(dtm_grid, dtype=cp.float32)
        d_dsm = cp.asarray(dsm_grid, dtype=cp.float32)

        block_dim = (16, 16, 1)
        grid_dim = (
            (patch_W + block_dim[0] - 1) // block_dim[0],
            (patch_H + block_dim[1] - 1) // block_dim[1],
            1
        )

        # Batch allocate GPU output tensors to avoid per-timestep PCIe syncs
        num_angles = len(sun_angles)
        d_terrain_batch = cp.zeros((num_angles, patch_H, patch_W), dtype=cp.uint8)
        d_canopy_batch = cp.zeros((num_angles, patch_H, patch_W), dtype=cp.uint8)
        d_path_batch = cp.zeros((num_angles, patch_H, patch_W), dtype=cp.float32) if include_path else None

        for idx, (azimuth, elevation) in enumerate(sun_angles):
            ray_params = calculate_ray_step(azimuth, elevation, resolution_m, max_search_radius_m)
            if not ray_params.is_daylight:
                continue

            step_3d_m = compute_canopy_step_3d_m(ray_params.step_dist, ray_params.tan_alpha)
            path_ptr = d_path_batch[idx] if include_path else np.uintp(0)

            self.dual_kernel(
                grid_dim,
                block_dim,
                (
                    d_dtm,
                    d_dsm,
                    d_terrain_batch[idx],
                    d_canopy_batch[idx],
                    path_ptr,
                    np.int32(H),
                    np.int32(W),
                    np.int32(y_offset),
                    np.int32(x_offset),
                    np.int32(patch_H),
                    np.int32(patch_W),
                    np.float32(ray_params.step_dr),
                    np.float32(ray_params.step_dc),
                    np.float32(ray_params.tan_alpha),
                    np.float32(ray_params.step_dist),
                    np.float32(step_3d_m),
                    np.int32(ray_params.max_steps),
                    np.int32(1 if is_rooftop else 0),
                    np.float32(ground_stand_height_m),
                    np.int32(1 if include_tree_canopy else 0),
                    np.int32(1 if top_of_canopy else 0),
                )
            )

        # Single device-to-host PCIe transfer for all timesteps
        h_terrain = cp.asnumpy(d_terrain_batch)
        h_canopy = cp.asnumpy(d_canopy_batch)
        h_path = cp.asnumpy(d_path_batch) if include_path else None

        t_list = [h_terrain[i] for i in range(num_angles)]
        c_list = [h_canopy[i] for i in range(num_angles)]
        p_list = [h_path[i] for i in range(num_angles)] if include_path else []
        return t_list, c_list, p_list

    def compute_ground_and_top_shadow_masks_batch(
        self,
        dtm_grid: np.ndarray,
        dsm_grid: np.ndarray,
        patch_slice_y: slice,
        patch_slice_x: slice,
        sun_angles: List[Tuple[float, float]],
        resolution_m: float = 1.0,
        max_search_radius_m: float = 1000.0,
        ground_stand_height_m: float = 1.5,
    ) -> Tuple[List[np.ndarray], List[np.ndarray], List[np.ndarray], List[np.ndarray], List[np.ndarray], List[np.ndarray]]:
        """
        Single-pass GPU ray-march computing both ground-level and top-of-canopy
        dual shadow masks and cumulative 3D canopy path lengths in one VRAM pass.
        """
        patch_H, patch_W, y_offset, x_offset = self._validate_slices(dtm_grid, patch_slice_y, patch_slice_x)
        cp = self.cp
        H, W = dtm_grid.shape

        d_dtm = cp.asarray(dtm_grid, dtype=cp.float32)
        d_dsm = cp.asarray(dsm_grid, dtype=cp.float32)

        block_dim = (16, 16, 1)
        grid_dim = (
            (patch_W + block_dim[0] - 1) // block_dim[0],
            (patch_H + block_dim[1] - 1) // block_dim[1],
            1
        )

        num_angles = len(sun_angles)
        d_g_t = cp.zeros((num_angles, patch_H, patch_W), dtype=cp.uint8)
        d_g_c = cp.zeros((num_angles, patch_H, patch_W), dtype=cp.uint8)
        d_g_p = cp.zeros((num_angles, patch_H, patch_W), dtype=cp.float32)
        d_t_t = cp.zeros((num_angles, patch_H, patch_W), dtype=cp.uint8)
        d_t_c = cp.zeros((num_angles, patch_H, patch_W), dtype=cp.uint8)
        d_t_p = cp.zeros((num_angles, patch_H, patch_W), dtype=cp.float32)

        for idx, (azimuth, elevation) in enumerate(sun_angles):
            ray_params = calculate_ray_step(azimuth, elevation, resolution_m, max_search_radius_m)
            if not ray_params.is_daylight:
                continue

            step_3d_m = compute_canopy_step_3d_m(ray_params.step_dist, ray_params.tan_alpha)
            self.ground_and_top_kernel(
                grid_dim,
                block_dim,
                (
                    d_dtm,
                    d_dsm,
                    d_g_t[idx],
                    d_g_c[idx],
                    d_g_p[idx],
                    d_t_t[idx],
                    d_t_c[idx],
                    d_t_p[idx],
                    np.int32(H),
                    np.int32(W),
                    np.int32(y_offset),
                    np.int32(x_offset),
                    np.int32(patch_H),
                    np.int32(patch_W),
                    np.float32(ray_params.step_dr),
                    np.float32(ray_params.step_dc),
                    np.float32(ray_params.tan_alpha),
                    np.float32(ray_params.step_dist),
                    np.float32(step_3d_m),
                    np.int32(ray_params.max_steps),
                    np.float32(ground_stand_height_m),
                )
            )

        h_g_t = cp.asnumpy(d_g_t)
        h_g_c = cp.asnumpy(d_g_c)
        h_g_p = cp.asnumpy(d_g_p)
        h_t_t = cp.asnumpy(d_t_t)
        h_t_c = cp.asnumpy(d_t_c)
        h_t_p = cp.asnumpy(d_t_p)

        return (
            [h_g_t[i] for i in range(num_angles)],
            [h_g_c[i] for i in range(num_angles)],
            [h_g_p[i] for i in range(num_angles)],
            [h_t_t[i] for i in range(num_angles)],
            [h_t_c[i] for i in range(num_angles)],
            [h_t_p[i] for i in range(num_angles)],
        )

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
        Computes a 2D Sky View Factor (SVF) map in [0.05, 1.0] across the patch on GPU.
        Integrates horizon elevation angles across `num_azimuths` directions around 360 degrees.
        """
        patch_H, patch_W, y_offset, x_offset = self._validate_slices(dtm_grid, patch_slice_y, patch_slice_x)
        cp = self.cp
        H, W = dtm_grid.shape

        max_steps = max(2, int(np.ceil(max_search_radius_m / max(0.1, resolution_m))))

        d_dtm = cp.asarray(dtm_grid, dtype=cp.float32)
        d_dsm = cp.asarray(dsm_grid, dtype=cp.float32)
        d_svf = cp.empty((patch_H, patch_W), dtype=cp.float32)

        block_dim = (16, 16, 1)
        grid_dim = (
            (patch_W + block_dim[0] - 1) // block_dim[0],
            (patch_H + block_dim[1] - 1) // block_dim[1],
            1
        )

        self.svf_kernel(
            grid_dim,
            block_dim,
            (
                d_dtm,
                d_dsm,
                d_svf,
                np.int32(H),
                np.int32(W),
                np.int32(y_offset),
                np.int32(x_offset),
                np.int32(patch_H),
                np.int32(patch_W),
                np.int32(max(4, num_azimuths)),
                np.int32(max_steps),
                np.float32(resolution_m),
                np.int32(1 if is_rooftop else 0),
                np.float32(ground_stand_height_m),
                np.int32(1 if include_tree_canopy else 0),
                np.float32(canopy_transmittance),
            )
        )

        return cp.asnumpy(d_svf)
