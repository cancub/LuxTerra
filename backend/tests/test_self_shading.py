"""
Unit tests for physics-based inter-row self-shading calculations.
"""

import numpy as np
import pytest

from backend.app.services.pv.self_shading import (
    calculate_profile_angle_rad,
    calculate_row_self_shading_fraction,
    calculate_array_self_shading_fraction,
    calculate_module_rack_sky_view_factor
)
from backend.app.schemas.domain import PVTableGeometry, PVLayoutResult


def test_calculate_profile_angle_rad():
    # Sun below horizon
    assert calculate_profile_angle_rad(180.0, -5.0) == 0.0
    assert calculate_profile_angle_rad(180.0, 0.0) == 0.0

    # Sun in northern sky (azimuth < 90 or > 270)
    assert calculate_profile_angle_rad(60.0, 20.0) == 0.0
    assert calculate_profile_angle_rad(300.0, 20.0) == 0.0

    # Solar noon from True South (azimuth = 180.0)
    alpha_p = calculate_profile_angle_rad(180.0, 45.0)
    assert np.isclose(np.degrees(alpha_p), 45.0, atol=1e-3)

    # Oblique southern angle (azimuth = 150.0) -> profile angle steeper than elevation
    alpha_p_obl = calculate_profile_angle_rad(150.0, 30.0)
    assert np.degrees(alpha_p_obl) > 30.0


def test_calculate_row_self_shading_fraction_design_cutoff():
    # Montreal winter solstice noon cutoff is ~20.44° for 30° design tilt (pitch = 10.57m, slant = 4.56m)
    pitch = 10.57
    slant = 4.56
    tilt = 30.0

    # At or above design cutoff angle at solar noon -> zero self-shading
    f_noon = calculate_row_self_shading_fraction(
        row_pitch_m=pitch,
        slant_height_m=slant,
        tilt_deg=tilt,
        solar_azimuth_deg=180.0,
        solar_elevation_deg=21.0
    )
    assert f_noon == 0.0

    # High summer noon (el = 67°) -> zero self-shading
    f_summer = calculate_row_self_shading_fraction(
        row_pitch_m=pitch,
        slant_height_m=slant,
        tilt_deg=22.7,
        solar_azimuth_deg=180.0,
        solar_elevation_deg=67.0
    )
    assert f_summer == 0.0

    # Low winter sun (el = 10°) -> significant self-shading
    f_low = calculate_row_self_shading_fraction(
        row_pitch_m=pitch,
        slant_height_m=slant,
        tilt_deg=tilt,
        solar_azimuth_deg=180.0,
        solar_elevation_deg=10.0
    )
    assert 0.0 < f_low < 1.0

    # Extreme low sun (el = 2°) -> almost complete self-shading
    f_extreme = calculate_row_self_shading_fraction(
        row_pitch_m=pitch,
        slant_height_m=slant,
        tilt_deg=tilt,
        solar_azimuth_deg=180.0,
        solar_elevation_deg=2.0
    )
    assert f_extreme > 0.8


def test_calculate_array_self_shading_fraction_multi_row():
    # Construct a 2-row layout
    t1 = PVTableGeometry(
        table_id=0,
        row_index=0, # Southernmost row
        panel_count=40,
        corners_wgs84=[[-74.1, 46.1], [-74.09, 46.1], [-74.09, 46.101], [-74.1, 46.101]],
        center_wgs84=[-74.095, 46.1005],
        azimuth_deg=180.0,
        tilt_deg=30.0,
        stand_height_m=1.0,
        slant_height_m=4.56,
        width_m=20.0,
        depth_m=3.95
    )
    t2 = PVTableGeometry(
        table_id=1,
        row_index=1, # Northern row
        panel_count=40,
        corners_wgs84=[[-74.1, 46.105], [-74.09, 46.105], [-74.09, 46.106], [-74.1, 46.106]],
        center_wgs84=[-74.095, 46.1055],
        azimuth_deg=180.0,
        tilt_deg=30.0,
        stand_height_m=1.0,
        slant_height_m=4.56,
        width_m=20.0,
        depth_m=3.95
    )

    layout_2rows = PVLayoutResult(
        total_panels=80,
        total_tables=2,
        installed_dc_kw=44.0,
        row_pitch_m=10.57,
        inter_row_gap_m=6.62,
        physical_gcr=0.43,
        tables=[t1, t2]
    )

    # When row 1 is shaded by f, array shading is exactly 0.5 * f because row 0 has 0 self-shade
    f_arr = calculate_array_self_shading_fraction(layout_2rows, 180.0, 10.0)
    f_row = calculate_row_self_shading_fraction(10.57, 4.56, 30.0, 180.0, 10.0)
    assert np.isclose(f_arr, 0.5 * f_row, atol=1e-4)

    # Single row layout should always have 0 self-shading
    layout_1row = PVLayoutResult(
        total_panels=40,
        total_tables=1,
        installed_dc_kw=22.0,
        row_pitch_m=10.57,
        inter_row_gap_m=6.62,
        physical_gcr=0.43,
        tables=[t1]
    )
    assert calculate_array_self_shading_fraction(layout_1row, 180.0, 10.0) == 0.0

    # Staggered 2-row layout where northern table is offset to the East with NO table in front of it
    t_staggered = PVTableGeometry(
        table_id=2,
        row_index=1,
        panel_count=40,
        corners_wgs84=[[-74.08, 46.105], [-74.07, 46.105], [-74.07, 46.106], [-74.08, 46.106]],
        center_wgs84=[-74.075, 46.1055],
        azimuth_deg=180.0,
        tilt_deg=30.0,
        stand_height_m=1.0,
        slant_height_m=4.56,
        width_m=20.0,
        depth_m=3.95
    )
    layout_staggered = PVLayoutResult(
        total_panels=80,
        total_tables=2,
        installed_dc_kw=44.0,
        row_pitch_m=10.57,
        inter_row_gap_m=6.62,
        physical_gcr=0.43,
        tables=[t1, t_staggered]
    )
    # At solar noon (azimuth 180), there is 0 overlap between [-74.1, -74.09] and [-74.08, -74.07]
    assert calculate_array_self_shading_fraction(layout_staggered, 180.0, 10.0) == 0.0


def test_calculate_module_rack_sky_view_factor():
    # Unobstructed front row has full local sky view (1.0)
    svf_front = calculate_module_rack_sky_view_factor(
        row_pitch_m=10.57,
        slant_height_m=4.56,
        tilt_deg=30.0,
        is_top_module=False,
        has_south_obstruction=False
    )
    assert svf_front == 1.0

    # Interior row with southern table: bottom module sees less sky than top module
    svf_bot = calculate_module_rack_sky_view_factor(
        row_pitch_m=10.57,
        slant_height_m=4.56,
        tilt_deg=30.0,
        is_top_module=False,
        has_south_obstruction=True
    )
    svf_top = calculate_module_rack_sky_view_factor(
        row_pitch_m=10.57,
        slant_height_m=4.56,
        tilt_deg=30.0,
        is_top_module=True,
        has_south_obstruction=True
    )
    assert 0.85 < svf_bot < svf_top < 1.0

