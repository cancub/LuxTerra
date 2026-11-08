"""
Unit and integration tests for LuxTerra Elevation & DTM Pipeline.
"""

import pytest
import numpy as np
import rasterio
from pathlib import Path

from backend.app.services.elevation.geo_utils import (
    get_utm_crs_for_lon_lat,
    calculate_bbox_area_meters,
    buffer_bounding_box_meters,
    normalize_bbox,
    validate_patch_area
)
from backend.app.services.elevation.tile_cache import TileCacheManager
from backend.app.services.elevation.local_geotiff import LocalGeoTIFFProvider
from scripts.fetch_test_dtm import fetch_preset


def test_utm_crs_resolution():
    crs_mtl = get_utm_crs_for_lon_lat(-73.618, 45.503)
    assert crs_mtl == "EPSG:32618"
    
    crs_gaspe = get_utm_crs_for_lon_lat(-65.0, 48.5)
    assert crs_gaspe == "EPSG:32620"


def test_normalize_bbox():
    # Inverted min/max from reversed drag
    min_lon, min_lat, max_lon, max_lat = normalize_bbox(-73.60, 45.51, -73.62, 45.49)
    assert min_lon == -73.62
    assert max_lon == -73.60
    assert min_lat == 45.49
    assert max_lat == 45.51


def test_bbox_area_calculation():
    min_lon, min_lat = -73.618, 45.503
    max_lon, max_lat = -73.6166, 45.504
    area = calculate_bbox_area_meters(min_lon, min_lat, max_lon, max_lat)
    assert 10000.0 < area < 15000.0


def test_validate_patch_area():
    # Valid ~12,000 m² patch
    is_valid, area, msg = validate_patch_area(-73.618, 45.503, -73.6166, 45.504)
    assert is_valid is True
    assert 10000.0 < area < 15000.0
    
    # Large area exceeding 100,000 m² (~1 km x 1 km = 1,000,000 m²)
    is_valid_large, area_large, msg_large = validate_patch_area(-73.63, 45.50, -73.61, 45.51)
    assert is_valid_large is False
    assert area_large > 100000.0
    assert "exceeds the maximum allowable limit" in msg_large


def test_buffer_bounding_box_500m():
    min_lon, min_lat = -73.618, 45.503
    max_lon, max_lat = -73.6166, 45.504
    
    info = buffer_bounding_box_meters(min_lon, min_lat, max_lon, max_lat, buffer_meters=500.0)
    
    pw = info["patch_width_m"]
    ph = info["patch_height_m"]
    bw = info["buffered_width_m"]
    bh = info["buffered_height_m"]
    
    assert pytest.approx(bw, abs=1.0) == pw + 1000.0
    assert pytest.approx(bh, abs=1.0) == ph + 1000.0


def test_tile_cache_and_manifest(tmp_path):
    cache = TileCacheManager(cache_dir=tmp_path)
    manifest = cache.load_manifest()
    assert "tiles" in manifest
    assert len(manifest["tiles"]) == 0


def test_elevation_window_extraction_and_resampling(tmp_path):
    cache = TileCacheManager(cache_dir=tmp_path)
    fetch_preset("montreal", cache, force_synthetic=True)
    
    provider = LocalGeoTIFFProvider(cache_manager=cache)
    
    center_lon, center_lat = -73.618, 45.503
    delta = 0.0006
    
    # 1. Test 1m resolution (default)
    res_1m = provider.get_elevation_window(
        min_lon=center_lon - delta,
        min_lat=center_lat - delta,
        max_lon=center_lon + delta,
        max_lat=center_lat + delta,
        buffer_meters=500.0,
        target_resolution_m=1.0
    )
    
    elev_1m = res_1m["buffered_elevation"]
    assert isinstance(elev_1m, np.ndarray)
    assert elev_1m.ndim == 2
    assert res_1m["resolution_m"] == 1.0
    h_1m, w_1m = elev_1m.shape
    assert 1000 <= w_1m <= 1200
    
    # 2. Test 2m resolution resampling
    res_2m = provider.get_elevation_window(
        min_lon=center_lon - delta,
        min_lat=center_lat - delta,
        max_lon=center_lon + delta,
        max_lat=center_lat + delta,
        buffer_meters=500.0,
        target_resolution_m=2.0
    )
    elev_2m = res_2m["buffered_elevation"]
    assert res_2m["resolution_m"] == 2.0
    h_2m, w_2m = elev_2m.shape
    # At 2m resolution, grid dimensions should be approximately half
    assert pytest.approx(w_2m * 2, abs=4) == w_1m
    assert pytest.approx(h_2m * 2, abs=4) == h_1m
    
    # Elevation checks
    median_elev = res_1m["median_elevation_m"]
    assert 75.0 <= median_elev <= 233.0
    
    # Patch slice check
    slice_y = res_1m["patch_slice_y"]
    slice_x = res_1m["patch_slice_x"]
    patch_cells = elev_1m[slice_y, slice_x]
    assert patch_cells.size > 0
    assert np.all(patch_cells > 0)
    assert not np.any(np.isnan(elev_1m))


def test_dual_raster_window_extraction_and_chm(tmp_path):
    from rasterio.transform import from_origin
    
    cache = TileCacheManager(cache_dir=tmp_path / "dtm", dsm_dir=tmp_path / "dsm")
    dtm_path = cache.cache_dir / "dtm_canopy_test.tif"
    dsm_path = cache.dsm_dir / "dsm_canopy_test.tif"
    
    # 500x500 1m raster centered in Montreal UTM Zone 18N
    width, height = 300, 300
    res = 1.0
    min_x, max_y = 600000.0, 5040000.0
    transform = from_origin(min_x, max_y, res, res)
    
    dtm_elev = np.ones((height, width), dtype=np.float32) * 120.0
    # Add a 15m tree canopy grove in the center
    dsm_elev = dtm_elev.copy()
    dsm_elev[100:200, 100:200] += 15.0
    
    for path, data in [(dtm_path, dtm_elev), (dsm_path, dsm_elev)]:
        with rasterio.open(
            path,
            'w',
            driver='GTiff',
            height=height,
            width=width,
            count=1,
            dtype=np.float32,
            crs="EPSG:32618",
            transform=transform,
            nodata=-9999.0
        ) as dst:
            dst.write(data, 1)
            
    cache.update_manifest()
    provider = LocalGeoTIFFProvider(cache_manager=cache)
    
    manifest = cache.load_manifest()
    min_lon, min_lat, max_lon, max_lat = manifest["tiles"][0]["bounds_wgs84"]
    c_lon = (min_lon + max_lon) / 2.0
    c_lat = (min_lat + max_lat) / 2.0
    delta = 0.0003
    
    result = provider.get_elevation_window(
        min_lon=c_lon - delta,
        min_lat=c_lat - delta,
        max_lon=c_lon + delta,
        max_lat=c_lat + delta,
        buffer_meters=50.0,
        target_resolution_m=1.0
    )
    
    assert "dtm" in result
    assert "dsm" in result
    assert "chm" in result
    assert result["has_canopy"] is True
    assert result["dsm_tile_source"] == "dsm_canopy_test.tif"
    
    dtm_grid = result["dtm"]
    dsm_grid = result["dsm"]
    chm_grid = result["chm"]
    
    assert np.all(dsm_grid >= dtm_grid - 1e-4)
    assert np.all(chm_grid >= 0.0)
    assert np.max(chm_grid) > 10.0 # Tree canopy detected
    assert np.array_equal(result["buffered_elevation"], dtm_grid)


def test_preset_tiles_pre_cached_dtm_and_dsm():
    """
    Verifies that default preset locations (Montreal & Sainte-Lucie) have co-registered
    DTM and DSM tiles pre-cached, enabling instant window extraction with tree canopy data.
    """
    from backend.app.services.elevation.local_geotiff import LocalGeoTIFFProvider
    from backend.app.constants import TEST_LOCATION_PRESETS

    provider = LocalGeoTIFFProvider()

    for preset_key in ["montreal", "sainte-lucie"]:
        cfg = TEST_LOCATION_PRESETS[preset_key]
        c_lon = cfg["center_lon"]
        c_lat = cfg["center_lat"]
        delta = 0.001

        res = provider.get_elevation_window(
            min_lon=c_lon - delta,
            min_lat=c_lat - delta,
            max_lon=c_lon + delta,
            max_lat=c_lat + delta,
            buffer_meters=100.0,
            target_resolution_m=1.0
        )

        assert res["has_canopy"] is True, f"Preset {preset_key} must have canopy data"
        assert res["dsm_tile_source"] is not None
        assert np.all(res["dsm"] >= res["dtm"] - 1e-4)
        assert np.max(res["chm"]) > 0.0, f"Preset {preset_key} should have elevated structures/trees"

