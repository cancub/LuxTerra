"""
Unit tests for solar geometry and Ineichen clear-sky irradiance engine.
"""

import pytest
from datetime import datetime
import zoneinfo

from backend.app.services.solar.geometry import compute_solar_angles
from backend.app.services.solar.pvlib_engine import PvlibSolarEngine

TZ_QC = zoneinfo.ZoneInfo("America/Toronto")


def test_solar_angles_summer_solstice():
    # Montreal (45.503° N, -73.618° W) on June 21 at approx solar noon (13:00 EDT)
    dt = datetime(2026, 6, 21, 13, 0, tzinfo=TZ_QC)
    angles = compute_solar_angles(dt, 45.503, -73.618)
    
    # Summer solstice noon sun in Montreal is high (> 60°)
    assert 60.0 <= angles.elevation_deg <= 70.0
    assert 160.0 <= angles.azimuth_deg <= 200.0 # Facing south
    assert pytest.approx(angles.zenith_deg + angles.elevation_deg, abs=0.1) == 90.0
    assert angles.optimal_tilt_deg == angles.zenith_deg
    
    # Near solar noon with tilt matching zenith and south azimuth, incident angle should be small
    assert angles.incident_angle_deg < 15.0


def test_solar_angles_winter_solstice():
    # Montreal on December 21 at solar noon (12:00 EST)
    dt = datetime(2026, 12, 21, 12, 0, tzinfo=TZ_QC)
    angles = compute_solar_angles(dt, 45.503, -73.618)
    
    # Winter solstice noon sun is low (20° - 25°)
    assert 18.0 <= angles.elevation_deg <= 25.0
    assert 160.0 <= angles.azimuth_deg <= 200.0
    # Optimal tilt is steep in winter (~65° - 72°)
    assert 65.0 <= angles.optimal_tilt_deg <= 72.0


def test_solar_angles_midnight():
    # Montreal at midnight (sun below horizon)
    dt = datetime(2026, 6, 21, 0, 0, tzinfo=TZ_QC)
    angles = compute_solar_angles(dt, 45.503, -73.618)
    
    assert angles.elevation_deg < 0.0
    assert angles.incident_angle_deg == 90.0


def test_ineichen_clear_sky_irradiance():
    engine = PvlibSolarEngine()
    
    # Summer noon in Montreal
    dt = datetime(2026, 6, 21, 13, 0, tzinfo=TZ_QC)
    angles = engine.calculate_solar_angles(dt, 45.503, -73.618)
    irradiance = engine.calculate_irradiance(dt, 45.503, -73.618, angles)
    
    assert irradiance.dni_w_m2 > 700.0
    assert irradiance.dhi_w_m2 > 50.0
    assert irradiance.poa_direct_w_m2 > 700.0
    assert irradiance.poa_diffuse_w_m2 > 40.0
    assert irradiance.poa_global_w_m2 > 800.0


def test_night_irradiance_zero():
    engine = PvlibSolarEngine()
    dt = datetime(2026, 6, 21, 0, 0, tzinfo=TZ_QC)
    angles = engine.calculate_solar_angles(dt, 45.503, -73.618)
    irradiance = engine.calculate_irradiance(dt, 45.503, -73.618, angles)
    
    assert irradiance.dni_w_m2 == 0.0
    assert irradiance.dhi_w_m2 == 0.0
    assert irradiance.poa_direct_w_m2 == 0.0
    assert irradiance.poa_diffuse_w_m2 == 0.0
    assert irradiance.poa_global_w_m2 == 0.0
