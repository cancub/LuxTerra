"""
Unit tests for TileCacheManager dual-layer (DTM and DSM) storage and pairing.
"""

from pathlib import Path
import numpy as np
import rasterio
from rasterio.transform import from_origin
import pytest

from backend.app.services.elevation.tile_cache import TileCacheManager


def create_dummy_raster(path: Path, width=50, height=50, crs="EPSG:32618", bounds=(600000, 5000000)):
    min_x, max_y = bounds
    res = 1.0
    transform = from_origin(min_x, max_y, res, res)
    data = np.ones((height, width), dtype=np.float32) * 100.0
    
    path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(
        path,
        'w',
        driver='GTiff',
        height=height,
        width=width,
        count=1,
        dtype=np.float32,
        crs=crs,
        transform=transform,
        nodata=-9999.0
    ) as dst:
        dst.write(data, 1)


def test_tile_cache_dual_directories(tmp_path):
    cache = TileCacheManager(cache_dir=tmp_path / "dtm", dsm_dir=tmp_path / "dsm")
    assert cache.cache_dir.exists()
    assert cache.dsm_dir.exists()
    assert cache.cache_dir.name == "dtm"
    assert cache.dsm_dir.name == "dsm"


def test_manifest_pairs_dtm_and_dsm(tmp_path):
    cache = TileCacheManager(cache_dir=tmp_path / "dtm", dsm_dir=tmp_path / "dsm")
    
    # Create matching DTM and DSM tiles
    dtm_file = cache.cache_dir / "dtm_sample.tif"
    dsm_file = cache.dsm_dir / "dsm_sample.tif"
    create_dummy_raster(dtm_file)
    create_dummy_raster(dsm_file)
    
    manifest = cache.update_manifest()
    assert len(manifest["tiles"]) == 1
    tile = manifest["tiles"][0]
    assert tile["filename"] == "dtm_sample.tif"
    assert tile["has_dsm"] is True
    assert tile["dsm_filename"] == "dsm_sample.tif"


def test_manifest_handles_missing_dsm(tmp_path):
    cache = TileCacheManager(cache_dir=tmp_path / "dtm", dsm_dir=tmp_path / "dsm")
    
    dtm_file = cache.cache_dir / "dtm_lonely.tif"
    create_dummy_raster(dtm_file)
    
    manifest = cache.update_manifest()
    assert len(manifest["tiles"]) == 1
    tile = manifest["tiles"][0]
    assert tile["filename"] == "dtm_lonely.tif"
    assert tile["has_dsm"] is False
    assert tile["dsm_filename"] is None


def test_get_tile_pair_lookup(tmp_path):
    cache = TileCacheManager(cache_dir=tmp_path / "dtm", dsm_dir=tmp_path / "dsm")
    
    dtm_file = cache.cache_dir / "dtm_mtl.tif"
    dsm_file = cache.dsm_dir / "dsm_mtl.tif"
    create_dummy_raster(dtm_file)
    create_dummy_raster(dsm_file)
    cache.update_manifest()
    
    manifest = cache.load_manifest()
    tile = manifest["tiles"][0]
    min_lon, min_lat, max_lon, max_lat = tile["bounds_wgs84"]
    
    center_lon = (min_lon + max_lon) / 2.0
    center_lat = (min_lat + max_lat) / 2.0
    delta = 0.0001
    
    dtm_found, dsm_found = cache.get_tile_pair(
        center_lon - delta, center_lat - delta, center_lon + delta, center_lat + delta
    )
    
    assert dtm_found is not None and dtm_found.exists()
    assert dsm_found is not None and dsm_found.exists()
    assert dtm_found.name == "dtm_mtl.tif"
    assert dsm_found.name == "dsm_mtl.tif"
