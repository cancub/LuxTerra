"""
Physics-based row-to-row self-shading model for tilted ground-mount PV arrays.
Calculates direct beam inter-row obstruction based on solar profile angle,
row pitch, rack slant height, and tilt angle.
"""

import numpy as np

from ...schemas.domain import PVLayoutResult


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


def calculate_module_rack_sky_view_factor(
    row_pitch_m: float,
    slant_height_m: float,
    tilt_deg: float,
    is_top_module: bool,
    has_south_obstruction: bool = True
) -> float:
    """
    Calculates the inter-row diffuse Sky View Factor multiplier (0..1) for a module
    due to horizon occlusion from the solar panel rack directly to its south.
    Front-row modules (has_south_obstruction=False) return 1.0.
    Interior-row bottom modules see a higher horizon obstruction angle from the front rack
    than top modules.
    """
    if not has_south_obstruction or row_pitch_m <= 0.0 or slant_height_m <= 0.0:
        return 1.0

    tilt_rad = np.radians(tilt_deg)
    frac_up_slant = 0.75 if is_top_module else 0.25
    delta_slant = (1.0 - frac_up_slant) * slant_height_m

    dz = delta_slant * np.sin(tilt_rad)
    dy = row_pitch_m - delta_slant * np.cos(tilt_rad)

    if dy <= 0.1 or dz <= 0.0:
        return 1.0

    tan_psi = dz / dy
    blocked_fraction = (1.0 / 3.0) * (1.0 - (1.0 / (1.0 + tan_psi * tan_psi)))
    return float(np.clip(1.0 - blocked_fraction, 0.5, 1.0))


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

    # Group tables by row_index
    tables_by_row = {}
    for tbl in layout.tables:
        tables_by_row.setdefault(tbl.row_index, []).append(tbl)

    distinct_rows = sorted(tables_by_row.keys())
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

    # Solar azimuth East-West horizontal displacement along row pitch
    az_delta_rad = np.radians(solar_azimuth_deg - 180.0)
    cos_az_delta = np.cos(az_delta_rad)
    if cos_az_delta <= 0.001:
        return 0.0

    latitude = ref_table.center_wgs84[1] if (ref_table.center_wgs84 and len(ref_table.center_wgs84) > 1) else 45.5
    delta_x_m = layout.row_pitch_m * np.tan(az_delta_rad)
    m_per_deg_lon = 111320.0 * np.cos(np.radians(latitude))
    delta_lon = delta_x_m / m_per_deg_lon if m_per_deg_lon > 0 else 0.0

    total_shaded_panel_units = 0.0
    for r in distinct_rows:
        if r == distinct_rows[0]:
            continue
        south_row_idx = r - 1
        south_tables = tables_by_row.get(south_row_idx, [])
        if not south_tables:
            continue

        for tbl in tables_by_row[r]:
            corners = tbl.corners_wgs84
            if not corners or len(corners) < 4:
                continue

            t_min_lon = min(corners[0][0], corners[3][0]) - delta_lon
            t_max_lon = max(corners[1][0], corners[2][0]) - delta_lon
            t_len = t_max_lon - t_min_lon
            if t_len <= 1e-9:
                continue

            # Compute horizontal obstruction overlap against tables in southern row
            overlap_lon = 0.0
            for st in south_tables:
                sc = st.corners_wgs84
                if not sc or len(sc) < 4:
                    continue
                st_min = min(sc[0][0], sc[3][0])
                st_max = max(sc[1][0], sc[2][0])
                ov = max(0.0, min(t_max_lon, st_max) - max(t_min_lon, st_min))
                overlap_lon += ov

            overlap_frac = float(np.clip(overlap_lon / t_len, 0.0, 1.0))
            total_shaded_panel_units += tbl.panel_count * row_shaded_fraction * overlap_frac

    return float(total_shaded_panel_units / layout.total_panels)
