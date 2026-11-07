"""
Unit and integration tests for LuxTerra Elevation & DTM Pipeline.
"""

import pytest
import numpy as np
from pathlib import Path

from backend.app.services.elevation.geo_utils import (
    get_utm_crs_for_lon_lat,
    calculate_bbox_area_meters,
    buffer_bounding_box_meters
)
from backend.app.services.elevation.tile_cache import TileCacheManager
from backend.app.services.elevation.local_geotiff import LocalGeoTIFFProvider
from scripts.fetch_test_dtm import fetch_preset, PRESETS


def test_utm_crs_resolution():
    # Montreal (-73.618, 45.503) should be Zone 18N (EPSG:32618)
    crs_mtl = get_utm_crs_for_lon_lat(-73.618, 45.503)
    assert crs_mtl == "EPSG:32618"
    
    # Gaspe Peninsula (-65.0, 48.5) should be Zone 20N (EPSG:32620)
    crs_gaspe = get_utm_crs_for_lon_lat(-65.0, 48.5)
    assert crs_gaspe == "EPSG:32620"


def test_bbox_area_calculation():
    # Small test box ~100m x ~100m near Montreal
    # 0.001 deg lat is ~111m, 0.0014 deg lon at 45.5N is ~110m
    min_lon, min_lat = -73.618, 45.503
    max_lon, max_lat = -73.6166, 45.504
    area = calculate_bbox_area_meters(min_lon, min_lat, max_lon, max_lat)
    assert 10000.0 < area < 15000.0


def test_buffer_bounding_box_500m():
    # Test that buffering adds exactly 500m to each side (1000m total width & height expansion)
    min_lon, min_lat = -73.618, 45.503
    max_lon, max_lat = -73.6166, 45.504
    
    info = buffer_bounding_box_meters(min_lon, min_lat, max_lon, max_lat, buffer_meters=500.0)
    
    pw = info["patch_width_m"]
    ph = info["patch_height_m"]
    bw = info["buffered_width_m"]
    bh = info["buffered_height_m"]
    
    # Buffer should add 1000m to width and height
    assert pytest.approx(bw, abs=1.0) == pw + 1000.0
    assert pytest.approx(bh, abs=1.0) == ph + 1000.0


def test_tile_cache_and_manifest(tmp_path):
    cache = TileCacheManager(cache_dir=tmp_path)
    manifest = cache.load_manifest()
    assert "tiles" in manifest
    assert len(manifest["tiles"]) == 0


def test_elevation_window_extraction(tmp_path):
    # Prepare cache with Montreal test tile
    cache = TileCacheManager(cache_dir=tmp_path)
    fetch_preset("montreal", cache, force_synthetic=True)
    
    provider = LocalGeoTIFFProvider(cache_manager=cache)
    
    # Query a 100m patch centered near Édouard-Montpetit
    center_lon, center_lat = -73.618, 45.503
    # ~100m square
    delta = 0.0006
    result = provider.get_elevation_window(
        min_lon=center_lon - delta,
        min_lat=center_lat - delta,
        max_lon=center_lon + delta,
        max_lat=center_lat + delta,
        buffer_meters=500.0
    )
    
    assert "buffered_elevation" in result
    elev = result["buffered_elevation"]
    assert isinstance(elev, np.ndarray)
    assert elev.ndim == 2
    
    # Buffered width should be ~100m patch + 1000m buffer ≈ 1100 cells at 1m res
    h, w = elev.shape
    assert 1000 <= w <= 1200
    assert 1000 <= h <= 1200
    
    # Elevation on Mount Royal northern flank should be between 80m and 233m
    median_elev = result["median_elevation_m"]
    assert 80.0 <= median_elev <= 233.0
    
    # Check patch slice
    slice_y = result["patch_slice_y"]
    slice_x = result["patch_slice_x"]
    patch_cells = elev[slice_y, slice_x]
    assert patch_cells.size > 0
    assert np.all(patch_cells > 0)
