"""
Physics-based row-to-row self-shading model for tilted ground-mount PV arrays.
Calculates direct beam inter-row obstruction based on solar profile angle,
row pitch, rack slant height, and tilt angle.
"""

from typing import Optional
import numpy as np

from ...schemas.domain import PVLayoutResult


def calculate_row_self_shading_fraction(
    row_pitch_m: float,
    slant_height_m: float,
    tilt_deg: float,
    solar_azimuth_deg: float,
    solar_elevation_deg: float,
    rack_azimuth_deg: float = 180.0,
    south_tilt_deg: Optional[float] = None
) -> float:
    """
    Computes the fraction of direct beam radiation blocked on interior/northern rows (rows >= 1)
    by the row immediately to their south. Supports independent south_tilt_deg and north tilt_deg.

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
    south_rad = np.radians(south_tilt_deg if south_tilt_deg is not None else tilt_deg)
    tan_alpha_p = np.tan(np.radians(solar_elevation_deg)) / cos_az_delta

    if tan_alpha_p <= 1e-5:
        return 1.0

    # Ground gap between top edge of south row and bottom edge of north row (center-pivoted racks)
    d_gap = row_pitch_m - 0.5 * slant_height_m * (np.cos(south_rad) + np.cos(tilt_rad))
    h_rise = slant_height_m * np.sin(south_rad)

    # Northward shadow extension from south row's top edge
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
    has_south_obstruction: bool = True,
    south_tilt_deg: Optional[float] = None
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
    south_rad = np.radians(south_tilt_deg if south_tilt_deg is not None else tilt_deg)
    frac_up_slant = 0.75 if is_top_module else 0.25

    dz = slant_height_m * np.sin(south_rad) - frac_up_slant * slant_height_m * np.sin(tilt_rad)
    dy = row_pitch_m - 0.5 * slant_height_m * np.cos(south_rad) + (frac_up_slant - 0.5) * slant_height_m * np.cos(tilt_rad)

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
    delta_lon = compute_south_delta_lon(latitude, layout.row_pitch_m, np.tan(az_delta_rad))

    total_shaded_panel_units = 0.0
    for r in distinct_rows:
        if r == distinct_rows[0]:
            continue
        south_row_idx = r - 1
        south_tables = tables_by_row.get(south_row_idx, [])
        if not south_tables:
            continue

        for tbl in tables_by_row[r]:
            bounds = _table_lon_bounds(tbl.corners_wgs84)
            if bounds is None:
                continue

            t_min_lon = bounds[0] - delta_lon
            t_max_lon = bounds[1] - delta_lon
            t_len = t_max_lon - t_min_lon
            if t_len <= 1e-9:
                continue

            # Compute horizontal obstruction overlap against tables in southern row
            overlap_lon = 0.0
            for st in south_tables:
                st_bounds = _table_lon_bounds(st.corners_wgs84)
                if st_bounds is None:
                    continue
                ov = max(0.0, min(t_max_lon, st_bounds[1]) - max(t_min_lon, st_bounds[0]))
                overlap_lon += ov

            overlap_frac = float(np.clip(overlap_lon / t_len, 0.0, 1.0))
            total_shaded_panel_units += tbl.panel_count * row_shaded_fraction * overlap_frac

    return float(total_shaded_panel_units / layout.total_panels)


def compute_south_delta_lon(lat_deg: float, row_pitch_m: float, tan_az_delta):
    """East-West longitude shift (degrees) from a receiver at lat_deg toward the southern row along row_pitch_m."""
    m_per_deg_lon = 111320.0 * np.cos(np.radians(lat_deg))
    if m_per_deg_lon <= 0:
        return np.zeros_like(tan_az_delta, dtype=np.float64) if isinstance(tan_az_delta, np.ndarray) else 0.0
    return (row_pitch_m * tan_az_delta) / m_per_deg_lon


def _table_lon_bounds(corners) -> tuple[float, float] | None:
    if not corners or len(corners) < 4:
        return None
    return min(corners[0][0], corners[3][0]), max(corners[1][0], corners[2][0])


def has_south_rack_obstruction(
    center_lon: float,
    center_lat: float,
    row_pitch_m: float,
    tan_az_delta,
    south_tables,
):
    """Return whether a ray from (center_lon, center_lat) intersects any south_table longitude span."""
    delta_lon = compute_south_delta_lon(center_lat, row_pitch_m, tan_az_delta)
    lon_source = center_lon - delta_lon
    if isinstance(lon_source, np.ndarray):
        obs = np.zeros(lon_source.shape, dtype=bool)
        for st in south_tables:
            bounds = _table_lon_bounds(st.corners_wgs84)
            if bounds is None:
                continue
            obs |= (lon_source >= bounds[0]) & (lon_source <= bounds[1])
        return obs
    for st in south_tables:
        bounds = _table_lon_bounds(st.corners_wgs84)
        if bounds is None:
            continue
        if bounds[0] <= lon_source <= bounds[1]:
            return True
    return False


CELL_ROWS = 12
CELL_COLS = 6


def compute_split_halfcut_module_losses(
    terrain_lit_cells: np.ndarray,
    canopy_tau_cells: np.ndarray,
    rack_self_frac: float,
    is_top: bool,
    has_obstruction: bool,
) -> tuple[float, float, float, float]:
    """
    Evaluate 72-cell (12 rows x 6 cols) split/half-cut module direct beam fractions:
    2 parallel halves (rows 0..5 lower, rows 6..11 upper) x 3 two-column substrings (cols 0..1, 2..3, 4..5).
    If any cell in a 6x2 half-substring is terrain-shaded or self-shaded, that 1/6 substring is bypassed.
    Otherwise, its direct beam transmission equals the minimum canopy transmittance across its 12 cells.

    Returns:
        (geo_frac, self_frac, canopy_frac, direct_reaching_frac) summing strictly to 1.0.
    """
    rack_start = 0.5 if is_top else 0.0
    lower_self = has_obstruction and (rack_self_frac > rack_start + 1e-4)
    upper_self = has_obstruction and (rack_self_frac > rack_start + 0.25 + 1e-4)

    geo_frac = 0.0
    self_frac = 0.0
    canopy_frac = 0.0
    direct_frac = 0.0
    sub_w = 1.0 / 6.0

    for h_idx, r0 in enumerate((0, 6)):
        r1 = r0 + 6
        h_self = upper_self if h_idx == 1 else lower_self
        for c0 in (0, 2, 4):
            c1 = c0 + 2
            sub_lit = terrain_lit_cells[r0:r1, c0:c1]
            if not np.all(sub_lit):
                geo_frac += sub_w
            elif h_self:
                self_frac += sub_w
            else:
                min_tau = float(np.min(canopy_tau_cells[r0:r1, c0:c1]))
                min_tau = max(0.0, min(1.0, min_tau))
                canopy_frac += sub_w * (1.0 - min_tau)
                direct_frac += sub_w * min_tau

    return geo_frac, self_frac, canopy_frac, direct_frac
