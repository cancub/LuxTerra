"""
Unit tests and mathematical validation for CuPy GPU and NumPy CPU terrain occlusion engines.
"""

import pytest
import numpy as np

from backend.app.services.occlusion.cupy_raymarch import CuPyOcclusionEngine
from backend.app.services.occlusion.numpy_raymarch import NumPyOcclusionEngine
from backend.app.services.occlusion.factory import get_best_occlusion_engine, is_gpu_available


@pytest.fixture
def flat_terrain_with_ridge():
    """
    Creates a 300x300 flat terrain at 100m with a 50m high ridge (height 150m)
    located at column 150, spanning across all rows.
    """
    grid = np.full((300, 300), 100.0, dtype=np.float32)
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
    patch_y = slice(100, 200)
    patch_x = slice(80, 160)
    
    cpu_engine = NumPyOcclusionEngine()
    mask_cpu = cpu_engine.compute_shadow_mask(
        elevation_grid=grid,
        patch_slice_y=patch_y,
        patch_slice_x=patch_x,
        solar_azimuth_deg=90.0,
        solar_elevation_deg=45.0,
        resolution_m=1.0,
        max_search_radius_m=100.0
    )

    ridge_idx = 70
    shadow_start = ridge_idx - 50 # index 20
    
    assert np.all(mask_cpu[:, :shadow_start + 1] == 1)
    assert np.all(mask_cpu[:, shadow_start + 1:ridge_idx] == 0)


def test_gpu_cpu_bit_for_bit_equivalence(flat_terrain_with_ridge):
    grid = flat_terrain_with_ridge
    patch_y = slice(80, 220)
    patch_x = slice(80, 220)
    
    cpu_engine = NumPyOcclusionEngine()
    try:
        gpu_engine = CuPyOcclusionEngine()
    except Exception as e:
        pytest.skip(f"CUDA/CuPy not available: {e}")

    test_scenarios = [
        (90.0, 25.0),
        (135.0, 50.0),
        (180.0, 65.0),
        (209.9, 15.3),
        (210.1, 15.2),
        (225.0, 45.0),
        (270.0, 15.0),
    ]

    for azimuth, elevation in test_scenarios:
        mask_cpu = cpu_engine.compute_shadow_mask(
            grid, patch_y, patch_x, azimuth, elevation, resolution_m=1.0, max_search_radius_m=200.0
        )
        mask_gpu = gpu_engine.compute_shadow_mask(
            grid, patch_y, patch_x, azimuth, elevation, resolution_m=1.0, max_search_radius_m=200.0
        )

        assert mask_cpu.shape == mask_gpu.shape
        diff = np.count_nonzero(mask_cpu != mask_gpu)
        assert diff == 0, f"Mismatch at azimuth={azimuth}, elevation={elevation}."


def test_batch_shadow_masks_computation(flat_terrain_with_ridge):
    """
    Test batch occlusion computation across both GPU and CPU.
    """
    grid = flat_terrain_with_ridge
    patch_y = slice(100, 150)
    patch_x = slice(100, 150)

    angles = [
        (90.0, 30.0),
        (135.0, 45.0),
        (180.0, 60.0),
        (225.0, 40.0),
        (270.0, -5.0), # Night
    ]

    cpu_engine = NumPyOcclusionEngine()
    masks_cpu = cpu_engine.compute_shadow_masks_batch(grid, patch_y, patch_x, angles)
    assert len(masks_cpu) == 5
    assert np.all(masks_cpu[-1] == 0) # Night frame is 0

    if is_gpu_available():
        gpu_engine = CuPyOcclusionEngine()
        masks_gpu = gpu_engine.compute_shadow_masks_batch(grid, patch_y, patch_x, angles)
        assert len(masks_gpu) == 5
        for m_cpu, m_gpu in zip(masks_cpu, masks_gpu):
            assert np.array_equal(m_cpu, m_gpu)


def test_occlusion_factory():
    engine = get_best_occlusion_engine(prefer_gpu=True)
    assert engine is not None
    if is_gpu_available():
        assert isinstance(engine, CuPyOcclusionEngine)
    else:
        assert isinstance(engine, NumPyOcclusionEngine)


def test_invalid_patch_slice_raises(flat_terrain_with_ridge):
    cpu_engine = NumPyOcclusionEngine()
    # Empty slice
    with pytest.raises(ValueError, match="Invalid patch slice"):
        cpu_engine.compute_shadow_mask(
            flat_terrain_with_ridge, slice(100, 100), slice(50, 100), 180.0, 45.0
        )


def test_night_shadow_all_zero():
    grid = np.full((100, 100), 100.0, dtype=np.float32)
    patch_y = slice(20, 80)
    patch_x = slice(20, 80)
    
    cpu_engine = NumPyOcclusionEngine()
    mask_cpu = cpu_engine.compute_shadow_mask(grid, patch_y, patch_x, 180.0, -10.0)
    assert np.all(mask_cpu == 0)

    if is_gpu_available():
        gpu_engine = CuPyOcclusionEngine()
        mask_gpu = gpu_engine.compute_shadow_mask(grid, patch_y, patch_x, 180.0, -10.0)
        assert np.all(mask_gpu == 0)
