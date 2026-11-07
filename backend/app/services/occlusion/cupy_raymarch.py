"""
GPU-accelerated Terrain Occlusion Engine using CuPy.
Dispatches parallel ray-marching across the local NVIDIA GPU (RTX 4070 Ti).
"""

from typing import List, Tuple
import numpy as np

from ...interfaces.occlusion_engine import OcclusionEngine
from .cuda_kernels import get_compiled_raymarch_kernel
from .ray_math import calculate_ray_step


class CuPyOcclusionEngine(OcclusionEngine):
    """
    High-performance GPU ray-marcher using compiled CUDA kernels via CuPy.
    """

    def __init__(self):
        try:
            import cupy as cp
            self.cp = cp
            self.kernel = get_compiled_raymarch_kernel()
            self._gpu_available = True
        except Exception as e:
            self._gpu_available = False
            raise RuntimeError(f"CuPy GPU acceleration initialization failed: {e}")

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
        max_search_radius_m: float = 500.0
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
