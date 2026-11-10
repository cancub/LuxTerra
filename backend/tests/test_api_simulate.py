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
        assert all(s["geological_loss_kw"] == 0.0 for s in night_steps)
        
        # Verify stacked subtraction identity: unshaded - geological - canopy ≈ power_kw
        for s in daylight_steps:
            assert "geological_loss_kw" in s
            reconstructed_power = s["unshaded_power_kw"] - s["geological_loss_kw"] - s["canopy_loss_kw"]
            assert pytest.approx(reconstructed_power, abs=0.2) == s["power_kw"]

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
            "time_step_minutes": 30,
            "include_tree_canopy": False
        }

        # Rooftop (GCR = 1.0)
        res_rooftop = await client.post("/api/simulate", json={**base_payload, "deployment_mode": "rooftop"})
        assert res_rooftop.status_code == 200
        kwh_rooftop = res_rooftop.json()["daily_summary"]["total_daily_kwh"]

        # Ground-mount (GCR = 0.45)
        res_ground = await client.post("/api/simulate", json={**base_payload, "deployment_mode": "ground_mount"})
        assert res_ground.status_code == 200
        kwh_ground = res_ground.json()["daily_summary"]["total_daily_kwh"]

        # Bare-terrain ground mount should produce exactly 45% of rooftop output
        assert pytest.approx(kwh_ground / kwh_rooftop, abs=0.01) == 0.45

        # With canopy enabled, ground-mount suffers additional structure/canopy shade compared to rooftop
        res_canopy_ground = await client.post("/api/simulate", json={**base_payload, "include_tree_canopy": True, "deployment_mode": "ground_mount"})
        assert res_canopy_ground.status_code == 200
        kwh_canopy_ground = res_canopy_ground.json()["daily_summary"]["total_daily_kwh"]
        assert kwh_canopy_ground < kwh_ground


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
        assert "night_mask" in data
        assert data["night_mask"] is not None
        assert len(data["night_mask"]) > 0


@pytest.mark.asyncio
async def test_simulate_tree_canopy_dual_masks():
    """
    Test simulation with tree canopy enabled.
    Verifies that dual-channel masks (masks + canopy_masks), phenology transmittance,
    and canopy summary metrics are present and populated.
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
            "time_step_minutes": 15,
            "include_tree_canopy": True,
            "canopy_mode": "seasonal",
            "deployment_mode": "ground_mount"
        }
        response = await client.post("/api/simulate", json=payload)
        assert response.status_code == 200
        data = response.json()

        # Check metadata
        meta = data["metadata"]
        assert meta["include_tree_canopy"] is True
        assert meta["canopy_mode"] == "seasonal"
        assert meta["has_canopy_data"] is True
        assert meta["dsm_tile_source"] is not None

        # Check dual mask arrays
        assert "masks" in data
        assert "canopy_masks" in data
        assert len(data["masks"]) == len(data["canopy_masks"])
        assert len(data["masks"]) > 0

        # Check phenology transmittance (summer = 0.15)
        assert data["canopy_transmittance"] == 0.15
        assert "night_canopy_mask" in data
        assert data["night_canopy_mask"] is not None
        assert "chm_base64" in data
        assert data["chm_base64"] is not None
        assert len(data["chm_base64"]) > 0

        # Check daily summary
        summary = data["daily_summary"]
        assert "avg_canopy_shaded_pct" in summary
        assert summary["avg_canopy_shaded_pct"] >= 0.0
        assert "unshaded_daily_kwh" in summary
        assert "canopy_loss_kwh" in summary
        assert "canopy_loss_pct" in summary
        assert summary["unshaded_daily_kwh"] >= summary["total_daily_kwh"]
        assert summary["canopy_loss_kwh"] >= 0.0

        # Check timeseries metric fields
        first_daylight = next(m for m in data["timeseries"] if m["is_daylight"])
        assert "canopy_shaded_pct" in first_daylight
        assert first_daylight["canopy_shaded_pct"] >= 0.0
        assert "unshaded_power_kw" in first_daylight
        assert "canopy_loss_kw" in first_daylight
        assert first_daylight["unshaded_power_kw"] >= first_daylight["power_kw"]
        assert first_daylight["canopy_loss_kw"] >= 0.0


@pytest.mark.asyncio
async def test_simulate_urban_forest_seasonal_leaf_on_vs_leaf_off():
    """
    Test urban forest canopy shading under summer leaf-on vs winter leaf-off phenology.
    Verifies that bare branches (leaf-off, tau=0.60) transmit more solar irradiance
    than dense summer foliage (leaf-on, tau=0.15) for identical solar geometry.
    """
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
            "time_step_minutes": 15,
            "include_tree_canopy": True,
            "deployment_mode": "ground_mount"
        }

        # Summer leaf-on
        res_summer = await client.post("/api/simulate", json={**base_payload, "canopy_mode": "leaf_on"})
        assert res_summer.status_code == 200
        data_summer = res_summer.json()
        assert data_summer["canopy_transmittance"] == 0.15

        # Winter leaf-off override on same summer day (to isolate phenology transmission from solar elevation)
        res_winter = await client.post("/api/simulate", json={**base_payload, "canopy_mode": "leaf_off"})
        assert res_winter.status_code == 200
        data_winter = res_winter.json()
        assert data_winter["canopy_transmittance"] == 0.60

        # Bare branches must yield higher daily power than full summer foliage
        kwh_summer = data_summer["daily_summary"]["total_daily_kwh"]
        kwh_winter = data_winter["daily_summary"]["total_daily_kwh"]
        assert kwh_winter > kwh_summer, f"Winter bare branches ({kwh_winter} kWh) should exceed summer leaf-on ({kwh_summer} kWh)"


@pytest.mark.asyncio
async def test_simulate_canopy_performance_benchmark():
    """
    Benchmark full 24-hour simulation latency with dual-surface GPU ray-marching enabled.
    Ensures total execution time stays well below 600ms for a 15-minute resolution day.
    """
    import time
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
            "time_step_minutes": 15,
            "include_tree_canopy": True,
            "deployment_mode": "rooftop"
        }

        start = time.perf_counter()
        response = await client.post("/api/simulate", json=payload)
        elapsed_ms = (time.perf_counter() - start) * 1000.0

        assert response.status_code == 200
        assert elapsed_ms < 600.0, f"Simulation latency {elapsed_ms:.1f}ms exceeds 600ms threshold"


@pytest.mark.asyncio
async def test_simulate_geological_shade_not_overlapped_by_canopy():
    """
    Verifies that enabling tree canopy shading does not reduce, overlap, or alter
    geological terrain shadow masks. Terrain masks and geological shade metrics
    must be bit-for-bit identical whether canopy is toggled ON or OFF.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        base_payload = {
            "bbox": {
                "min_lon": -74.196,
                "min_lat": 46.135,
                "max_lon": -74.194,
                "max_lat": 46.137
            },
            "date": "2026-12-21",
            "time_step_minutes": 30,
            "deployment_mode": "ground_mount"
        }

        for mode in ["ground_mount", "rooftop"]:
            # Simulation with canopy OFF
            res_off = await client.post("/api/simulate", json={**base_payload, "deployment_mode": mode, "include_tree_canopy": False})
            assert res_off.status_code == 200
            data_off = res_off.json()

            # Simulation with canopy ON
            res_on = await client.post("/api/simulate", json={**base_payload, "deployment_mode": mode, "include_tree_canopy": True})
            assert res_on.status_code == 200
            data_on = res_on.json()

            # 1. Terrain masks must be bit-for-bit identical between canopy OFF and canopy ON
            assert len(data_off["masks"]) == len(data_on["masks"])
            for i, (m_off, m_on) in enumerate(zip(data_off["masks"], data_on["masks"])):
                assert m_off == m_on, f"Terrain mask at daylight frame {i} changed when canopy was toggled for {mode}!"

            # 2. Geological loss kW and percent_shaded must be identical
            for s_off, s_on in zip(data_off["timeseries"], data_on["timeseries"]):
                assert pytest.approx(s_off["geological_loss_kw"], abs=0.01) == s_on["geological_loss_kw"]
                assert pytest.approx(s_off["percent_shaded"], abs=0.01) == s_on["percent_shaded"]


@pytest.mark.asyncio
async def test_discrete_panel_shade_matches_physical_panels():
    """
    Verifies that when ground-mount panels are simulated in an oblong polygon,
    shade loss is calculated on the physical solar panels rather than empty ground.
    Specifically:
    1. Subtraction stack holds strictly: unshaded_power_kw - geological_loss_kw - canopy_loss_kw - self_shading_loss_kw == power_kw
    2. Total panels and installed DC kW are populated.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        payload = {
            "bbox": {
                "min_lon": -74.154,
                "min_lat": 46.037,
                "max_lon": -74.151,
                "max_lat": 46.039
            },
            "polygon": [
                [-74.1535, 46.0375],
                [-74.1515, 46.0378],
                [-74.1512, 46.0388],
                [-74.1532, 46.0385]
            ],
            "date": "2026-06-21",
            "time_step_minutes": 15,
            "deployment_mode": "ground_mount",
            "include_tree_canopy": True
        }
        res = await client.post("/api/simulate", json=payload)
        assert res.status_code == 200
        data = res.json()

        summary = data["daily_summary"]
        assert summary["total_panels"] > 0
        assert summary["installed_dc_kw"] > 0

        for t in data["timeseries"]:
            if t["is_daylight"]:
                expected_power = t["unshaded_power_kw"] - t["geological_loss_kw"] - t["canopy_loss_kw"] - t["self_shading_loss_kw"]
                assert abs(expected_power - t["power_kw"]) < 0.005, f"Subtraction stack mismatch at {t['timestamp']}: expected {expected_power}, got {t['power_kw']}"


@pytest.mark.asyncio
async def test_simulate_with_visual_context_boundary():
    """
    Verifies that supplying an outer context_bbox expands the visualization patch
    while keeping the solar layout and power metrics strictly confined to the interior solar array.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # Solar array on Sainte-Lucie field
        solar_bbox = {
            "min_lon": -74.153,
            "min_lat": 46.0375,
            "max_lon": -74.152,
            "max_lat": 46.0385
        }
        # Outer visual context envelope
        context_bbox = {
            "min_lon": -74.154,
            "min_lat": 46.037,
            "max_lon": -74.151,
            "max_lat": 46.039
        }

        # 1. Base simulation (array only)
        res_base = await client.post("/api/simulate", json={
            "bbox": solar_bbox,
            "date": "2026-06-21",
            "time_step_minutes": 30,
            "deployment_mode": "ground_mount"
        })
        assert res_base.status_code == 200
        data_base = res_base.json()

        # 2. Simulation with context envelope
        res_context = await client.post("/api/simulate", json={
            "bbox": solar_bbox,
            "context_bbox": context_bbox,
            "date": "2026-06-21",
            "time_step_minutes": 30,
            "deployment_mode": "ground_mount"
        })
        assert res_context.status_code == 200
        data_context = res_context.json()

        # Context metadata should reflect the larger patch dimensions
        assert data_context["metadata"]["patch_width_m"] > data_base["metadata"]["patch_width_m"]
        assert data_context["metadata"]["patch_height_m"] > data_base["metadata"]["patch_height_m"]

        # Solar panel count and installed capacity must be strictly identical
        assert data_context["daily_summary"]["total_panels"] == data_base["daily_summary"]["total_panels"]
        assert data_context["daily_summary"]["installed_dc_kw"] == data_base["daily_summary"]["installed_dc_kw"]

        # 3D layout bounds must remain within the interior solar_bbox
        for tbl in data_context["layout"]["tables"]:
            c_lon, c_lat = tbl["center_wgs84"]
            assert solar_bbox["min_lon"] - 0.0005 <= c_lon <= solar_bbox["max_lon"] + 0.0005
            assert solar_bbox["min_lat"] - 0.0005 <= c_lat <= solar_bbox["max_lat"] + 0.0005






