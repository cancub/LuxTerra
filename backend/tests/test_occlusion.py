"""
Unit tests and mathematical validation for CuPy GPU and NumPy CPU terrain occlusion engines.
"""

import pytest
import numpy as np

from backend.app.services.occlusion.cupy_raymarch import CuPyOcclusionEngine
from backend.app.services.occlusion.numpy_raymarch import NumPyOcclusionEngine


@pytest.fixture
def flat_terrain_with_ridge():
    """
    Creates a 300x300 flat terrain at 100m with a 50m high ridge (height 150m)
    located at column 150, spanning across all rows.
    """
    grid = np.full((300, 300), 100.0, dtype=np.float32)
    # Ridge at column 150, 50m higher than surrounding terrain
    grid[:, 150] = 150.0
    return grid


def test_synthetic_ridge_shadow_geometry(flat_terrain_with_ridge):
    """
    Mathematical shadow length verification:
    Sun from East (azimuth = 90°), elevation = 45°.
    Tan(45°) = 1.0. Height delta = 50m.
    Shadow extends 50m to the West (columns 100 to 149).
    """
    grid = flat_terrain_with_ridge
    # Patch slice to the west of the ridge: rows 100-200, cols 80-160
    patch_y = slice(100, 200)
    patch_x = slice(80, 160)
    
    cpu_engine = NumPyOcclusionEngine()
    mask_cpu = cpu_engine.compute_shadow_mask(
        elevation_grid=grid,
        patch_slice_y=patch_y,
        patch_slice_x=patch_x,
        solar_azimuth_deg=90.0,     # East
        solar_elevation_deg=45.0,   # 45 deg elevation
        resolution_m=1.0,
        max_search_radius_m=100.0
    )

    # In patch_x (cols 80 to 160), the ridge is at index 150 - 80 = 70.
    # Shadow extends 50 cells west: from col index (70 - 50) = 20 to 69.
    # Cells with col index < 20 (cols 80 to 99 in grid) should be UNSHADED (1).
    # Cells with col index 20 to 69 (cols 100 to 149 in grid) should be SHADED (0).
    ridge_idx = 70
    shadow_start = ridge_idx - 50 # index 20
    
    # At exactly 50m (col index 20), ray height = 100 + 50*tan(45) = 150m == terrain height (grazing boundary).
    # Cells strictly inside the shadow (distance 1m to 49m, col index 21 to 69) must be SHADED (0).
    # Cells west of the 50m shadow limit (col index <= 20) must be UNSHADED (1).
    assert np.all(mask_cpu[:, :shadow_start + 1] == 1)
    assert np.all(mask_cpu[:, shadow_start + 1:ridge_idx] == 0)


def test_gpu_cpu_bit_for_bit_equivalence(flat_terrain_with_ridge):
    """
    Verify that CuPy GPU ray-marcher and NumPy CPU ray-marcher produce
    identical shadow masks across multiple sun angles.
    """
    grid = flat_terrain_with_ridge
    patch_y = slice(80, 220)
    patch_x = slice(80, 220)
    
    cpu_engine = NumPyOcclusionEngine()
    try:
        gpu_engine = CuPyOcclusionEngine()
    except Exception as e:
        pytest.skip(f"CUDA/CuPy not available: {e}")

    test_scenarios = [
        # Morning low sun from East
        (90.0, 25.0),
        # Mid-day sun from South-East
        (135.0, 50.0),
        # Noon sun from South
        (180.0, 65.0),
        # Afternoon sun from South-West
        (225.0, 45.0),
        # Evening low sun from West
        (270.0, 15.0),
    ]

    for azimuth, elevation in test_scenarios:
        mask_cpu = cpu_engine.compute_shadow_mask(
            grid, patch_y, patch_x, azimuth, elevation, resolution_m=1.0, max_search_radius_m=200.0
        )
        mask_gpu = gpu_engine.compute_shadow_mask(
            grid, patch_y, patch_x, azimuth, elevation, resolution_m=1.0, max_search_radius_m=200.0
        )

        # Confirm shape and bit-for-bit exact equality
        assert mask_cpu.shape == mask_gpu.shape
        diff = np.count_nonzero(mask_cpu != mask_gpu)
        assert diff == 0, f"Mismatch between GPU and CPU at azimuth={azimuth}, elevation={elevation}: {diff} pixels differed."


def test_night_shadow_all_zero():
    grid = np.full((100, 100), 100.0, dtype=np.float32)
    patch_y = slice(20, 80)
    patch_x = slice(20, 80)
    
    cpu_engine = NumPyOcclusionEngine()
    gpu_engine = CuPyOcclusionEngine()

    mask_cpu = cpu_engine.compute_shadow_mask(grid, patch_y, patch_x, 180.0, -10.0)
    mask_gpu = gpu_engine.compute_shadow_mask(grid, patch_y, patch_x, 180.0, -10.0)

    assert np.all(mask_cpu == 0)
    assert np.all(mask_gpu == 0)
