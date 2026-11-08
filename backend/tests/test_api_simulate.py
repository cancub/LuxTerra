"""
End-to-end integration tests for FastAPI REST API endpoints.
Tests health check, location presets, manifest, and full-day batch simulation.
"""

import pytest
from httpx import AsyncClient, ASGITransport

from backend.app.main import app
from backend.app.services.serializer import decode_mask_bitmask


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.asyncio
async def test_health_check_endpoint():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert data["gpu_available"] is True
        assert "RTX 4070 Ti" in (data["gpu_device"] or "")


@pytest.mark.asyncio
async def test_elevation_locations_endpoint():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/elevation/locations")
        assert response.status_code == 200
        data = response.json()
        assert "locations" in data
        assert len(data["locations"]) == 2
        
        loc_ids = [loc["id"] for loc in data["locations"]]
        assert "montreal" in loc_ids
        assert "sainte-lucie" in loc_ids
        
        # Verify both have local cached DTMs
        assert all(loc["is_cached"] for loc in data["locations"])


@pytest.mark.asyncio
async def test_elevation_manifest_endpoint():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/elevation/manifest")
        assert response.status_code == 200
        data = response.json()
        assert "tiles" in data
        assert len(data["tiles"]) >= 2


@pytest.mark.asyncio
async def test_elevation_status_endpoint():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/elevation/status")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ready"
        assert data["cached_tile_count"] >= 2
        assert len(data["locations"]) == 2
        assert len(data["tiles"]) >= 2


@pytest.mark.asyncio
async def test_simulate_montreal_full_day():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        payload = {
            "bbox": {
                "min_lon": -73.619,
                "min_lat": 45.502,
                "max_lon": -73.617,
                "max_lat": 45.504
            },
            "date": "2026-06-21",
            "time_step_minutes": 15, # 15-minute intervals
            "deployment_mode": "rooftop",
            "module_efficiency": 0.20,
            "system_derate": 0.80
        }

        response = await client.post("/api/simulate", json=payload)
        assert response.status_code == 200
        data = response.json()

        # 1. Metadata checks
        meta = data["metadata"]
        assert meta["patch_area_m2"] > 0.0
        assert meta["patch_area_m2"] <= 100000.0
        assert meta["grid_rows"] > 0
        assert meta["grid_cols"] > 0
        assert meta["date"] == "2026-06-21"
        assert meta["time_step_minutes"] == 15
        assert meta["deployment_mode"] == "rooftop"
        assert "patch_bounds_wgs84" in meta
        assert len(meta["patch_bounds_wgs84"]) == 4
        # Bounds should approximate requested bbox
        assert pytest.approx(meta["patch_bounds_wgs84"][0], abs=0.001) == -73.619
        assert pytest.approx(meta["patch_bounds_wgs84"][1], abs=0.001) == 45.502

        # 2. Daily summary checks
        summary = data["daily_summary"]
        assert summary["total_daily_kwh"] > 0.0
        assert summary["peak_power_kw"] > 0.0
        assert summary["daylight_hours"] > 14.0 # June 21 in Quebec has ~15.5h daylight
        assert summary["sunrise_time"] is not None
        assert summary["sunset_time"] is not None

        # 3. Timeseries checks
        timeseries = data["timeseries"]
        # 24 hours * 4 steps/hour = 96 steps
        assert len(timeseries) == 96

        daylight_steps = [s for s in timeseries if s["is_daylight"]]
        night_steps = [s for s in timeseries if not s["is_daylight"]]

        assert len(daylight_steps) > 50
        assert len(night_steps) > 0
        assert all(s["power_kw"] == 0.0 for s in night_steps)
        assert all(s["percent_shaded"] == 100.0 for s in night_steps)

        # 4. Mask decoding checks
        masks = data["masks"]
        assert len(masks) == len(daylight_steps)

        shape = (meta["grid_rows"], meta["grid_cols"])
        first_mask = decode_mask_bitmask(masks[0], shape)
        assert first_mask.shape == shape
        assert set(first_mask.ravel()).issubset({0, 1})


@pytest.mark.asyncio
async def test_simulate_rooftop_vs_ground_gcr_scaling():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        base_payload = {
            "bbox": {
                "min_lon": -73.619,
                "min_lat": 45.502,
                "max_lon": -73.617,
                "max_lat": 45.504
            },
            "date": "2026-06-21",
            "time_step_minutes": 30
        }

        # Rooftop (GCR = 1.0)
        res_rooftop = await client.post("/api/simulate", json={**base_payload, "deployment_mode": "rooftop"})
        assert res_rooftop.status_code == 200
        kwh_rooftop = res_rooftop.json()["daily_summary"]["total_daily_kwh"]

        # Ground-mount (GCR = 0.45)
        res_ground = await client.post("/api/simulate", json={**base_payload, "deployment_mode": "ground_mount"})
        assert res_ground.status_code == 200
        kwh_ground = res_ground.json()["daily_summary"]["total_daily_kwh"]

        # Ground mount should produce exactly 45% of rooftop output
        assert pytest.approx(kwh_ground / kwh_rooftop, abs=0.01) == 0.45


@pytest.mark.asyncio
async def test_simulate_area_limit_rejection():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # ~1km x 1km = 1,000,000 m² > 100,000 m²
        payload = {
            "bbox": {
                "min_lon": -73.63,
                "min_lat": 45.50,
                "max_lon": -73.61,
                "max_lat": 45.51
            },
            "date": "2026-06-21"
        }
        response = await client.post("/api/simulate", json=payload)
        assert response.status_code == 422
        assert "exceeds the maximum allowable limit" in response.text


@pytest.mark.asyncio
async def test_simulate_missing_coverage_returns_404():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # Location outside Canadian LiDAR coverage (~10,689 m²)
        payload = {
            "bbox": {
                "min_lon": -50.001,
                "min_lat": 30.001,
                "max_lon": -50.0,
                "max_lat": 30.002
            },
            "date": "2026-06-21"
        }
        response = await client.post("/api/simulate", json=payload)
        assert response.status_code == 404
        assert "outside official NRCan HRDEM LiDAR coverage" in response.text


@pytest.mark.asyncio
async def test_simulate_on_demand_laval_acquisition():
    """
    Test dynamic on-demand acquisition of 1m LiDAR data for Laval via NRCan STAC and COG streaming.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # Laval: Montmorency area (~52,000 m²)
        payload = {
            "bbox": {
                "min_lon": -73.722,
                "min_lat": 45.556,
                "max_lon": -73.719,
                "max_lat": 45.558
            },
            "date": "2026-06-21"
        }
        response = await client.post("/api/simulate", json=payload)
        assert response.status_code == 200
        data = response.json()
        assert data["metadata"]["patch_area_m2"] > 0
        assert "dtm" in data["metadata"]["tile_source"]
        assert len(data["timeseries"]) == 1440
        assert data["daily_summary"]["total_daily_kwh"] > 0


@pytest.mark.asyncio
async def test_simulate_dst_transition_date():
    """
    Test simulation on Daylight Saving Time transition date (Nov 1, 2026 - Fall back).
    Ensures date range generation handles 25-hour day smoothly without exceptions.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        payload = {
            "bbox": {
                "min_lon": -73.619,
                "min_lat": 45.502,
                "max_lon": -73.617,
                "max_lat": 45.504
            },
            "date": "2026-11-01",
            "time_step_minutes": 30
        }
        response = await client.post("/api/simulate", json=payload)
        assert response.status_code == 200
        data = response.json()
        assert data["daily_summary"]["total_daily_kwh"] > 0.0
        assert len(data["timeseries"]) > 40


@pytest.mark.asyncio
async def test_simulate_one_minute_intervals():
    """
    Test simulation with default 1-minute increments (1,440 timesteps over full 24-hour day).
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        payload = {
            "bbox": {
                "min_lon": -73.619,
                "min_lat": 45.502,
                "max_lon": -73.617,
                "max_lat": 45.504
            },
            "date": "2026-06-21",
            "time_step_minutes": 1
        }
        response = await client.post("/api/simulate", json=payload)
        assert response.status_code == 200
        data = response.json()
        assert data["metadata"]["time_step_minutes"] == 1
        assert len(data["timeseries"]) == 1440
        assert len(data["masks"]) > 900


@pytest.mark.asyncio
async def test_simulate_oblong_polygon_shape():
    """
    Test simulation with custom oblong multi-point polygon boundary within bounding box.
    Verifies that patch_area_m2 reflects the exact polygon area (~10,000 m²) rather than full bbox.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        triangle = [
            [-73.619, 45.502],
            [-73.617, 45.502],
            [-73.619, 45.503]
        ]
        payload = {
            "bbox": {
                "min_lon": -73.619,
                "min_lat": 45.502,
                "max_lon": -73.617,
                "max_lat": 45.504
            },
            "polygon": triangle,
            "date": "2026-06-21",
            "time_step_minutes": 15
        }
        response = await client.post("/api/simulate", json=payload)
        assert response.status_code == 200
        data = response.json()
        meta = data["metadata"]
        assert meta["patch_area_m2"] < 25000.0 # Triangle is ~8,000 m², well below 35,000 m² bbox
        assert data["daily_summary"]["total_daily_kwh"] > 0.0

