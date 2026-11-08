import pytest
from datetime import date, datetime
from backend.app.services.solar.phenology import (
    calculate_canopy_transmittance,
    get_day_of_year,
    CanopyTransmittance
)


def test_fixed_modes():
    t_on = calculate_canopy_transmittance("2026-01-01", mode="leaf_on")
    assert t_on.direct == 0.15
    assert t_on.diffuse == 0.25
    assert t_on.season_name == "leaf_on"

    t_off = calculate_canopy_transmittance("2026-07-01", mode="leaf_off")
    assert t_off.direct == 0.60
    assert t_off.diffuse == 0.70
    assert t_off.season_name == "leaf_off"

    t_bare = calculate_canopy_transmittance("2026-07-01", mode="bare_terrain")
    assert t_bare.direct == 1.00
    assert t_bare.diffuse == 1.00
    assert t_bare.season_name == "bare_terrain"

    with pytest.raises(ValueError):
        calculate_canopy_transmittance("2026-07-01", mode="unknown_mode")


def test_seasonal_summer_and_winter():
    # Summer solstice: June 21, 2026
    t_summer = calculate_canopy_transmittance(date(2026, 6, 21), mode="seasonal")
    assert t_summer.direct == 0.15
    assert t_summer.diffuse == 0.25
    assert t_summer.season_name == "summer_leaf_on"

    # Winter solstice: Dec 21, 2026
    t_winter = calculate_canopy_transmittance("2026-12-21", mode="seasonal")
    assert t_winter.direct == 0.60
    assert t_winter.diffuse == 0.70
    assert t_winter.season_name == "winter_leaf_off"

    # Mid winter: Jan 15, 2026
    t_jan = calculate_canopy_transmittance("2026-01-15", mode="seasonal")
    assert t_jan.direct == 0.60
    assert t_jan.diffuse == 0.70
    assert t_jan.season_name == "winter_leaf_off"


def test_autumn_senescence_transition():
    # Oct 16 to Nov 15
    t_start = calculate_canopy_transmittance("2026-10-16", mode="seasonal")
    t_mid = calculate_canopy_transmittance("2026-10-31", mode="seasonal")
    t_end = calculate_canopy_transmittance("2026-11-15", mode="seasonal")

    assert t_start.season_name == "autumn_senescence"
    assert t_mid.season_name == "autumn_senescence"
    assert t_end.season_name == "autumn_senescence"

    assert 0.15 <= t_start.direct < t_mid.direct < t_end.direct <= 0.60


def test_spring_budburst_transition():
    # Apr 16 to May 14
    t_start = calculate_canopy_transmittance("2026-04-16", mode="seasonal")
    t_mid = calculate_canopy_transmittance("2026-04-30", mode="seasonal")
    t_end = calculate_canopy_transmittance("2026-05-14", mode="seasonal")

    assert t_start.season_name == "spring_budburst"
    assert t_mid.season_name == "spring_budburst"
    assert t_end.season_name == "spring_budburst"

    assert 0.15 <= t_end.direct < t_mid.direct < t_start.direct <= 0.60


def test_date_input_types():
    # Date object
    assert get_day_of_year(date(2026, 1, 1)) == 1
    # Datetime object
    assert get_day_of_year(datetime(2026, 1, 1, 12, 0)) == 1
    # String
    assert get_day_of_year("2026-01-01") == 1
    # Raw DOY
    assert get_day_of_year(150) == 150
