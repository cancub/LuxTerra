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
    
    assert 60.0 <= angles.elevation_deg <= 70.0
    assert 160.0 <= angles.azimuth_deg <= 200.0
    assert pytest.approx(angles.zenith_deg + angles.elevation_deg, abs=0.1) == 90.0
    assert pytest.approx(angles.optimal_tilt_deg, abs=0.1) == angles.zenith_deg
    assert angles.incident_angle_deg < 15.0


def test_solar_angles_winter_solstice():
    # Montreal on December 21 at solar noon (12:00 EST)
    dt = datetime(2026, 12, 21, 12, 0, tzinfo=TZ_QC)
    angles = compute_solar_angles(dt, 45.503, -73.618)
    
    assert 18.0 <= angles.elevation_deg <= 25.0
    assert 160.0 <= angles.azimuth_deg <= 200.0
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
    irradiance = engine.calculate_irradiance(dt, 45.503, -73.618, angles, altitude_m=125.0)
    
    assert irradiance.dni_w_m2 > 700.0
    assert irradiance.dhi_w_m2 > 50.0
    assert irradiance.poa_direct_w_m2 > 700.0
    assert irradiance.poa_diffuse_w_m2 > 40.0
    assert irradiance.poa_global_w_m2 > 800.0


def test_altitude_increases_clear_sky_dni():
    """
    Higher elevations (e.g. 500m in Laurentians) have thinner atmospheric airmass columns,
    resulting in higher direct normal irradiance (DNI).
    """
    engine = PvlibSolarEngine()
    dt = datetime(2026, 6, 21, 13, 0, tzinfo=TZ_QC)
    angles = engine.calculate_solar_angles(dt, 46.136, -74.195)
    
    irr_sea_level = engine.calculate_irradiance(dt, 46.136, -74.195, angles, altitude_m=0.0)
    irr_mountain = engine.calculate_irradiance(dt, 46.136, -74.195, angles, altitude_m=500.0)

    assert irr_mountain.dni_w_m2 > irr_sea_level.dni_w_m2


def test_fixed_seasonal_tilt_across_day():
    """
    Seasonal optimal tilt must remain constant across all frames of the day,
    ensuring afternoon/evening sun facing a south-oriented panel is not artificially
    zeroed out by near-vertical tilts.
    """
    engine = PvlibSolarEngine()
    import pandas as pd
    times = pd.date_range("2026-06-21 06:00", "2026-06-21 20:00", freq="1h", tz=TZ_QC)
    angles_list = engine.calculate_solar_angles_series(times, 46.136, -74.195)
    
    first_tilt = angles_list[0].optimal_tilt_deg
    assert 20.0 <= first_tilt <= 25.0
    for a in angles_list:
        assert a.optimal_tilt_deg == first_tilt
    
    # At 18:27 (or 18:00), AOI should be < 90° so direct irradiance reaches the front face
    angle_1800 = next(a for a, t in zip(angles_list, times) if t.hour == 18)
    assert angle_1800.incident_angle_deg < 90.0


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
