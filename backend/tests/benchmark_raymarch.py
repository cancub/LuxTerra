"""
Performance Benchmark: CuPy GPU vs NumPy CPU Ray-Marcher.
Tests a 100,000 m² patch (316x316 cells) with a 500m search radius on RTX 4070 Ti.
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import time
import numpy as np

from backend.app.services.occlusion.cupy_raymarch import CuPyOcclusionEngine
from backend.app.services.occlusion.numpy_raymarch import NumPyOcclusionEngine


def run_benchmark():
    print("=== LuxTerra Ray-Marcher Benchmark Suite ===")
    
    # 100,000 m² patch (316 x 316) buffered by 500m (1316 x 1316 cells)
    patch_dim = 316
    buffer_m = 500
    grid_dim = patch_dim + (2 * buffer_m) # 1316 x 1316 = 1.73M elevation cells
    
    print(f"Elevation Grid Dimensions: {grid_dim} x {grid_dim} (1.73M points)")
    print(f"Target Patch Dimensions: {patch_dim} x {patch_dim} ({patch_dim*patch_dim:,} cells)")
    print(f"Search Radius: {buffer_m} meters (500 steps per cell)")
    print(f"Total Ray Steps evaluated per frame: {patch_dim * patch_dim * buffer_m:,} steps")

    # Generate synthetic rolling hill terrain
    x = np.linspace(0, 10, grid_dim, dtype=np.float32)
    y = np.linspace(0, 10, grid_dim, dtype=np.float32)
    X, Y = np.meshgrid(x, y)
    elevation = 150.0 + (np.sin(X) * 30.0) + (np.cos(Y) * 40.0)

    patch_y = slice(buffer_m, buffer_m + patch_dim)
    patch_x = slice(buffer_m, buffer_m + patch_dim)

    azimuth = 145.0
    elevation_angle = 35.0

    # 1. Benchmark GPU (CuPy on RTX 4070 Ti)
    print("\n--- Benchmarking CuPy GPU Ray-Marcher ---")
    gpu_engine = CuPyOcclusionEngine()
    
    # Warmup
    _ = gpu_engine.compute_shadow_mask(elevation, patch_y, patch_x, azimuth, elevation_angle)

    iterations = 20
    start_gpu = time.perf_counter()
    for _ in range(iterations):
        mask_gpu = gpu_engine.compute_shadow_mask(elevation, patch_y, patch_x, azimuth, elevation_angle)
    end_gpu = time.perf_counter()

    avg_gpu_ms = ((end_gpu - start_gpu) / iterations) * 1000.0
    print(f"GPU Average Execution Time: {avg_gpu_ms:.2f} ms per frame ({1000.0/avg_gpu_ms:.1f} FPS)")

    # 2. Benchmark CPU (NumPy Vectorized)
    print("\n--- Benchmarking NumPy CPU Ray-Marcher ---")
    cpu_engine = NumPyOcclusionEngine()
    
    # Run 2 iterations for CPU
    cpu_iters = 2
    start_cpu = time.perf_counter()
    for _ in range(cpu_iters):
        mask_cpu = cpu_engine.compute_shadow_mask(elevation, patch_y, patch_x, azimuth, elevation_angle)
    end_cpu = time.perf_counter()

    avg_cpu_ms = ((end_cpu - start_cpu) / cpu_iters) * 1000.0
    print(f"CPU Average Execution Time: {avg_cpu_ms:.2f} ms per frame")

    speedup = avg_cpu_ms / avg_gpu_ms
    print(f"\nGPU Speedup over CPU: {speedup:.1f}x faster!")

    # Verify identical output
    diff = np.count_nonzero(mask_gpu != mask_cpu)
    print(f"Bit-for-bit Mask Discrepancy: {diff} pixels (100% equivalence: {diff == 0})")
    print("============================================")


if __name__ == "__main__":
    run_benchmark()
