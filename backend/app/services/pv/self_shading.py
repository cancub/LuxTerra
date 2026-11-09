"""
Physics-based row-to-row self-shading model for tilted ground-mount PV arrays.
Calculates direct beam inter-row obstruction based on solar profile angle,
row pitch, rack slant height, and tilt angle.
"""

from typing import List, Tuple
import numpy as np

from ...schemas.domain import PVTableGeometry, PVLayoutResult


def calculate_profile_angle_rad(solar_azimuth_deg: float, solar_elevation_deg: float, rack_azimuth_deg: float = 180.0) -> float:
    """
    Calculates the solar profile angle (alpha_p) in radians along the row-normal (North-South) axis.
    Returns 0.0 if the sun is below the horizon or behind the array.
    """
    if solar_elevation_deg <= 0.0:
        return 0.0

    az_delta_rad = np.radians(solar_azimuth_deg - rack_azimuth_deg)
    cos_az_delta = np.cos(az_delta_rad)

    # If cos_az_delta <= 0, the sun is behind the front-facing plane of the panels (e.g. northern sky)
    if cos_az_delta <= 0.001:
        return 0.0

    tan_alpha = np.tan(np.radians(solar_elevation_deg))
    tan_alpha_p = tan_alpha / cos_az_delta
    return float(np.arctan(tan_alpha_p))


def calculate_row_self_shading_fraction(
    row_pitch_m: float,
    slant_height_m: float,
    tilt_deg: float,
    solar_azimuth_deg: float,
    solar_elevation_deg: float,
    rack_azimuth_deg: float = 180.0
) -> float:
    """
    Computes the fraction of direct beam radiation blocked on interior/northern rows (rows >= 1)
    by the row immediately to their south.

    Returns:
        float between 0.0 (completely unshaded) and 1.0 (completely shaded).
    """
    if solar_elevation_deg <= 0.0:
        return 1.0

    az_delta_rad = np.radians(solar_azimuth_deg - rack_azimuth_deg)
    cos_az_delta = np.cos(az_delta_rad)
    if cos_az_delta <= 0.001:
        # Sun is behind the panels; front face receives no direct beam
        return 0.0

    tilt_rad = np.radians(tilt_deg)
    tan_alpha_p = np.tan(np.radians(solar_elevation_deg)) / cos_az_delta

    if tan_alpha_p <= 1e-5:
        return 1.0

    # Ground gap between top edge of south row and bottom edge of north row
    d_gap = row_pitch_m - slant_height_m * np.cos(tilt_rad)
    h_rise = slant_height_m * np.sin(tilt_rad)

    # Northward shadow extension at ground level of north row
    s_y = h_rise / tan_alpha_p

    if s_y <= d_gap:
        return 0.0

    # Shadow climbs up the slanted face of the northern row
    denom = np.cos(tilt_rad) + (np.sin(tilt_rad) / tan_alpha_p)
    if denom <= 1e-5:
        return 1.0

    s_shade = (s_y - d_gap) / denom
    fraction_shaded = float(np.clip(s_shade / slant_height_m, 0.0, 1.0))
    return fraction_shaded


def calculate_array_self_shading_fraction(
    layout: PVLayoutResult,
    solar_azimuth_deg: float,
    solar_elevation_deg: float
) -> float:
    """
    Calculates the weighted average self-shading fraction across all panels in the layout.
    Row 0 (southernmost row) has 0.0 self-shading.
    Rows >= 1 experience self-shading from the row to their south.
    """
    if not layout or not layout.tables or layout.total_panels <= 0:
        return 0.0

    if solar_elevation_deg <= 0.0:
        return 1.0

    # Group panel counts by row_index
    row_panels = {}
    for tbl in layout.tables:
        r = tbl.row_index
        row_panels[r] = row_panels.get(r, 0) + tbl.panel_count

    distinct_rows = sorted(row_panels.keys())
    if len(distinct_rows) <= 1:
        # Single row has no row to its south; zero self-shading
        return 0.0

    # First table's tilt and slant height represent the array racking
    ref_table = layout.tables[0]
    row_shaded_fraction = calculate_row_self_shading_fraction(
        row_pitch_m=layout.row_pitch_m,
        slant_height_m=ref_table.slant_height_m,
        tilt_deg=ref_table.tilt_deg,
        solar_azimuth_deg=solar_azimuth_deg,
        solar_elevation_deg=solar_elevation_deg,
        rack_azimuth_deg=ref_table.azimuth_deg
    )

    if row_shaded_fraction <= 0.0:
        return 0.0

    total_shaded_panel_units = 0.0
    for r in distinct_rows:
        count = row_panels[r]
        if r > distinct_rows[0]:
            total_shaded_panel_units += count * row_shaded_fraction

    return float(total_shaded_panel_units / layout.total_panels)
