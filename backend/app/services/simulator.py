"""
Simulation Orchestrator Service.
Coordinates elevation extraction, vectorized solar geometry, batch GPU ray-marching,
PV yield conversion, and daily integration.
"""

from typing import Optional, List
from datetime import datetime, date, time
import base64
import zoneinfo
import numpy as np
import pandas as pd
import pvlib

from ..schemas.simulate import (
    SimulateRequest,
    SimulateResponse,
    SimulateMetadata,
    DailySummary,
    TimestepMetric
)
from ..schemas.domain import PVConfig, DeploymentMode
from ..constants import DEFAULT_TIMEZONE
from ..interfaces.elevation_source import ElevationProvider
from ..interfaces.solar_engine import SolarEngine
from ..interfaces.occlusion_engine import OcclusionEngine
from ..interfaces.pv_model import PVSystemModel
from .elevation.geo_utils import transform_geometry, get_transformer
from .serializer import encode_masks_batch, encode_mask_bitmask
from .solar.phenology import calculate_canopy_transmittance
from .occlusion.ray_math import compute_canopy_transmittance_grid, quantize_canopy_shade_levels
from .pv.packing_engine import PVPackingEngine
from .pv.self_shading import (
    CELL_ROWS,
    CELL_COLS,
    calculate_array_self_shading_fraction,
    calculate_row_self_shading_fraction,
    calculate_module_rack_sky_view_factor,
    compute_split_halfcut_module_losses,
)

TZ_QUEBEC = zoneinfo.ZoneInfo(DEFAULT_TIMEZONE)


def _polygon_mask_2d(xs: np.ndarray, ys: np.ndarray, poly_xy: list) -> np.ndarray:
    """Vectorized point-in-polygon mask for grid cell centers (xs, ys) in metric CRS."""
    n = len(poly_xy)
    if n < 3:
        return np.zeros((len(ys), len(xs)), dtype=bool)
    px = xs[None, :]
    py = ys[:, None]
    inside = np.zeros((len(ys), len(xs)), dtype=bool)
    x1, y1 = poly_xy[-1]
    for x2, y2 in poly_xy:
        cond = (y1 > py) != (y2 > py)
        if np.any(cond):
            x_intersect = (x2 - x1) * (py - y1) / ((y2 - y1) if y2 != y1 else 1e-12) + x1
            inside ^= cond & (px < x_intersect)
        x1, y1 = x2, y2
    return inside


def _apply_shade_overrides(
    dtm_grid: np.ndarray,
    dsm_grid: np.ndarray,
    chm_grid: Optional[np.ndarray],
    geo_info: dict,
    overrides: list,
):
    """Apply polygon (or legacy circular) geology/canopy overrides onto writable copies of the elevation grids."""
    dtm = dtm_grid.copy()
    dsm = dsm_grid.copy()
    chm = chm_grid.copy() if chm_grid is not None else None

    h, w = dtm.shape
    b_min_x, b_min_y, b_max_x, b_max_y = geo_info["buffered_bounds_metric"]
    dx = (b_max_x - b_min_x) / w
    dy = (b_max_y - b_min_y) / h
    transformer = get_transformer("EPSG:4326", geo_info["target_crs"])

    for ov in overrides:
        if getattr(ov, "polygon", None):
            poly_xy = [transformer.transform(float(pt[0]), float(pt[1])) for pt in ov.polygon]
            xs_poly = [p[0] for p in poly_xy]
            ys_poly = [p[1] for p in poly_xy]
            min_x, max_x = min(xs_poly), max(xs_poly)
            min_y, max_y = min(ys_poly), max(ys_poly)

            c0 = max(0, int(np.floor((min_x - b_min_x) / dx)))
            c1 = min(w, int(np.ceil((max_x - b_min_x) / dx)))
            r0 = max(0, int(np.floor((b_max_y - max_y) / dy)))
            r1 = min(h, int(np.ceil((b_max_y - min_y) / dy)))
            if c1 <= c0 or r1 <= r0:
                continue

            xs = b_min_x + (np.arange(c0, c1, dtype=np.float64) + 0.5) * dx
            ys = b_max_y - (np.arange(r0, r1, dtype=np.float64) + 0.5) * dy
            mask = _polygon_mask_2d(xs, ys, poly_xy)
        else:
            lon, lat = float(ov.center[0]), float(ov.center[1])
            r_m = float(ov.radius_m)
            cx, cy = transformer.transform(lon, lat)

            c0 = max(0, int(np.floor((cx - r_m - b_min_x) / dx)))
            c1 = min(w, int(np.ceil((cx + r_m - b_min_x) / dx)))
            r0 = max(0, int(np.floor((b_max_y - (cy + r_m)) / dy)))
            r1 = min(h, int(np.ceil((b_max_y - (cy - r_m)) / dy)))
            if c1 <= c0 or r1 <= r0:
                continue

            xs = b_min_x + (np.arange(c0, c1, dtype=np.float64) + 0.5) * dx
            ys = b_max_y - (np.arange(r0, r1, dtype=np.float64) + 0.5) * dy
            dist_sq = (xs[None, :] - cx) ** 2 + (ys[:, None] - cy) ** 2
            mask = dist_sq <= (r_m * r_m)

        if not np.any(mask):
            continue

        dtm_sub = dtm[r0:r1, c0:c1]
        dsm_sub = dsm[r0:r1, c0:c1]
        if ov.type == "to_geology":
            dtm_sub[mask] = np.maximum(dtm_sub[mask], dsm_sub[mask])
        elif ov.type == "remove_canopy":
            dsm_sub[mask] = dtm_sub[mask]

        if chm is not None:
            chm[r0:r1, c0:c1][mask] = 0.0

    return dtm, dsm, chm


def _optimize_row_tilts(
    layout,
    tables_by_row: dict,
    distinct_rows: list,
    discrete_modules: list,
    svf_grid: np.ndarray,
    daylight_angles: list,
    daylight_irradiance: list,
    daylight_masks: list,
    daylight_canopy_masks: list,
    daylight_canopy_transmittance: list,
    has_canopy: bool,
    canopy_transmittance: float,
) -> dict:
    """
    Optimize panel tilt per row (south-to-north) against full-day energy including
    terrain/canopy shading, row-to-row self-shading, and diffuse sky-view factor.
    Returns {row_index: optimal_tilt_deg}.
    """
    if not distinct_rows or not daylight_angles or not daylight_irradiance or not discrete_modules:
        return {r: 30.0 for r in distinct_rows}

    az_arr = np.array([a.azimuth_deg for a in daylight_angles], dtype=np.float64)
    el_arr = np.array([a.elevation_deg for a in daylight_angles], dtype=np.float64)
    zen_arr = np.array([a.zenith_deg for a in daylight_angles], dtype=np.float64)
    dni_arr = np.array([ir.dni_w_m2 for ir in daylight_irradiance], dtype=np.float64)
    dhi_arr = np.array([ir.dhi_w_m2 for ir in daylight_irradiance], dtype=np.float64)

    n_t = len(daylight_angles)
    az_delta_rad = np.radians(az_arr - 180.0)
    cos_az_delta = np.cos(az_delta_rad)
    tan_az_delta = np.where(cos_az_delta > 0.001, np.tan(az_delta_rad), 0.0)
    tan_alpha_p = np.where(
        (el_arr > 0.0) & (cos_az_delta > 0.001),
        np.tan(np.radians(el_arr)) / np.maximum(cos_az_delta, 1e-6),
        0.0
    )

    # Precompute per-module split/half-cut terrain + canopy direct transmission tau_lo[m, t], tau_hi[m, t]
    # Each half (lower 6 rows, upper 6 rows) has 3 two-column substrings; each substring's direct
    # transmission is 0 if any cell is terrain-shaded, else min(canopy_tau) across its 12 cells.
    n_mods = len(discrete_modules)
    all_cell_rows = np.stack([m["cell_rows"] for m in discrete_modules], axis=0)  # (n_mods, 12, 6)
    all_cell_cols = np.stack([m["cell_cols"] for m in discrete_modules], axis=0)  # (n_mods, 12, 6)
    tau_lo = np.ones((n_mods, n_t), dtype=np.float64)
    tau_hi = np.ones((n_mods, n_t), dtype=np.float64)

    for t_idx in range(n_t):
        t_lit = (daylight_masks[t_idx][all_cell_rows, all_cell_cols] > 0)  # (n_mods, 12, 6)
        if has_canopy and daylight_canopy_transmittance and t_idx < len(daylight_canopy_transmittance):
            c_tau = daylight_canopy_transmittance[t_idx][all_cell_rows, all_cell_cols]
        elif has_canopy and daylight_canopy_masks and t_idx < len(daylight_canopy_masks):
            c_lit = daylight_canopy_masks[t_idx][all_cell_rows, all_cell_cols] > 0
            c_tau = np.where(c_lit, 1.0, canopy_transmittance)
        else:
            c_tau = np.ones((n_mods, CELL_ROWS, CELL_COLS), dtype=np.float64)

        # Reshape (n_mods, 2 halves, 6 rows, 3 substrings, 2 cols)
        lit_sub = t_lit.reshape(n_mods, 2, 6, 3, 2).all(axis=(2, 4))  # (n_mods, 2, 3)
        tau_sub = c_tau.reshape(n_mods, 2, 6, 3, 2).min(axis=(2, 4))  # (n_mods, 2, 3)
        eff_sub = np.where(lit_sub, tau_sub, 0.0)
        # Half-module receives mean of its 3 substrings (each substring = 1/6 of module -> * 0.5 below)
        tau_lo[:, t_idx] = eff_sub[:, 0, :].mean(axis=1)
        tau_hi[:, t_idx] = eff_sub[:, 1, :].mean(axis=1)

    # Precompute for each module whether it has a south obstruction at each timestep
    south_obs_mat = np.zeros((n_mods, n_t), dtype=bool)
    row_pitch_m = float(layout.row_pitch_m or 10.0)
    for m_idx, mod in enumerate(discrete_modules):
        if mod["is_front_row"] or not mod["south_tables"]:
            continue
        m_per_deg_lon = 111320.0 * np.cos(np.radians(mod["center_lat"]))
        delta_lon = (row_pitch_m * tan_az_delta) / m_per_deg_lon if m_per_deg_lon > 0 else np.zeros(n_t)
        lon_src = mod["center_lon"] - delta_lon
        obs = np.zeros(n_t, dtype=bool)
        for st in mod["south_tables"]:
            sc = st.corners_wgs84
            if not sc or len(sc) < 4:
                continue
            st_min = min(sc[0][0], sc[3][0])
            st_max = max(sc[1][0], sc[2][0])
            obs |= (lon_src >= st_min) & (lon_src <= st_max)
        south_obs_mat[m_idx] = obs & (cos_az_delta > 0.001) & (el_arr > 0.0)

    # Group module indices by row_index
    mod_indices_by_row = {}
    for m_idx, mod in enumerate(discrete_modules):
        mod_indices_by_row.setdefault(mod["table_row_index"], []).append(m_idx)

    # Precompute per-row vectorized aggregates for fast joint DP + coordinate refinement
    row_agg = {}
    for r_idx in distinct_rows:
        m_idxs = mod_indices_by_row.get(r_idx, [])
        if not m_idxs:
            continue
        bot_obs_idxs = [m for m in m_idxs if not discrete_modules[m]["is_top"] and discrete_modules[m]["has_south_rack"]]
        bot_free_idxs = [m for m in m_idxs if not discrete_modules[m]["is_top"] and not discrete_modules[m]["has_south_rack"]]
        top_obs_idxs = [m for m in m_idxs if discrete_modules[m]["is_top"] and discrete_modules[m]["has_south_rack"]]
        top_free_idxs = [m for m in m_idxs if discrete_modules[m]["is_top"] and not discrete_modules[m]["has_south_rack"]]

        bot_all = bot_obs_idxs + bot_free_idxs
        top_all = top_obs_idxs + top_free_idxs

        tau_bot_lo_all = 0.5 * np.sum(tau_lo[bot_all], axis=0) if bot_all else np.zeros(n_t)
        tau_bot_lo_obs = 0.5 * np.sum(np.where(south_obs_mat[bot_all], tau_lo[bot_all], 0.0), axis=0) if bot_all else np.zeros(n_t)
        tau_bot_hi_all = 0.5 * np.sum(tau_hi[bot_all], axis=0) if bot_all else np.zeros(n_t)
        tau_bot_hi_obs = 0.5 * np.sum(np.where(south_obs_mat[bot_all], tau_hi[bot_all], 0.0), axis=0) if bot_all else np.zeros(n_t)

        tau_top_lo_all = 0.5 * np.sum(tau_lo[top_all], axis=0) if top_all else np.zeros(n_t)
        tau_top_lo_obs = 0.5 * np.sum(np.where(south_obs_mat[top_all], tau_lo[top_all], 0.0), axis=0) if top_all else np.zeros(n_t)
        tau_top_hi_all = 0.5 * np.sum(tau_hi[top_all], axis=0) if top_all else np.zeros(n_t)
        tau_top_hi_obs = 0.5 * np.sum(np.where(south_obs_mat[top_all], tau_hi[top_all], 0.0), axis=0) if top_all else np.zeros(n_t)

        def _svf_arr(idxs):
            if not idxs:
                return np.empty(0, dtype=np.float64)
            return np.array([float(svf_grid[discrete_modules[m]["row_idx"], discrete_modules[m]["col_idx"]]) for m in idxs], dtype=np.float64)

        row_agg[r_idx] = {
            "tau_bot_lo_all": tau_bot_lo_all,
            "tau_bot_lo_obs": tau_bot_lo_obs,
            "tau_bot_hi_all": tau_bot_hi_all,
            "tau_bot_hi_obs": tau_bot_hi_obs,
            "tau_top_lo_all": tau_top_lo_all,
            "tau_top_lo_obs": tau_top_lo_obs,
            "tau_top_hi_all": tau_top_hi_all,
            "tau_top_hi_obs": tau_top_hi_obs,
            "svf_bot_obs": _svf_arr(bot_obs_idxs),
            "svf_bot_free": _svf_arr(bot_free_idxs),
            "svf_top_obs": _svf_arr(top_obs_idxs),
            "svf_top_free": _svf_arr(top_free_idxs),
        }

    slant_h = float(layout.tables[0].slant_height_m or 4.56) if layout.tables else 4.56
    inv_tan_alpha_p = np.where(tan_alpha_p > 1e-5, 1.0 / np.maximum(tan_alpha_p, 1e-6), 0.0)
    valid_sun = tan_alpha_p > 1e-5

    def eval_row_energy(r_idx: int, theta_deg: float, south_tilt_deg: Optional[float]) -> float:
        agg = row_agg.get(r_idx)
        if agg is None:
            return 0.0
        aoi = pvlib.irradiance.aoi(theta_deg, 180.0, zen_arr, az_arr)
        cos_aoi = np.maximum(0.0, np.cos(np.radians(aoi)))
        poa_dir = dni_arr * cos_aoi
        tilt_rad = np.radians(theta_deg)
        poa_dif_sum = float(np.sum(dhi_arr * 0.5 * (1.0 + np.cos(tilt_rad))))

        if south_tilt_deg is not None:
            south_rad = np.radians(south_tilt_deg)
            d_gap = row_pitch_m - 0.5 * slant_h * (np.cos(south_rad) + np.cos(tilt_rad))
            h_rise = slant_h * np.sin(south_rad)
            s_y = h_rise * inv_tan_alpha_p
            denom = np.cos(tilt_rad) + np.sin(tilt_rad) * inv_tan_alpha_p
            rack_f = np.where(
                valid_sun & (s_y > d_gap) & (denom > 1e-5),
                np.clip(((s_y - d_gap) / np.maximum(denom, 1e-6)) / slant_h, 0.0, 1.0),
                0.0
            )
            bot_lo_f = np.where(rack_f > 1e-4, 1.0, 0.0)
            bot_hi_f = np.where(rack_f > 0.25 + 1e-4, 1.0, 0.0)
            top_lo_f = np.where(rack_f > 0.50 + 1e-4, 1.0, 0.0)
            top_hi_f = np.where(rack_f > 0.75 + 1e-4, 1.0, 0.0)
        else:
            bot_lo_f = 0.0
            bot_hi_f = 0.0
            top_lo_f = 0.0
            top_hi_f = 0.0

        dir_e = float(
            np.sum(
                poa_dir * (
                    agg["tau_bot_lo_all"] - bot_lo_f * agg["tau_bot_lo_obs"]
                    + agg["tau_bot_hi_all"] - bot_hi_f * agg["tau_bot_hi_obs"]
                    + agg["tau_top_lo_all"] - top_lo_f * agg["tau_top_lo_obs"]
                    + agg["tau_top_hi_all"] - top_hi_f * agg["tau_top_hi_obs"]
                )
            )
        )

        dif_e = 0.0
        for is_top, has_obs, svf_arr in (
            (False, True, agg["svf_bot_obs"]),
            (False, False, agg["svf_bot_free"]),
            (True, True, agg["svf_top_obs"]),
            (True, False, agg["svf_top_free"]),
        ):
            if svf_arr.size == 0:
                continue
            r_svf = calculate_module_rack_sky_view_factor(
                row_pitch_m=row_pitch_m,
                slant_height_m=slant_h,
                tilt_deg=theta_deg,
                is_top_module=is_top,
                has_south_obstruction=has_obs,
                south_tilt_deg=south_tilt_deg
            )
            dif_e += poa_dif_sum * float(np.sum(np.clip(svf_arr * r_svf, 0.05, 1.0)))

        return dir_e + dif_e

    # 1. Joint Global Optimization via Dynamic Programming (Viterbi) on 2-deg coarse grid (0..84 deg)
    coarse_grid = [float(t) for t in np.arange(0.0, 86.0, 2.0)]
    n_g = len(coarse_grid)
    n_r = len(distinct_rows)

    dp = np.zeros((n_r, n_g), dtype=np.float64)
    back = np.zeros((n_r, n_g), dtype=np.intp)

    r0 = distinct_rows[0]
    for j, th in enumerate(coarse_grid):
        dp[0, j] = eval_row_energy(r0, th, None)

    for k in range(1, n_r):
        rk = distinct_rows[k]
        for j, th in enumerate(coarse_grid):
            best_val = -1.0
            best_i = 0
            for i, s_th in enumerate(coarse_grid):
                val = dp[k - 1, i] + eval_row_energy(rk, th, s_th)
                if val > best_val:
                    best_val = val
                    best_i = i
            dp[k, j] = best_val
            back[k, j] = best_i

    best_idx = int(np.argmax(dp[n_r - 1]))
    opt_tilts = [0.0] * n_r
    for k in range(n_r - 1, -1, -1):
        opt_tilts[k] = coarse_grid[best_idx]
        if k > 0:
            best_idx = int(back[k, best_idx])

    # 2. Coordinate Refinement (2 passes, 0.2 deg step) maximizing total array energy
    for _ in range(2):
        for k in range(n_r):
            rk = distinct_rows[k]
            s_th = opt_tilts[k - 1] if k > 0 else None
            n_th = opt_tilts[k + 1] if k + 1 < n_r else None
            rk_next = distinct_rows[k + 1] if k + 1 < n_r else None

            fine_lo = max(0.0, opt_tilts[k] - 2.0)
            fine_hi = min(85.0, opt_tilts[k] + 2.0)
            fine_grid = np.arange(fine_lo, fine_hi + 0.05, 0.2)

            best_t = opt_tilts[k]
            best_e = -1.0
            for t_cand in fine_grid:
                tc = float(t_cand)
                e_pair = eval_row_energy(rk, tc, s_th)
                if rk_next is not None and n_th is not None:
                    e_pair += eval_row_energy(rk_next, n_th, tc)
                if e_pair > best_e:
                    best_e = e_pair
                    best_t = tc
            opt_tilts[k] = best_t

    row_tilts = {distinct_rows[k]: round(opt_tilts[k], 1) for k in range(n_r)}
    return row_tilts


class SimulationOrchestrator:
    """
    Coordinates end-to-end full-day simulation with vectorized solar operations and batch GPU ray-marching.
    """

    def __init__(
        self,
        elevation_provider: ElevationProvider,
        solar_engine: SolarEngine,
        occlusion_engine: OcclusionEngine,
        pv_model: PVSystemModel,
        packing_engine: Optional[PVPackingEngine] = None
    ):
        self.elevation_provider = elevation_provider
        self.solar_engine = solar_engine
        self.occlusion_engine = occlusion_engine
        self.pv_model = pv_model
        self.packing_engine = packing_engine or PVPackingEngine()

    def run_simulation(self, request: SimulateRequest) -> SimulateResponse:
        """
        Executes a 24-hour simulation for the requested bounding box and date.
        """
        # 1. Extract elevation window (co-registered DTM, DSM, and CHM)
        # If a wider visual context bounding box is provided, use it for the patch window
        sim_bbox = request.context_bbox if request.context_bbox else request.bbox
        solar_bbox = request.bbox

        elev_data = self.elevation_provider.get_elevation_window(
            min_lon=sim_bbox.min_lon,
            min_lat=sim_bbox.min_lat,
            max_lon=sim_bbox.max_lon,
            max_lat=sim_bbox.max_lat,
            buffer_meters=request.buffer_meters,
            target_resolution_m=request.resolution_m
        )

        dtm_grid = elev_data.get("dtm", elev_data["buffered_elevation"])
        dsm_grid = elev_data.get("dsm", dtm_grid)
        has_canopy = bool(elev_data.get("has_canopy", False)) and request.include_tree_canopy and (request.canopy_mode.lower().strip() != "bare_terrain")
        dsm_tile_source = elev_data.get("dsm_tile_source")

        patch_slice_y = elev_data["patch_slice_y"]
        patch_slice_x = elev_data["patch_slice_x"]
        median_elev = elev_data["median_elevation_m"]
        geo_info = elev_data["geo_info"]

        if request.shade_overrides:
            dtm_grid, dsm_grid, overridden_chm = _apply_shade_overrides(
                dtm_grid, dsm_grid, elev_data.get("chm"), geo_info, request.shade_overrides
            )
            if overridden_chm is not None:
                elev_data["chm"] = overridden_chm

        patch_h = patch_slice_y.stop - patch_slice_y.start
        patch_w = patch_slice_x.stop - patch_slice_x.start
        cell_area_m2 = request.resolution_m * request.resolution_m

        import rasterio
        import rasterio.features
        import rasterio.transform
        target_crs = elev_data["crs"]
        patch_transform = elev_data.get("patch_affine_transform")
        if patch_transform is None and elev_data.get("affine_transform") is not None:
            patch_transform = elev_data["affine_transform"] @ rasterio.Affine.translation(
                patch_slice_x.start, patch_slice_y.start
            )
        if patch_transform is None:
            p_min_x, p_min_y, p_max_x, p_max_y = geo_info["patch_bounds_metric"]
            patch_transform = rasterio.transform.from_bounds(
                p_min_x, p_min_y, p_max_x, p_max_y, patch_w, patch_h
            )
        wgs84_to_utm = get_transformer("EPSG:4326", target_crs)
        inv_patch_transform = ~patch_transform

        # Compute seasonal canopy transmittance
        transmittance = calculate_canopy_transmittance(request.date, mode=request.canopy_mode)
        canopy_transmittance = transmittance.direct

        # 1b. Rasterize inclusion mask for the solar panel generation domain
        # If polygon is supplied, rasterize it.
        # If no polygon is supplied but a wider context_bbox was used, rasterize solar_bbox as the inclusion mask.
        polygon_mask = None
        polygon_area_m2 = None
        has_context_expansion = bool(request.context_bbox is not None)

        def _rasterize_domain(geom_wgs84):
            geom_utm = transform_geometry(geom_wgs84, "EPSG:4326", target_crs)
            area_m2 = float(geom_utm.area)
            rast = rasterio.features.rasterize(
                [geom_utm],
                out_shape=(patch_h, patch_w),
                transform=patch_transform,
                fill=0,
                default_value=1,
                dtype=np.uint8
            ).astype(bool)
            return (rast if np.any(rast) else None), area_m2

        if request.polygon and len(request.polygon) >= 3:
            from shapely.geometry import Polygon as ShapelyPolygon
            poly_wgs84 = ShapelyPolygon(request.polygon)
            if not poly_wgs84.is_valid:
                poly_wgs84 = poly_wgs84.buffer(0)
            polygon_mask, polygon_area_m2 = _rasterize_domain(poly_wgs84)
        elif has_context_expansion:
            from shapely.geometry import box as ShapelyBox
            polygon_mask, polygon_area_m2 = _rasterize_domain(
                ShapelyBox(solar_bbox.min_lon, solar_bbox.min_lat, solar_bbox.max_lon, solar_bbox.max_lat)
            )

        # 2. Build 24-hour timestep intervals (robust against DST transitions)
        sim_date = date.fromisoformat(request.date)
        step_min = request.time_step_minutes
        
        start_dt = datetime.combine(sim_date, time(0, 0), tzinfo=TZ_QUEBEC)
        end_dt = datetime.combine(sim_date, time(23, 59, 59), tzinfo=TZ_QUEBEC)
        timestamps = pd.date_range(start=start_dt, end=end_dt, freq=f"{step_min}min")

        center_lon = (solar_bbox.min_lon + solar_bbox.max_lon) / 2.0
        center_lat = (solar_bbox.min_lat + solar_bbox.max_lat) / 2.0

        # 3. Vectorized calculation of all solar positions
        all_angles = self.solar_engine.calculate_solar_angles_series(timestamps, center_lat, center_lon)
        seasonal_tilt = round(all_angles[0].optimal_tilt_deg, 1) if all_angles else round(center_lat, 1)

        daylight_indices = []
        daylight_angle_pairs = []
        daylight_angles = []

        for idx, angles in enumerate(all_angles):
            if angles.elevation_deg > 0.0:
                daylight_indices.append(idx)
                daylight_angle_pairs.append((angles.azimuth_deg, angles.elevation_deg))
                daylight_angles.append(angles)

        # 4. Batch compute occlusion masks for daytime frames (single VRAM upload)
        if daylight_angle_pairs:
            is_rooftop = (request.deployment_mode == DeploymentMode.ROOFTOP)
            stand_height = 0.0 if is_rooftop else 1.5

            visual_daylight_masks = None
            visual_daylight_canopy_masks = None
            visual_daylight_paths = None
            daylight_canopy_transmittance = None
            ground_canopy_shade_levels_arr = None
            visual_canopy_shade_levels_arr = None

            if has_canopy and not is_rooftop and hasattr(self.occlusion_engine, "compute_ground_and_top_sim_batch"):
                (
                    daylight_masks,
                    daylight_canopy_masks,
                    daylight_canopy_transmittance,
                    ground_canopy_shade_levels_arr,
                    visual_daylight_masks,
                    visual_daylight_canopy_masks,
                    visual_canopy_shade_levels_arr,
                ) = self.occlusion_engine.compute_ground_and_top_sim_batch(
                    dtm_grid=dtm_grid,
                    dsm_grid=dsm_grid,
                    patch_slice_y=patch_slice_y,
                    patch_slice_x=patch_slice_x,
                    sun_angles=daylight_angle_pairs,
                    canopy_transmittance=canopy_transmittance,
                    resolution_m=request.resolution_m,
                    max_search_radius_m=request.buffer_meters,
                    ground_stand_height_m=stand_height,
                    clip_mask=(polygon_mask if (polygon_mask is not None and not has_context_expansion) else None),
                )
                daylight_canopy_paths = []
            elif has_canopy and not is_rooftop and hasattr(self.occlusion_engine, "compute_ground_and_top_shadow_masks_batch"):
                (
                    daylight_masks,
                    daylight_canopy_masks,
                    daylight_canopy_paths,
                    visual_daylight_masks,
                    visual_daylight_canopy_masks,
                    visual_daylight_paths,
                ) = self.occlusion_engine.compute_ground_and_top_shadow_masks_batch(
                    dtm_grid=dtm_grid,
                    dsm_grid=dsm_grid,
                    patch_slice_y=patch_slice_y,
                    patch_slice_x=patch_slice_x,
                    sun_angles=daylight_angle_pairs,
                    resolution_m=request.resolution_m,
                    max_search_radius_m=request.buffer_meters,
                    ground_stand_height_m=stand_height,
                )
            elif has_canopy and hasattr(self.occlusion_engine, "compute_dual_shadow_masks_with_path_batch"):
                daylight_masks, daylight_canopy_masks, daylight_canopy_paths = self.occlusion_engine.compute_dual_shadow_masks_with_path_batch(
                    dtm_grid=dtm_grid,
                    dsm_grid=dsm_grid,
                    patch_slice_y=patch_slice_y,
                    patch_slice_x=patch_slice_x,
                    sun_angles=daylight_angle_pairs,
                    resolution_m=request.resolution_m,
                    max_search_radius_m=request.buffer_meters,
                    is_rooftop=is_rooftop,
                    ground_stand_height_m=stand_height,
                    include_tree_canopy=has_canopy
                )
            else:
                daylight_masks, daylight_canopy_masks = self.occlusion_engine.compute_dual_shadow_masks_batch(
                    dtm_grid=dtm_grid,
                    dsm_grid=dsm_grid,
                    patch_slice_y=patch_slice_y,
                    patch_slice_x=patch_slice_x,
                    sun_angles=daylight_angle_pairs,
                    resolution_m=request.resolution_m,
                    max_search_radius_m=request.buffer_meters,
                    is_rooftop=is_rooftop,
                    ground_stand_height_m=stand_height,
                    include_tree_canopy=has_canopy
                )
                daylight_canopy_paths = []

            if daylight_canopy_transmittance is None:
                daylight_canopy_transmittance = [
                    compute_canopy_transmittance_grid(p, canopy_transmittance)
                    for p in daylight_canopy_paths
                ] if daylight_canopy_paths else []

            if has_canopy and is_rooftop and daylight_canopy_paths and visual_daylight_paths is None:
                visual_daylight_paths = daylight_canopy_paths
            elif has_canopy and not is_rooftop and visual_daylight_masks is None:
                if hasattr(self.occlusion_engine, "compute_dual_shadow_masks_with_path_batch"):
                    visual_daylight_masks, visual_daylight_canopy_masks, visual_daylight_paths = self.occlusion_engine.compute_dual_shadow_masks_with_path_batch(
                        dtm_grid=dtm_grid,
                        dsm_grid=dsm_grid,
                        patch_slice_y=patch_slice_y,
                        patch_slice_x=patch_slice_x,
                        sun_angles=daylight_angle_pairs,
                        resolution_m=request.resolution_m,
                        max_search_radius_m=request.buffer_meters,
                        is_rooftop=is_rooftop,
                        ground_stand_height_m=stand_height,
                        include_tree_canopy=True,
                        top_of_canopy=True
                    )
                else:
                    visual_daylight_masks, visual_daylight_canopy_masks = self.occlusion_engine.compute_dual_shadow_masks_batch(
                        dtm_grid=dtm_grid,
                        dsm_grid=dsm_grid,
                        patch_slice_y=patch_slice_y,
                        patch_slice_x=patch_slice_x,
                        sun_angles=daylight_angle_pairs,
                        resolution_m=request.resolution_m,
                        max_search_radius_m=request.buffer_meters,
                        is_rooftop=is_rooftop,
                        ground_stand_height_m=stand_height,
                        include_tree_canopy=True,
                        top_of_canopy=True
                    )

            # Vectorized calculation of clear-sky irradiance for all daytime frames
            daylight_times = timestamps[daylight_indices]
            daylight_irradiance = self.solar_engine.calculate_irradiance_series(
                daylight_times, center_lat, center_lon, daylight_angles, altitude_m=median_elev
            )
        else:
            daylight_masks = []
            daylight_canopy_masks = []
            daylight_canopy_paths = []
            daylight_canopy_transmittance = []
            visual_daylight_masks = None
            visual_daylight_canopy_masks = None
            visual_daylight_paths = None
            ground_canopy_shade_levels_arr = None
            visual_canopy_shade_levels_arr = None
            daylight_irradiance = []

        # 4b. Synthesize maximal ground-mount solar panel layout (fixed civil layout with seasonal table tilt)
        # Always pack panels strictly inside the active solar array boundary (polygon or solar_bbox)
        boundary_target = request.polygon if (request.polygon and len(request.polygon) >= 3) else solar_bbox
        layout = self.packing_engine.generate_layout(
            boundary=boundary_target,
            latitude=center_lat,
            design_tilt_deg=30.0,
            current_tilt_deg=seasonal_tilt
        )

        # 5. PV System Configuration (incorporating overrides without duplicating schema defaults)
        pv_kwargs = {"deployment_mode": request.deployment_mode}
        if request.module_efficiency is not None:
            pv_kwargs["module_efficiency"] = request.module_efficiency
        if request.system_derate is not None:
            pv_kwargs["system_derate"] = request.system_derate
        if request.gcr is not None:
            pv_kwargs["gcr"] = request.gcr
        pv_cfg = PVConfig(**pv_kwargs)

        # 5b. Precompute 360-degree 3D local Sky View Factor (SVF) grid for diffuse sky radiation
        is_rooftop_mode = (request.deployment_mode == DeploymentMode.ROOFTOP)
        svf_grid = None
        if hasattr(self.occlusion_engine, "compute_sky_view_factor"):
            res_svf = self.occlusion_engine.compute_sky_view_factor(
                dtm_grid=dtm_grid,
                dsm_grid=dsm_grid,
                patch_slice_y=patch_slice_y,
                patch_slice_x=patch_slice_x,
                resolution_m=request.resolution_m,
                max_search_radius_m=min(request.buffer_meters, 500.0),
                num_azimuths=32,
                is_rooftop=is_rooftop_mode,
                ground_stand_height_m=1.5,
                include_tree_canopy=has_canopy,
                canopy_transmittance=transmittance.diffuse
            )
            if isinstance(res_svf, np.ndarray) and res_svf.shape == (patch_h, patch_w):
                svf_grid = res_svf
        if svf_grid is None:
            svf_grid = np.ones((patch_h, patch_w), dtype=np.float32)

        # 5c. Precompute discrete module locations and per-module Sky View Factors (terrain + canopy + front-rack occlusion)
        use_discrete_panels = bool(
            request.polygon
            and len(request.polygon) >= 3
            and request.deployment_mode == DeploymentMode.GROUND_MOUNT
            and layout is not None
            and layout.total_panels > 0
        )

        discrete_modules = []
        module_conv = 0.0
        if layout is not None and layout.tables:
            min_lon, min_lat, max_lon, max_lat = geo_info["patch_bounds_wgs84"]
            lon_span = max_lon - min_lon
            lat_span = max_lat - min_lat

            module_area_m2 = layout.module_width_m * layout.module_length_m
            module_conv = module_area_m2 * pv_cfg.module_efficiency * pv_cfg.system_derate / 1000.0

            def _wgs84_to_rc(lon_arr, lat_arr):
                ux, uy = wgs84_to_utm.transform(lon_arr, lat_arr)
                col_f = inv_patch_transform.a * ux + inv_patch_transform.b * uy + inv_patch_transform.c
                row_f = inv_patch_transform.d * ux + inv_patch_transform.e * uy + inv_patch_transform.f
                cc = np.clip(np.floor(col_f).astype(np.intp), 0, patch_w - 1)
                rr = np.clip(np.floor(row_f).astype(np.intp), 0, patch_h - 1)
                return rr, cc

            u_cells_base = (np.arange(CELL_COLS) + 0.5) / float(CELL_COLS)
            v_cells_b = 0.5 * ((np.arange(CELL_ROWS) + 0.5) / float(CELL_ROWS))
            v_cells_t = 0.5 + 0.5 * ((np.arange(CELL_ROWS) + 0.5) / float(CELL_ROWS))

            def _compute_pair_geometry(corners, k, num_pairs):
                c0, c1, c2, c3 = corners[0], corners[1], corners[2], corners[3]
                t0 = k / float(num_pairs)
                t1 = (k + 1) / float(num_pairs)
                t_mid = (k + 0.5) / float(num_pairs)

                lon_bot = (1.0 - t_mid) * c0[0] + t_mid * c1[0]
                lat_bot = (1.0 - t_mid) * c0[1] + t_mid * c1[1]
                lon_top = (1.0 - t_mid) * c3[0] + t_mid * c2[0]
                lat_top = (1.0 - t_mid) * c3[1] + t_mid * c2[1]

                c_lon_b = 0.75 * lon_bot + 0.25 * lon_top
                c_lat_b = 0.75 * lat_bot + 0.25 * lat_top
                c_lon_t = 0.25 * lon_bot + 0.75 * lon_top
                c_lat_t = 0.25 * lat_bot + 0.75 * lat_top

                u_cells = t0 + u_cells_base * (t1 - t0)

                def _cell_grid_indices(v_vec):
                    uu = u_cells[None, :]
                    vv = v_vec[:, None]
                    lon_s = (1.0 - uu) * c0[0] + uu * c1[0]
                    lat_s = (1.0 - uu) * c0[1] + uu * c1[1]
                    lon_n = (1.0 - uu) * c3[0] + uu * c2[0]
                    lat_n = (1.0 - uu) * c3[1] + uu * c2[1]
                    c_lon = (1.0 - vv) * lon_s + vv * lon_n
                    c_lat = (1.0 - vv) * lat_s + vv * lat_n
                    return _wgs84_to_rc(c_lon, c_lat)

                cell_rows_b, cell_cols_b = _cell_grid_indices(v_cells_b)
                cell_rows_t, cell_cols_t = _cell_grid_indices(v_cells_t)
                row_b_arr, col_b_arr = _wgs84_to_rc(c_lon_b, c_lat_b)
                row_t_arr, col_t_arr = _wgs84_to_rc(c_lon_t, c_lat_t)
                return (
                    c_lon_b, c_lat_b, int(row_b_arr), int(col_b_arr), cell_rows_b, cell_cols_b,
                    c_lon_t, c_lat_t, int(row_t_arr), int(col_t_arr), cell_rows_t, cell_cols_t,
                )

            tables_by_row = {}
            for tbl in layout.tables:
                tables_by_row.setdefault(tbl.row_index, []).append(tbl)
            distinct_rows = sorted(tables_by_row.keys())
            min_row_index = distinct_rows[0] if distinct_rows else 0

            for tbl in layout.tables:
                corners = tbl.corners_wgs84
                if not corners or len(corners) < 4:
                    continue

                panel_count = tbl.panel_count or 4
                num_pairs = max(1, panel_count // 2)
                south_tables = tables_by_row.get(tbl.row_index - 1, [])
                is_front_row = (tbl.row_index == min_row_index)
                table_svfs = []

                for k in range(num_pairs):
                    (
                        c_lon_b, c_lat_b, row_b, col_b, cell_rows_b, cell_cols_b,
                        c_lon_t, c_lat_t, row_t, col_t, cell_rows_t, cell_cols_t,
                    ) = _compute_pair_geometry(corners, k, num_pairs)

                    has_south_rack = False
                    if not is_front_row and south_tables:
                        for st in south_tables:
                            sc = st.corners_wgs84
                            if not sc or len(sc) < 4:
                                continue
                            st_min = min(sc[0][0], sc[3][0])
                            st_max = max(sc[1][0], sc[2][0])
                            if st_min <= c_lon_b <= st_max:
                                has_south_rack = True
                                break

                    rack_svf_b = calculate_module_rack_sky_view_factor(
                        row_pitch_m=layout.row_pitch_m,
                        slant_height_m=tbl.slant_height_m or 4.56,
                        tilt_deg=tbl.tilt_deg or 30.0,
                        is_top_module=False,
                        has_south_obstruction=has_south_rack
                    )
                    rack_svf_t = calculate_module_rack_sky_view_factor(
                        row_pitch_m=layout.row_pitch_m,
                        slant_height_m=tbl.slant_height_m or 4.56,
                        tilt_deg=tbl.tilt_deg or 30.0,
                        is_top_module=True,
                        has_south_obstruction=has_south_rack
                    )

                    svf_b = float(np.clip(float(svf_grid[row_b, col_b]) * rack_svf_b, 0.05, 1.0))
                    svf_t = float(np.clip(float(svf_grid[row_t, col_t]) * rack_svf_t, 0.05, 1.0))

                    table_svfs.append(round(svf_b, 4))
                    table_svfs.append(round(svf_t, 4))

                    if use_discrete_panels:
                        discrete_modules.append({
                            "row_idx": row_b,
                            "col_idx": col_b,
                            "cell_rows": cell_rows_b,
                            "cell_cols": cell_cols_b,
                            "table_row_index": tbl.row_index,
                            "is_front_row": is_front_row,
                            "is_top": False,
                            "has_south_rack": has_south_rack,
                            "center_lon": c_lon_b,
                            "center_lat": c_lat_b,
                            "south_tables": south_tables,
                            "svf": svf_b
                        })
                        discrete_modules.append({
                            "row_idx": row_t,
                            "col_idx": col_t,
                            "cell_rows": cell_rows_t,
                            "cell_cols": cell_cols_t,
                            "table_row_index": tbl.row_index,
                            "is_front_row": is_front_row,
                            "is_top": True,
                            "has_south_rack": has_south_rack,
                            "center_lon": c_lon_t,
                            "center_lat": c_lat_t,
                            "south_tables": south_tables,
                            "svf": svf_t
                        })

                tbl.module_svf = table_svfs

        # 5d. Optimize panel tilt per row against full-day real-world energy
        row_tilts = {}
        south_tilt_by_row = {}
        if use_discrete_panels and discrete_modules and daylight_angles and daylight_irradiance:
            row_tilts = _optimize_row_tilts(
                layout=layout,
                tables_by_row=tables_by_row,
                distinct_rows=distinct_rows,
                discrete_modules=discrete_modules,
                svf_grid=svf_grid,
                daylight_angles=daylight_angles,
                daylight_irradiance=daylight_irradiance,
                daylight_masks=daylight_masks,
                daylight_canopy_masks=daylight_canopy_masks,
                daylight_canopy_transmittance=daylight_canopy_transmittance,
                has_canopy=has_canopy,
                canopy_transmittance=transmittance.direct,
            )
            for pos, r_idx in enumerate(distinct_rows):
                south_tilt_by_row[r_idx] = row_tilts[distinct_rows[pos - 1]] if pos > 0 else None

            # Update layout table tilts, center-pivoted footprints, cell grids & per-module SVF
            utm_to_wgs84 = get_transformer(target_crs, "EPSG:4326")
            mod_cursor = 0
            total_tilt_weighted = 0.0
            total_mods_weighted = 0
            for tbl in layout.tables:
                corners = tbl.corners_wgs84
                if not corners or len(corners) < 4:
                    continue
                opt_t = row_tilts.get(tbl.row_index, seasonal_tilt)
                tbl.tilt_deg = opt_t
                slant_h = tbl.slant_height_m or 4.56
                actual_depth_m = round(slant_h * float(np.cos(np.radians(opt_t))), 2)
                tbl.depth_m = actual_depth_m
                if tbl.center_wgs84 and len(tbl.center_wgs84) >= 2 and tbl.width_m:
                    c_x, c_y = wgs84_to_utm.transform(tbl.center_wgs84[0], tbl.center_wgs84[1])
                    half_w = 0.5 * tbl.width_m
                    half_d = 0.5 * slant_h * float(np.cos(np.radians(opt_t)))
                    utmx = [c_x - half_w, c_x + half_w, c_x + half_w, c_x - half_w]
                    utmy = [c_y - half_d, c_y - half_d, c_y + half_d, c_y + half_d]
                    lons, lats = utm_to_wgs84.transform(utmx, utmy)
                    tbl.corners_wgs84 = [
                        [round(float(lo), 7), round(float(la), 7)]
                        for lo, la in zip(lons, lats)
                    ]
                    corners = tbl.corners_wgs84

                s_tilt = south_tilt_by_row.get(tbl.row_index)
                total_tilt_weighted += opt_t * tbl.panel_count
                total_mods_weighted += tbl.panel_count
                new_table_svfs = []
                num_pairs = max(1, (tbl.panel_count or 4) // 2)
                for k in range(num_pairs):
                    (
                        c_lon_b, c_lat_b, row_b, col_b, cell_rows_b, cell_cols_b,
                        c_lon_t, c_lat_t, row_t, col_t, cell_rows_t, cell_cols_t,
                    ) = _compute_pair_geometry(corners, k, num_pairs)
                    m_b = discrete_modules[mod_cursor]
                    m_t = discrete_modules[mod_cursor + 1]
                    mod_cursor += 2
                    m_b["center_lon"], m_b["center_lat"] = c_lon_b, c_lat_b
                    m_b["row_idx"], m_b["col_idx"] = row_b, col_b
                    m_b["cell_rows"], m_b["cell_cols"] = cell_rows_b, cell_cols_b
                    m_t["center_lon"], m_t["center_lat"] = c_lon_t, c_lat_t
                    m_t["row_idx"], m_t["col_idx"] = row_t, col_t
                    m_t["cell_rows"], m_t["cell_cols"] = cell_rows_t, cell_cols_t
                    r_svf_b = calculate_module_rack_sky_view_factor(
                        row_pitch_m=layout.row_pitch_m,
                        slant_height_m=slant_h,
                        tilt_deg=opt_t,
                        is_top_module=False,
                        has_south_obstruction=m_b["has_south_rack"],
                        south_tilt_deg=s_tilt
                    )
                    r_svf_t = calculate_module_rack_sky_view_factor(
                        row_pitch_m=layout.row_pitch_m,
                        slant_height_m=slant_h,
                        tilt_deg=opt_t,
                        is_top_module=True,
                        has_south_obstruction=m_t["has_south_rack"],
                        south_tilt_deg=s_tilt
                    )
                    m_b["svf"] = float(np.clip(float(svf_grid[row_b, col_b]) * r_svf_b, 0.05, 1.0))
                    m_t["svf"] = float(np.clip(float(svf_grid[row_t, col_t]) * r_svf_t, 0.05, 1.0))
                    new_table_svfs.extend([round(m_b["svf"], 4), round(m_t["svf"], 4)])
                tbl.module_svf = new_table_svfs

            if total_mods_weighted > 0:
                seasonal_tilt = round(total_tilt_weighted / total_mods_weighted, 1)

        if use_discrete_panels and discrete_modules:
            sum_mod_svf = float(sum(m["svf"] for m in discrete_modules))
            avg_svf = sum_mod_svf / len(discrete_modules)
        elif polygon_mask is not None:
            sum_mod_svf = 0.0
            avg_svf = float(np.mean(svf_grid[polygon_mask]))
        else:
            sum_mod_svf = 0.0
            avg_svf = float(np.mean(svf_grid))

        # 6. Compute power for all timesteps
        timeseries_metrics = []
        daylight_counter = 0

        peak_power_kw = 0.0
        peak_time = None
        sunrise_time = None
        sunset_time = None
        shaded_pct_list = []
        canopy_shaded_pct_list = []

        daylight_index_set = set(daylight_indices)

        for idx, ts in enumerate(timestamps):
            py_dt = ts.to_pydatetime()
            ts_str = py_dt.isoformat()
            angles = all_angles[idx]

            if idx in daylight_index_set:
                if sunrise_time is None:
                    sunrise_time = ts_str
                sunset_time = ts_str

                mask = daylight_masks[daylight_counter]
                canopy_m = daylight_canopy_masks[daylight_counter] if has_canopy else None
                canopy_t_grid = (
                    daylight_canopy_transmittance[daylight_counter]
                    if (has_canopy and daylight_counter < len(daylight_canopy_transmittance))
                    else None
                )
                irradiance = daylight_irradiance[daylight_counter]

                if use_discrete_panels:
                    # Discrete module-level physics simulation (exact sum of physical panels)
                    num_mods = len(discrete_modules)

                    num_terrain_shaded = 0
                    num_canopy_shaded = 0
                    total_geo_loss_kw = 0.0
                    total_canopy_loss_kw = 0.0
                    total_self_loss_kw = 0.0
                    total_power_kw = 0.0

                    az_delta_rad = np.radians(angles.azimuth_deg - 180.0)
                    cos_az_delta = np.cos(az_delta_rad)
                    tan_az_delta = np.tan(az_delta_rad) if cos_az_delta > 0.001 else 0.0

                    # Pre-calculate per-row POA irradiance and self-shading fraction
                    poa_dir_by_row = {}
                    poa_dif_by_row = {}
                    rack_self_by_row = {}
                    ref_slant = layout.tables[0].slant_height_m if layout.tables else 4.56
                    ref_az = layout.tables[0].azimuth_deg if layout.tables else 180.0
                    for r_idx in distinct_rows:
                        r_tilt = row_tilts.get(r_idx, seasonal_tilt)
                        aoi_val = float(pvlib.irradiance.aoi(r_tilt, ref_az, angles.zenith_deg, angles.azimuth_deg))
                        cos_inc = max(0.0, float(np.cos(np.radians(aoi_val))))
                        poa_dir_by_row[r_idx] = irradiance.dni_w_m2 * cos_inc
                        poa_dif_by_row[r_idx] = irradiance.dhi_w_m2 * 0.5 * (1.0 + float(np.cos(np.radians(r_tilt))))
                        if cos_az_delta > 0.001 and angles.elevation_deg > 0.0:
                            rack_self_by_row[r_idx] = calculate_row_self_shading_fraction(
                                row_pitch_m=layout.row_pitch_m,
                                slant_height_m=ref_slant,
                                tilt_deg=r_tilt,
                                solar_azimuth_deg=angles.azimuth_deg,
                                solar_elevation_deg=angles.elevation_deg,
                                rack_azimuth_deg=ref_az,
                                south_tilt_deg=south_tilt_by_row.get(r_idx)
                            )
                        else:
                            rack_self_by_row[r_idx] = 0.0

                    incident_total = 0.0
                    diffuse_total = 0.0

                    for mod in discrete_modules:
                        c_rows = mod["cell_rows"]
                        c_cols = mod["cell_cols"]
                        r_idx = mod["table_row_index"]
                        direct_mod_w = poa_dir_by_row[r_idx] * module_conv
                        mod_diffuse_w = poa_dif_by_row[r_idx] * module_conv * mod["svf"]
                        incident_total += direct_mod_w
                        diffuse_total += mod_diffuse_w
                        rack_self_frac = rack_self_by_row[r_idx]

                        terrain_lit_cells = (mask[c_rows, c_cols] > 0)
                        if canopy_t_grid is not None:
                            canopy_tau_cells = canopy_t_grid[c_rows, c_cols]
                        elif canopy_m is not None:
                            canopy_tau_cells = np.where(canopy_m[c_rows, c_cols] > 0, 1.0, canopy_transmittance)
                        else:
                            canopy_tau_cells = np.ones((CELL_ROWS, CELL_COLS), dtype=np.float64)

                        has_obstruction = False
                        if rack_self_frac > 1e-4 and (not mod["is_front_row"]) and mod["south_tables"]:
                            delta_x_m = layout.row_pitch_m * tan_az_delta
                            m_per_deg_lon = 111320.0 * np.cos(np.radians(mod["center_lat"]))
                            delta_lon = delta_x_m / m_per_deg_lon if m_per_deg_lon > 0 else 0.0
                            lon_source = mod["center_lon"] - delta_lon

                            for st in mod["south_tables"]:
                                sc = st.corners_wgs84
                                if not sc or len(sc) < 4:
                                    continue
                                st_min = min(sc[0][0], sc[3][0])
                                st_max = max(sc[1][0], sc[2][0])
                                if st_min <= lon_source <= st_max:
                                    has_obstruction = True
                                    break

                        geo_frac, self_frac, canopy_frac, direct_frac = compute_split_halfcut_module_losses(
                            terrain_lit_cells=terrain_lit_cells,
                            canopy_tau_cells=canopy_tau_cells,
                            rack_self_frac=rack_self_frac,
                            is_top=mod["is_top"],
                            has_obstruction=has_obstruction,
                        )

                        if geo_frac > 0.0:
                            num_terrain_shaded += geo_frac
                        if canopy_frac > 0.0:
                            num_canopy_shaded += (canopy_frac / max(1e-6, 1.0 - canopy_transmittance))

                        geo_loss = direct_mod_w * geo_frac
                        self_loss = direct_mod_w * self_frac
                        canopy_loss = direct_mod_w * canopy_frac
                        direct_reaching = direct_mod_w * direct_frac
                        mod_pwr = max(0.0, direct_reaching + mod_diffuse_w)

                        total_geo_loss_kw += geo_loss
                        total_canopy_loss_kw += canopy_loss
                        total_self_loss_kw += self_loss
                        total_power_kw += mod_pwr

                    incident_power_kw = round(incident_total, 3)
                    diffuse_power_kw = round(diffuse_total, 3)
                    unshaded_power_kw = round(incident_power_kw + diffuse_power_kw, 3)
                    percent_shaded = round((num_terrain_shaded / num_mods) * 100.0, 2)
                    canopy_shaded_pct = round((num_canopy_shaded / num_mods) * 100.0, 2)
                    shaded_pct_list.append(percent_shaded)
                    canopy_shaded_pct_list.append(canopy_shaded_pct)

                    power_kw = round(total_power_kw, 3)
                    canopy_loss_kw = round(total_canopy_loss_kw, 3)
                    self_shading_loss_kw = round(total_self_loss_kw, 3)
                    geological_loss_kw = round(total_geo_loss_kw, 3)
                else:
                    total_active_cells = int(np.count_nonzero(polygon_mask)) if polygon_mask is not None else int(mask.size)
                    conv_factor = cell_area_m2 * pv_cfg.effective_gcr * pv_cfg.module_efficiency * pv_cfg.system_derate / 1000.0

                    incident_power_kw = round(
                        total_active_cells * irradiance.poa_direct_w_m2 * conv_factor,
                        3
                    )
                    diffuse_power_kw = round(
                        total_active_cells * irradiance.poa_diffuse_w_m2 * avg_svf * conv_factor,
                        3
                    )
                    unshaded_power_kw = round(incident_power_kw + diffuse_power_kw, 3)

                    if polygon_mask is not None:
                        t_unshaded = (mask > 0) & polygon_mask
                        t_unshaded_cells = int(np.count_nonzero(t_unshaded))
                        percent_shaded = round((1.0 - (t_unshaded_cells / total_active_cells)) * 100.0, 2) if total_active_cells > 0 else 0.0
                    else:
                        t_unshaded = mask > 0
                        t_unshaded_cells = int(np.count_nonzero(t_unshaded))
                        percent_shaded = round((1.0 - (t_unshaded_cells / mask.size)) * 100.0, 2) if mask.size > 0 else 0.0

                    direct_terrain_unshaded_kw = t_unshaded_cells * irradiance.poa_direct_w_m2 * conv_factor

                    # Calculate array self-shading fraction from 3D layout geometry
                    f_self = calculate_array_self_shading_fraction(layout, angles.azimuth_deg, angles.elevation_deg)

                    # Self-shading blocks f_self of direct beam on terrain-unshaded cells (opaque solid shade)
                    if f_self > 0.0 and irradiance.poa_direct_w_m2 > 0.001:
                        self_shading_loss_kw = round(float(f_self * direct_terrain_unshaded_kw), 3)
                    else:
                        self_shading_loss_kw = 0.0

                    unblocked_direct_kw = max(0.0, direct_terrain_unshaded_kw - self_shading_loss_kw)

                    # Vegetative tree canopy attenuates remaining unblocked direct beam
                    if canopy_m is not None and irradiance.poa_direct_w_m2 > 0.001:
                        c_shaded = t_unshaded & (~(canopy_m > 0))
                        canopy_shaded_cells = int(np.count_nonzero(c_shaded))
                        canopy_shaded_pct = round((canopy_shaded_cells / total_active_cells) * 100.0, 2) if total_active_cells > 0 else 0.0
                    else:
                        canopy_shaded_cells = 0
                        canopy_shaded_pct = 0.0

                    shaded_pct_list.append(percent_shaded)
                    canopy_shaded_pct_list.append(canopy_shaded_pct)

                    if t_unshaded_cells > 0:
                        if canopy_t_grid is not None:
                            avg_canopy_loss_frac = float(np.mean(1.0 - canopy_t_grid[t_unshaded]))
                            canopy_loss_kw = round(unblocked_direct_kw * avg_canopy_loss_frac, 3)
                        else:
                            canopy_loss_kw = round(
                                (canopy_shaded_cells / t_unshaded_cells) * unblocked_direct_kw * (1.0 - canopy_transmittance),
                                3
                            )
                    else:
                        canopy_loss_kw = 0.0

                    direct_reaching_kw = max(0.0, unblocked_direct_kw - canopy_loss_kw)
                    power_kw = round(direct_reaching_kw + diffuse_power_kw, 3)
                    geological_loss_kw = round(
                        max(0.0, incident_power_kw - direct_terrain_unshaded_kw),
                        3
                    )

                if power_kw > peak_power_kw:
                    peak_power_kw = power_kw
                    peak_time = ts_str

                is_diffuse_only = bool(angles.elevation_deg > 0.0 and irradiance.poa_direct_w_m2 <= 0.001 and unshaded_power_kw > 0.0)

                timeseries_metrics.append(
                    TimestepMetric(
                        timestamp=ts_str,
                        solar_azimuth_deg=round(angles.azimuth_deg, 2),
                        solar_elevation_deg=round(angles.elevation_deg, 2),
                        power_kw=power_kw,
                        unshaded_power_kw=unshaded_power_kw,
                        incident_power_kw=incident_power_kw,
                        diffuse_power_kw=diffuse_power_kw,
                        canopy_loss_kw=canopy_loss_kw,
                        geological_loss_kw=geological_loss_kw,
                        self_shading_loss_kw=self_shading_loss_kw,
                        percent_shaded=percent_shaded,
                        canopy_shaded_pct=canopy_shaded_pct,
                        is_daylight=True,
                        mask_index=daylight_counter,
                        optimal_tilt_deg=seasonal_tilt,
                        is_diffuse_only=is_diffuse_only
                    )
                )
                daylight_counter += 1
            else:
                # Nighttime frame
                timeseries_metrics.append(
                    TimestepMetric(
                        timestamp=ts_str,
                        solar_azimuth_deg=round(angles.azimuth_deg, 2),
                        solar_elevation_deg=round(angles.elevation_deg, 2),
                        power_kw=0.0,
                        unshaded_power_kw=0.0,
                        incident_power_kw=0.0,
                        diffuse_power_kw=0.0,
                        canopy_loss_kw=0.0,
                        geological_loss_kw=0.0,
                        self_shading_loss_kw=0.0,
                        percent_shaded=100.0,
                        canopy_shaded_pct=0.0,
                        is_daylight=False,
                        mask_index=None,
                        optimal_tilt_deg=seasonal_tilt,
                        is_diffuse_only=False
                    )
                )

        # Numerical integration using trapezoidal rule over 24h curve
        power_values = [m.power_kw for m in timeseries_metrics]
        unshaded_power_values = [m.unshaded_power_kw for m in timeseries_metrics]
        canopy_loss_values = [m.canopy_loss_kw for m in timeseries_metrics]
        self_shading_values = [m.self_shading_loss_kw for m in timeseries_metrics]

        total_daily_kwh = float(np.trapezoid(power_values, dx=step_min / 60.0))
        unshaded_daily_kwh = float(np.trapezoid(unshaded_power_values, dx=step_min / 60.0))
        canopy_loss_kwh = float(np.trapezoid(canopy_loss_values, dx=step_min / 60.0))
        canopy_loss_pct = float(round((canopy_loss_kwh / unshaded_daily_kwh * 100.0), 1)) if unshaded_daily_kwh > 0 else 0.0
        self_shading_loss_kwh = float(np.trapezoid(self_shading_values, dx=step_min / 60.0))
        self_shading_loss_pct = float(round((self_shading_loss_kwh / unshaded_daily_kwh * 100.0), 1)) if unshaded_daily_kwh > 0 else 0.0
        unshaded_peak_kw = float(max(unshaded_power_values)) if unshaded_power_values else 0.0

        # 7. Encode daytime masks
        # When context_expansion is active, keep full-frame shading across the entire context window!
        # Only when NO context expansion is present and an oblong polygon is selected do we clip shadows to the polygon.
        def _clip_and_encode(t_masks, c_masks):
            if polygon_mask is not None and t_masks and not has_context_expansion:
                exp_t = []
                exp_c = []
                for m, cm in zip(t_masks, c_masks):
                    em = m.copy()
                    em[~polygon_mask] = 1  # 1 = transparent in UI canvas
                    exp_t.append(em)
                    ecm = cm.copy()
                    ecm[~polygon_mask] = 1
                    exp_c.append(ecm)
                return encode_masks_batch(exp_t), encode_masks_batch(exp_c)
            return encode_masks_batch(t_masks), encode_masks_batch(c_masks)

        encoded_masks, encoded_canopy_masks = _clip_and_encode(daylight_masks, daylight_canopy_masks)
        encoded_visual_masks = None
        encoded_visual_canopy_masks = None
        if visual_daylight_masks is not None and visual_daylight_canopy_masks is not None:
            encoded_visual_masks, encoded_visual_canopy_masks = _clip_and_encode(
                visual_daylight_masks, visual_daylight_canopy_masks
            )

        def _encode_shade_levels(paths, precomputed_arr=None):
            if precomputed_arr is not None:
                return [base64.b64encode(precomputed_arr[i].tobytes()).decode("ascii") for i in range(precomputed_arr.shape[0])]
            if not paths:
                return None
            out = []
            for p_grid in paths:
                lvl = quantize_canopy_shade_levels(p_grid, canopy_transmittance)
                if polygon_mask is not None and not has_context_expansion:
                    lvl = lvl.copy()
                    lvl[~polygon_mask] = 0
                flat = lvl.ravel()
                if flat.size & 1:
                    flat = np.pad(flat, (0, 1), mode="constant")
                packed = ((flat[0::2] << 4) | flat[1::2]).astype(np.uint8)
                out.append(base64.b64encode(packed.tobytes()).decode("ascii"))
            return out

        encoded_canopy_shade_levels = _encode_shade_levels(visual_daylight_paths, visual_canopy_shade_levels_arr)
        encoded_ground_canopy_shade_levels = _encode_shade_levels(daylight_canopy_paths, ground_canopy_shade_levels_arr)

        # Encode nighttime masks (0 = shaded inside shape, 1 = transparent outside)
        # When context_expansion is active, night covers the whole visual context boundary!
        night_grid = np.zeros((patch_h, patch_w), dtype=np.uint8)
        night_canopy_grid = np.ones((patch_h, patch_w), dtype=np.uint8)
        if polygon_mask is not None and not has_context_expansion:
            night_grid[~polygon_mask] = 1
            night_canopy_grid[~polygon_mask] = 1
        encoded_night_mask = encode_mask_bitmask(night_grid)
        encoded_night_canopy_mask = encode_mask_bitmask(night_canopy_grid)

        # 8. Daily Summary
        daylight_hours = round(len(daylight_indices) * (step_min / 60.0), 2)
        avg_shaded = round(float(np.mean(shaded_pct_list)), 2) if shaded_pct_list else 0.0
        avg_canopy_shaded = round(float(np.mean(canopy_shaded_pct_list)), 2) if canopy_shaded_pct_list else 0.0

        daily_summary = DailySummary(
            total_daily_kwh=round(total_daily_kwh, 2),
            unshaded_daily_kwh=round(unshaded_daily_kwh, 2),
            canopy_loss_kwh=round(canopy_loss_kwh, 2),
            canopy_loss_pct=round(canopy_loss_pct, 1),
            self_shading_loss_kwh=round(self_shading_loss_kwh, 2),
            self_shading_loss_pct=round(self_shading_loss_pct, 1),
            peak_power_kw=round(peak_power_kw, 2),
            unshaded_peak_kw=round(unshaded_peak_kw, 2),
            peak_time=peak_time,
            sunrise_time=sunrise_time,
            sunset_time=sunset_time,
            daylight_hours=daylight_hours,
            avg_shaded_pct=avg_shaded,
            avg_canopy_shaded_pct=avg_canopy_shaded,
            avg_sky_view_factor=round(avg_svf, 3),
            optimal_tilt_deg=seasonal_tilt,
            total_panels=layout.total_panels if layout else None,
            installed_dc_kw=layout.installed_dc_kw if layout else None
        )

        effective_area = polygon_area_m2 if polygon_area_m2 is not None else geo_info["patch_area_m2"]

        metadata = SimulateMetadata(
            patch_width_m=round(geo_info["patch_width_m"], 2),
            patch_height_m=round(geo_info["patch_height_m"], 2),
            patch_area_m2=round(effective_area, 2),
            patch_bounds_wgs84=list(geo_info["patch_bounds_wgs84"]),
            grid_rows=patch_h,
            grid_cols=patch_w,
            median_elevation_m=round(median_elev, 2),
            crs=elev_data["crs"],
            tile_source=elev_data["tile_source"],
            dsm_tile_source=dsm_tile_source,
            has_canopy_data=has_canopy,
            include_tree_canopy=request.include_tree_canopy,
            canopy_mode=request.canopy_mode,
            canopy_transmittance=round(canopy_transmittance, 3),
            avg_sky_view_factor=round(avg_svf, 3),
            date=request.date,
            time_step_minutes=step_min,
            buffer_meters=request.buffer_meters,
            resolution_m=request.resolution_m,
            deployment_mode=pv_cfg.deployment_mode.value,
            effective_gcr=pv_cfg.effective_gcr,
            module_efficiency=pv_cfg.module_efficiency,
            system_derate=pv_cfg.system_derate,
            optimal_tilt_deg=seasonal_tilt
        )

        # Quantize Canopy Height Model (CHM) in 0.5m units for front-end shadow ray-marching
        chm_base64 = None
        if has_canopy and "chm" in elev_data:
            patch_chm = elev_data["chm"][patch_slice_y, patch_slice_x]
            # Quantize to 0.5m units in uint8 (0..127.5m)
            chm_uint8 = np.clip(np.round(patch_chm * 2.0), 0, 255).astype(np.uint8)
            chm_base64 = base64.b64encode(chm_uint8.tobytes()).decode("ascii")

        return SimulateResponse(
            metadata=metadata,
            daily_summary=daily_summary,
            timeseries=timeseries_metrics,
            mask_encoding="bitmask_base64",
            masks=encoded_masks,
            canopy_masks=encoded_canopy_masks,
            visual_masks=encoded_visual_masks,
            visual_canopy_masks=encoded_visual_canopy_masks,
            canopy_shade_levels=encoded_canopy_shade_levels,
            ground_canopy_shade_levels=encoded_ground_canopy_shade_levels,
            canopy_transmittance=canopy_transmittance,
            layout=layout,
            night_mask=encoded_night_mask,
            night_canopy_mask=encoded_night_canopy_mask,
            chm_base64=chm_base64
        )
