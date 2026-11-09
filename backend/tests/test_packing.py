"""
Unit and integration tests for PVPackingEngine and maximal solar panel distribution.
"""

import pytest
from shapely.geometry import Polygon as ShapelyPolygon

from backend.app.services.pv.packing_engine import (
    PVPackingEngine,
    calculate_winter_solstice_pitch
)
from backend.app.schemas.domain import GeoBoundingBox


def test_winter_solstice_pitch_calculation():
    """
    Verifies winter solstice solar noon self-shading clearance pitch.
    At latitude 46.12° N and 30° tilt:
    Solar noon elevation on Dec 21 is ~20.44°.
    Shadow length for 4.56m slant table is ~6.12m.
    Row depth is ~3.95m.
    Row pitch is ~10.57m, yielding ~43.1% physical GCR.
    """
    pitch, depth, gap = calculate_winter_solstice_pitch(
        latitude=46.12,
        tilt_deg=30.0,
        slant_height_m=4.56,
        stand_height_m=1.0,
        buffer_m=0.5
    )

    assert 10.4 <= pitch <= 10.8
    assert 3.8 <= depth <= 4.1
    assert 6.4 <= gap <= 6.8
    gcr = 4.56 / pitch
    assert 0.41 <= gcr <= 0.45


def test_winter_solstice_pitch_flat():
    """
    For flat horizontal panels (0° tilt), pitch equals slant height plus buffer.
    """
    pitch, depth, gap = calculate_winter_solstice_pitch(
        latitude=45.5,
        tilt_deg=0.0,
        slant_height_m=4.56,
        buffer_m=0.5
    )
    assert pitch == 5.06
    assert depth == 4.56
    assert gap == 0.5


def test_packing_engine_rectangular_bounds():
    """
    Verifies packing engine fills a rectangular bounding box with 2P tables
    oriented due South (180° azimuth) with realistic physical GCR.
    """
    engine = PVPackingEngine()
    bbox = GeoBoundingBox(min_lon=-73.619, min_lat=45.504, max_lon=-73.616, max_lat=45.506)
    
    result = engine.generate_layout(bbox, latitude=45.505, tilt_deg=30.0)

    assert result.total_panels > 500
    assert result.total_tables > 50
    assert pytest.approx(result.installed_dc_kw, abs=0.1) == result.total_panels * 0.55
    assert 0.30 <= result.physical_gcr <= 0.50
    assert len(result.tables) == result.total_tables

    # Verify table attributes and geometry
    first_table = result.tables[0]
    assert first_table.azimuth_deg == 180.0
    assert first_table.tilt_deg == 30.0
    assert first_table.stand_height_m == 1.0
    assert first_table.panel_count >= 4
    assert len(first_table.corners_wgs84) == 4
    for pt in first_table.corners_wgs84:
        assert -73.620 <= pt[0] <= -73.615
        assert 45.503 <= pt[1] <= 45.507


def test_packing_engine_oblong_polygon():
    """
    Verifies packing engine handles arbitrary irregular/oblong polygons,
    clamping tables inside the setback boundary without escaping.
    """
    engine = PVPackingEngine()
    oblong_coords = [
        [-74.196, 46.135],
        [-74.195, 46.1353],
        [-74.1935, 46.1358],
        [-74.1932, 46.136],
        [-74.1936, 46.1362],
        [-74.1952, 46.1359],
        [-74.1962, 46.1353],
        [-74.196, 46.135]
    ]

    result = engine.generate_layout(oblong_coords, latitude=46.136, tilt_deg=22.7)

    assert result.total_panels > 100
    assert result.total_tables > 10
    assert result.physical_gcr > 0.15

    # Check that all table centers lie within the bounding box of the oblong
    for t in result.tables:
        assert -74.197 <= t.center_wgs84[0] <= -74.192
        assert 46.134 <= t.center_wgs84[1] <= 46.137


def test_packing_engine_tiny_polygon_graceful_empty():
    """
    Verifies that a site too small to host even a minimum 2P table (e.g. 2m x 2m)
    returns an empty result (0 panels) without errors.
    """
    engine = PVPackingEngine()
    tiny_coords = [
        [-73.6180, 45.5040],
        [-73.61802, 45.5040],
        [-73.61802, 45.50402],
        [-73.6180, 45.50402],
        [-73.6180, 45.5040]
    ]
    result = engine.generate_layout(tiny_coords, latitude=45.5, tilt_deg=30.0)
    assert result.total_panels == 0
    assert result.total_tables == 0
    assert result.installed_dc_kw == 0.0
    assert len(result.tables) == 0
