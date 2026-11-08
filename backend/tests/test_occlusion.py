"""
Unit tests and mathematical validation for CuPy GPU and NumPy CPU terrain occlusion engines.
"""

import pytest
import numpy as np

from backend.app.services.occlusion.cupy_raymarch import CuPyOcclusionEngine
from backend.app.services.occlusion.numpy_raymarch import NumPyOcclusionEngine
from backend.app.services.occlusion.factory import get_best_occlusion_engine, is_gpu_available
from backend.app.services.occlusion.ray_math import compute_receiver_altitude_grid


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


def test_receiver_altitude_calculation():
    dtm = np.full((10, 10), 100.0, dtype=np.float32)
    dsm = np.full((10, 10), 100.0, dtype=np.float32)
    # Add a 15m building at (2:5, 2:5)
    dsm[2:5, 2:5] = 115.0
    # Add a 20m tree at (7:9, 7:9)
    dsm[7:9, 7:9] = 120.0

    # 1. Rooftop Mode
    z0_roof = compute_receiver_altitude_grid(dtm, dsm, is_rooftop=True)
    assert z0_roof.shape == (10, 10)
    assert np.all(z0_roof[2:5, 2:5] == 115.0)
    assert np.all(z0_roof[7:9, 7:9] == 120.0)
    assert z0_roof[0, 0] == 100.0

    # 2. Ground-Mount Mode (1.5m rack above ground)
    z0_ground = compute_receiver_altitude_grid(dtm, dsm, is_rooftop=False, ground_stand_height_m=1.5)
    assert z0_ground.shape == (10, 10)
    assert np.all(z0_ground == 101.5)

    # 3. Fallback when DSM is absent
    z0_fallback_roof = compute_receiver_altitude_grid(dtm, dsm=None, is_rooftop=True)
    assert np.array_equal(z0_fallback_roof, dtm)

    z0_fallback_ground = compute_receiver_altitude_grid(dtm, dsm=None, is_rooftop=False, ground_stand_height_m=2.0)
    assert np.all(z0_fallback_ground == 102.0)


def test_cuda_dual_surface_synthetic_canopy():
    if not is_gpu_available():
        pytest.skip("CUDA GPU not available")

    gpu_engine = CuPyOcclusionEngine()
    
    # 200x200 flat ground at 100m
    dtm = np.full((200, 200), 100.0, dtype=np.float32)
    # DSM has a 20m tree canopy grove at col 120 spanning rows 50:150
    dsm = dtm.copy()
    dsm[:, 120] = 120.0 # 20m trees

    patch_y = slice(60, 140)
    patch_x = slice(80, 140) # Col 120 is at local index 40

    # Sun from East (azimuth = 90°), elevation = 45°
    terrain_mask, canopy_mask = gpu_engine.compute_dual_shadow_mask(
        dtm_grid=dtm,
        dsm_grid=dsm,
        patch_slice_y=patch_y,
        patch_slice_x=patch_x,
        solar_azimuth_deg=90.0,
        solar_elevation_deg=45.0,
        resolution_m=1.0,
        max_search_radius_m=100.0,
        is_rooftop=False,
        ground_stand_height_m=1.5
    )

    # 1. Solid terrain is flat: terrain_mask should be 1 (completely unshaded by terrain)
    assert np.all(terrain_mask == 1)

    # 2. Canopy mask should show shadows extending west from col 40 (col 120)
    # Tree height = 120m, receiver = 101.5m -> shadow length = 18.5m -> 19 cells
    tree_local_idx = 40
    shadow_start = tree_local_idx - 18
    # Cells before shadow are unshaded
    assert np.all(canopy_mask[:, :shadow_start] == 1)
    # Cells in shadow are occluded by canopy
    assert np.all(canopy_mask[:, shadow_start:tree_local_idx] == 0)

    # Test batch computation
    angles = [(90.0, 45.0), (180.0, 60.0), (270.0, -5.0)]
    t_batch, c_batch = gpu_engine.compute_dual_shadow_masks_batch(
        dtm_grid=dtm,
        dsm_grid=dsm,
        patch_slice_y=patch_y,
        patch_slice_x=patch_x,
        sun_angles=angles,
        is_rooftop=False
    )
    assert len(t_batch) == 3
    assert len(c_batch) == 3
    assert np.array_equal(t_batch[0], terrain_mask)
    assert np.array_equal(c_batch[0], canopy_mask)
    # Night frame
    assert np.all(t_batch[2] == 0)
    assert np.all(c_batch[2] == 0)


def test_gpu_cpu_dual_surface_bit_for_bit_equivalence():
    if not is_gpu_available():
        pytest.skip("CUDA GPU not available")

    gpu_engine = CuPyOcclusionEngine()
    cpu_engine = NumPyOcclusionEngine()

    # Create synthetic terrain with a hill and trees
    np.random.seed(42)
    dtm = np.full((150, 150), 100.0, dtype=np.float32)
    # Sloping hill
    y_idx, x_idx = np.indices((150, 150))
    dtm += (y_idx * 0.1).astype(np.float32)

    dsm = dtm.copy()
    # Add 15m trees at (40:80, 50:70)
    dsm[40:80, 50:70] += 15.0
    # Add a 25m building at (90:120, 80:110)
    dsm[90:120, 80:110] += 25.0

    patch_y = slice(40, 110)
    patch_x = slice(40, 110)

    angles = [
        (90.0, 30.0),
        (135.0, 45.0),
        (180.0, 60.0),
        (225.0, 35.0),
        (270.0, 20.0),
    ]

    for is_roof in [True, False]:
        for az, el in angles:
            t_gpu, c_gpu = gpu_engine.compute_dual_shadow_mask(
                dtm, dsm, patch_y, patch_x, az, el, is_rooftop=is_roof
            )
            t_cpu, c_cpu = cpu_engine.compute_dual_shadow_mask(
                dtm, dsm, patch_y, patch_x, az, el, is_rooftop=is_roof
            )

            assert np.array_equal(t_gpu, t_cpu), f"Terrain mismatch: roof={is_roof}, az={az}, el={el}"
            assert np.array_equal(c_gpu, c_cpu), f"Canopy mismatch: roof={is_roof}, az={az}, el={el}"

    # Also verify batch equality
    t_batch_gpu, c_batch_gpu = gpu_engine.compute_dual_shadow_masks_batch(
        dtm, dsm, patch_y, patch_x, angles, is_rooftop=True
    )
    t_batch_cpu, c_batch_cpu = cpu_engine.compute_dual_shadow_masks_batch(
        dtm, dsm, patch_y, patch_x, angles, is_rooftop=True
    )
    assert len(t_batch_gpu) == len(t_batch_cpu) == len(angles)
    assert len(c_batch_gpu) == len(c_batch_cpu) == len(angles)
    for idx in range(len(angles)):
        assert np.array_equal(t_batch_gpu[idx], t_batch_cpu[idx])
        assert np.array_equal(c_batch_gpu[idx], c_batch_cpu[idx])


def test_terrain_mask_invariance_to_canopy_toggle():
    """
    Guarantees that toggling include_tree_canopy ON or OFF NEVER alters
    the terrain shadow mask (bit-for-bit invariance), preventing tree crowns
    from artificially appearing inside geological mountain shadows.
    """
    cpu_engine = NumPyOcclusionEngine()

    np.random.seed(42)
    dtm = np.full((150, 150), 100.0, dtype=np.float32)
    y_idx, x_idx = np.indices((150, 150))
    dtm += (y_idx * 0.1).astype(np.float32)

    dsm = dtm.copy()
    dsm[40:80, 50:70] += 20.0 # 20m tree grove
    dsm[90:120, 80:110] += 25.0

    patch_y = slice(30, 120)
    patch_x = slice(30, 120)

    angles = [
        (90.0, 15.0),
        (180.0, 45.0),
        (270.0, 10.0),
        (297.0, 6.8),
    ]

    for is_roof in [True, False]:
        for az, el in angles:
            t_on, c_on = cpu_engine.compute_dual_shadow_mask(
                dtm, dsm, patch_y, patch_x, az, el,
                is_rooftop=is_roof, include_tree_canopy=True
            )
            t_off, c_off = cpu_engine.compute_dual_shadow_mask(
                dtm, dsm, patch_y, patch_x, az, el,
                is_rooftop=is_roof, include_tree_canopy=False
            )

            # Terrain mask MUST be bit-for-bit identical!
            assert np.array_equal(t_on, t_off), f"Terrain mask altered by canopy toggle: roof={is_roof}, az={az}, el={el}"
            # When canopy is toggled off, any terrain-unshaded cell must be completely unshaded by canopy
            assert np.all(c_off[t_off == 1] == 1)


