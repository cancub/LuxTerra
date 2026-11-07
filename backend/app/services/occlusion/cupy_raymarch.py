"""
GPU-accelerated Terrain Occlusion Engine using CuPy.
Dispatches parallel ray-marching across the local NVIDIA GPU (RTX 4070 Ti).
"""

import math
import numpy as np

from ...interfaces.occlusion_engine import OcclusionEngine
from .cuda_kernels import get_compiled_raymarch_kernel


class CuPyOcclusionEngine(OcclusionEngine):
    """
    High-performance GPU ray-marcher using compiled CUDA kernels via CuPy.
    """

    def __init__(self):
        # Verify CuPy availability
        try:
            import cupy as cp
            self.cp = cp
            self.kernel = get_compiled_raymarch_kernel()
            self._gpu_available = True
        except Exception as e:
            self._gpu_available = False
            raise RuntimeError(f"CuPy GPU acceleration initialization failed: {e}")

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
        Computes binary shadow mask using CUDA GPU ray-marching.
        """
        patch_H = patch_slice_y.stop - patch_slice_y.start
        patch_W = patch_slice_x.stop - patch_slice_x.start

        # If sun is at or below the horizon, entire patch is in darkness
        if solar_elevation_deg <= 0.0:
            return np.zeros((patch_H, patch_W), dtype=np.uint8)

        cp = self.cp
        H, W = elevation_grid.shape
        patch_y_offset = patch_slice_y.start
        patch_x_offset = patch_slice_x.start

        # Calculate vector step towards sun:
        # Col increases East (sin(azimuth)), Row increases South (-cos(azimuth))
        azimuth_rad = math.radians(solar_azimuth_deg)
        step_dc = float(math.sin(azimuth_rad) / resolution_m)
        step_dr = float(-math.cos(azimuth_rad) / resolution_m)

        tan_alpha = float(math.tan(math.radians(solar_elevation_deg)))
        step_dist = float(resolution_m)
        max_steps = int(math.ceil(max_search_radius_m / resolution_m))

        # Transfer elevation grid to GPU VRAM
        d_elevation = cp.asarray(elevation_grid, dtype=cp.float32)
        d_mask = cp.empty((patch_H, patch_W), dtype=cp.uint8)

        # 2D thread block and grid configuration
        block_dim = (16, 16, 1)
        grid_dim = (
            (patch_W + block_dim[0] - 1) // block_dim[0],
            (patch_H + block_dim[1] - 1) // block_dim[1],
            1
        )

        # Launch kernel
        self.kernel(
            grid_dim,
            block_dim,
            (
                d_elevation,
                d_mask,
                np.int32(H),
                np.int32(W),
                np.int32(patch_y_offset),
                np.int32(patch_x_offset),
                np.int32(patch_H),
                np.int32(patch_W),
                np.float32(step_dr),
                np.float32(step_dc),
                np.float32(tan_alpha),
                np.float32(step_dist),
                np.int32(max_steps),
            )
        )

        # Pull result mask to host memory
        return cp.asnumpy(d_mask)
