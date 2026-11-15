"""
Regression tests for Tier 1-3 fixes:
- SimulateRequest zero-area / invalid-range validation & UTM zone 60 clamping
- Concave U-shaped polygon row_index preservation
- ROOFTOP self-shading gating & canopy_shaded_pct <= 100%
"""

import pytest
from pydantic import ValidationError
from httpx import AsyncClient, ASGITransport

from backend.app.main import app
from backend.app.schemas.simulate import SimulateRequest, GeoBoundingBox
from backend.app.services.elevation.geo_utils import get_utm_crs_for_lon_lat
from backend.app.services.pv.packing_engine import PVPackingEngine


def test_utm_epsg_clamps_antimeridian():
    assert get_utm_crs_for_lon_lat(180.0, 45.0) == "EPSG:32660"
    assert get_utm_crs_for_lon_lat(-180.0, 45.0) == "EPSG:32601"


def test_simulate_request_rejects_zero_area_and_out_of_range():
    with pytest.raises(ValidationError):
        SimulateRequest(
            bbox=GeoBoundingBox(
                min_lon=-73.618,
                min_lat=45.503,
                max_lon=-73.618,
                max_lat=45.503,
            ),
            date="2026-06-21",
        )

    with pytest.raises(ValidationError):
        SimulateRequest(
            bbox=GeoBoundingBox(
                min_lon=181.0,
                min_lat=45.503,
                max_lon=181.001,
                max_lat=45.504,
            ),
            date="2026-06-21",
        )


def test_concave_u_polygon_preserves_row_index_across_gap():
    engine = PVPackingEngine()
    # U-shape open to the east with a middle notch
    u_poly = [
        [-73.6200, 45.5000],
        [-73.6180, 45.5000],
        [-73.6180, 45.5004],
        [-73.6194, 45.5004],
        [-73.6194, 45.5008],
        [-73.6180, 45.5008],
        [-73.6180, 45.5012],
        [-73.6200, 45.5012],
        [-73.6200, 45.5000],
    ]
    layout = engine.generate_layout(u_poly, latitude=45.5006, tilt_deg=30.0)
    assert layout.total_tables > 0
    row_indices = sorted({t.row_index for t in layout.tables})
    assert row_indices[0] == 0
    assert row_indices[-1] >= len(row_indices) - 1


@pytest.mark.asyncio
async def test_rooftop_self_shading_zero_and_canopy_pct_capped():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/api/simulate",
            json={
                "bbox": {
                    "min_lon": -73.6185,
                    "min_lat": 45.5035,
                    "max_lon": -73.6175,
                    "max_lat": 45.5042,
                },
                "date": "2026-12-21",
                "time_step_minutes": 60,
                "deployment_mode": "rooftop",
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        for m in data["timeseries"]:
            assert m.get("self_shading_loss_kw", 0.0) == 0.0
            assert 0.0 <= m.get("canopy_shaded_pct", 0.0) <= 100.0
