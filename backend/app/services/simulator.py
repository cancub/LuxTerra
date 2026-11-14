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
from .elevation.geo_utils import transform_geometry
from .serializer import encode_masks_batch, encode_mask_bitmask
from .solar.phenology import calculate_canopy_transmittance
from .occlusion.ray_math import compute_canopy_transmittance_grid, quantize_canopy_shade_levels
from .pv.packing_engine import PVPackingEngine
from .pv.self_shading import (
    calculate_array_self_shading_fraction,
    calculate_row_self_shading_fraction,
    calculate_module_rack_sky_view_factor
)

TZ_QUEBEC = zoneinfo.ZoneInfo(DEFAULT_TIMEZONE)


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
        has_canopy = bool(elev_data.get("has_canopy", False)) and request.include_tree_canopy and (request.canopy_mode != "bare_terrain")
        dsm_tile_source = elev_data.get("dsm_tile_source")

        patch_slice_y = elev_data["patch_slice_y"]
        patch_slice_x = elev_data["patch_slice_x"]
        median_elev = elev_data["median_elevation_m"]
        geo_info = elev_data["geo_info"]

        patch_h = patch_slice_y.stop - patch_slice_y.start
        patch_w = patch_slice_x.stop - patch_slice_x.start
        cell_area_m2 = request.resolution_m * request.resolution_m

        # Compute seasonal canopy transmittance
        transmittance = calculate_canopy_transmittance(request.date, mode=request.canopy_mode)
        canopy_transmittance = transmittance.direct

        # 1b. Rasterize inclusion mask for the solar panel generation domain
        # If polygon is supplied, rasterize it.
        # If no polygon is supplied but a wider context_bbox was used, rasterize solar_bbox as the inclusion mask.
        polygon_mask = None
        polygon_area_m2 = None
        has_context_expansion = bool(request.context_bbox is not None)

        if request.polygon and len(request.polygon) >= 3:
            from shapely.geometry import Polygon as ShapelyPolygon
            import rasterio.features
            import rasterio.transform

            poly_wgs84 = ShapelyPolygon(request.polygon)
            target_crs = elev_data["crs"]
            poly_utm = transform_geometry(poly_wgs84, "EPSG:4326", target_crs)
            polygon_area_m2 = float(poly_utm.area)

            p_min_x, p_min_y, p_max_x, p_max_y = geo_info["patch_bounds_metric"]
            patch_transform = rasterio.transform.from_bounds(
                p_min_x, p_min_y, p_max_x, p_max_y, patch_w, patch_h
            )
            polygon_mask = rasterio.features.rasterize(
                [poly_utm],
                out_shape=(patch_h, patch_w),
                transform=patch_transform,
                fill=0,
                default_value=1,
                dtype=np.uint8
            ).astype(bool)
            if not np.any(polygon_mask):
                polygon_mask = None
        elif has_context_expansion:
            from shapely.geometry import box as ShapelyBox
            import rasterio.features
            import rasterio.transform

            # Mask only the interior solar_bbox within the wider context patch
            target_crs = elev_data["crs"]
            box_utm = transform_geometry(
                ShapelyBox(solar_bbox.min_lon, solar_bbox.min_lat, solar_bbox.max_lon, solar_bbox.max_lat),
                "EPSG:4326",
                target_crs
            )
            polygon_area_m2 = float(box_utm.area)
            p_min_x, p_min_y, p_max_x, p_max_y = geo_info["patch_bounds_metric"]
            patch_transform = rasterio.transform.from_bounds(
                p_min_x, p_min_y, p_max_x, p_max_y, patch_w, patch_h
            )
            polygon_mask = rasterio.features.rasterize(
                [box_utm],
                out_shape=(patch_h, patch_w),
                transform=patch_transform,
                fill=0,
                default_value=1,
                dtype=np.uint8
            ).astype(bool)
            if not np.any(polygon_mask):
                polygon_mask = None

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

            if has_canopy and not is_rooftop and hasattr(self.occlusion_engine, "compute_ground_and_top_shadow_masks_batch"):
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

            tables_by_row = {}
            for tbl in layout.tables:
                tables_by_row.setdefault(tbl.row_index, []).append(tbl)
            distinct_rows = sorted(tables_by_row.keys())
            min_row_index = distinct_rows[0] if distinct_rows else 0

            for tbl in layout.tables:
                corners = tbl.corners_wgs84
                if not corners or len(corners) < 4:
                    continue
                c0 = corners[0]  # SW
                c1 = corners[1]  # SE
                c2 = corners[2]  # NE
                c3 = corners[3]  # NW

                panel_count = tbl.panel_count or 4
                num_pairs = max(1, panel_count // 2)
                south_tables = tables_by_row.get(tbl.row_index - 1, [])
                is_front_row = (tbl.row_index == min_row_index)
                table_svfs = []

                for k in range(num_pairs):
                    t_mid = (k + 0.5) / float(num_pairs)

                    lon_bot = (1.0 - t_mid) * c0[0] + t_mid * c1[0]
                    lat_bot = (1.0 - t_mid) * c0[1] + t_mid * c1[1]
                    lon_top = (1.0 - t_mid) * c3[0] + t_mid * c2[0]
                    lat_top = (1.0 - t_mid) * c3[1] + t_mid * c2[1]

                    c_lon_b = 0.75 * lon_bot + 0.25 * lon_top
                    c_lat_b = 0.75 * lat_bot + 0.25 * lat_top
                    c_lon_t = 0.25 * lon_bot + 0.75 * lon_top
                    c_lat_t = 0.25 * lat_bot + 0.75 * lat_top

                    col_b = min(patch_w - 1, max(0, int(((c_lon_b - min_lon) / lon_span) * patch_w))) if lon_span > 0 else 0
                    row_b = min(patch_h - 1, max(0, int(((max_lat - c_lat_b) / lat_span) * patch_h))) if lat_span > 0 else 0

                    col_t = min(patch_w - 1, max(0, int(((c_lon_t - min_lon) / lon_span) * patch_w))) if lon_span > 0 else 0
                    row_t = min(patch_h - 1, max(0, int(((max_lat - c_lat_t) / lat_span) * patch_h))) if lat_span > 0 else 0

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
                            "is_front_row": is_front_row,
                            "is_top": False,
                            "center_lon": c_lon_b,
                            "center_lat": c_lat_b,
                            "south_tables": south_tables,
                            "tilt_deg": tbl.tilt_deg or 30.0,
                            "slant_h": tbl.slant_height_m or 4.56,
                            "svf": svf_b
                        })
                        discrete_modules.append({
                            "row_idx": row_t,
                            "col_idx": col_t,
                            "is_front_row": is_front_row,
                            "is_top": True,
                            "center_lon": c_lon_t,
                            "center_lat": c_lat_t,
                            "south_tables": south_tables,
                            "tilt_deg": tbl.tilt_deg or 30.0,
                            "slant_h": tbl.slant_height_m or 4.56,
                            "svf": svf_t
                        })

                tbl.module_svf = table_svfs

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

        for idx, ts in enumerate(timestamps):
            py_dt = ts.to_pydatetime()
            ts_str = py_dt.isoformat()
            angles = all_angles[idx]

            if idx in daylight_indices:
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

                    # Pre-calculate row self-shade fraction if sun is facing array from the south
                    rack_self_frac = 0.0
                    if cos_az_delta > 0.001 and angles.elevation_deg > 0.0 and layout.tables:
                        ref_table = layout.tables[0]
                        rack_self_frac = calculate_row_self_shading_fraction(
                            row_pitch_m=layout.row_pitch_m,
                            slant_height_m=ref_table.slant_height_m,
                            tilt_deg=ref_table.tilt_deg,
                            solar_azimuth_deg=angles.azimuth_deg,
                            solar_elevation_deg=angles.elevation_deg,
                            rack_azimuth_deg=ref_table.azimuth_deg
                        )

                    poa_direct = irradiance.poa_direct_w_m2
                    poa_diffuse = irradiance.poa_diffuse_w_m2

                    direct_mod_w = poa_direct * module_conv
                    base_diffuse_mod_w = poa_diffuse * module_conv
                    incident_power_kw = round(num_mods * direct_mod_w, 3)
                    diffuse_power_kw = round(sum_mod_svf * base_diffuse_mod_w, 3)
                    unshaded_power_kw = round(incident_power_kw + diffuse_power_kw, 3)

                    for mod in discrete_modules:
                        r = mod["row_idx"]
                        c = mod["col_idx"]
                        mod_diffuse_w = base_diffuse_mod_w * mod["svf"]

                        terrain_lit = bool(mask[r, c] > 0)
                        canopy_lit = bool(canopy_m[r, c] > 0) if canopy_m is not None else True

                        if not terrain_lit:
                            num_terrain_shaded += 1
                            geo_loss = direct_mod_w
                            canopy_loss = 0.0
                            self_loss = 0.0
                            mod_pwr = mod_diffuse_w
                        else:
                            geo_loss = 0.0
                            # Solid panel self-shading takes physical precedence over semi-transparent tree canopy shade
                            self_loss = 0.0
                            mod_frac = 0.0
                            if rack_self_frac > 0.0 and (not mod["is_front_row"]) and mod["south_tables"]:
                                delta_x_m = layout.row_pitch_m * tan_az_delta
                                m_per_deg_lon = 111320.0 * np.cos(np.radians(mod["center_lat"]))
                                delta_lon = delta_x_m / m_per_deg_lon if m_per_deg_lon > 0 else 0.0
                                lon_source = mod["center_lon"] - delta_lon

                                has_obstruction = False
                                for st in mod["south_tables"]:
                                    sc = st.corners_wgs84
                                    if not sc or len(sc) < 4:
                                        continue
                                    st_min = min(sc[0][0], sc[3][0])
                                    st_max = max(sc[1][0], sc[2][0])
                                    if st_min <= lon_source <= st_max:
                                        has_obstruction = True
                                        break

                                if has_obstruction:
                                    if not mod["is_top"]:
                                        mod_frac = float(np.clip(rack_self_frac * 2.0, 0.0, 1.0))
                                    else:
                                        mod_frac = float(np.clip((rack_self_frac - 0.5) * 2.0, 0.0, 1.0))
                                    self_loss = direct_mod_w * mod_frac

                            unblocked_direct = max(0.0, direct_mod_w - self_loss)

                            if canopy_t_grid is not None:
                                local_tau = float(canopy_t_grid[r, c])
                                if local_tau < 0.999 and unblocked_direct > 0.0:
                                    num_canopy_shaded += 1
                                    canopy_loss = unblocked_direct * (1.0 - local_tau)
                                    direct_reaching = unblocked_direct * local_tau
                                else:
                                    canopy_loss = 0.0
                                    direct_reaching = unblocked_direct
                            elif not canopy_lit and unblocked_direct > 0.0:
                                num_canopy_shaded += 1
                                canopy_loss = unblocked_direct * (1.0 - canopy_transmittance)
                                direct_reaching = unblocked_direct * canopy_transmittance
                            else:
                                canopy_loss = 0.0
                                direct_reaching = unblocked_direct

                            mod_pwr = max(0.0, direct_reaching + mod_diffuse_w)

                        total_geo_loss_kw += geo_loss
                        total_canopy_loss_kw += canopy_loss
                        total_self_loss_kw += self_loss
                        total_power_kw += mod_pwr

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
                    if canopy_m is not None:
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

        def _encode_shade_levels(paths):
            if not paths:
                return None
            out = []
            for p_grid in paths:
                lvl = quantize_canopy_shade_levels(p_grid, canopy_transmittance)
                if polygon_mask is not None and not has_context_expansion:
                    lvl = lvl.copy()
                    lvl[~polygon_mask] = 0
                out.append(base64.b64encode(lvl.tobytes()).decode("ascii"))
            return out

        encoded_canopy_shade_levels = _encode_shade_levels(visual_daylight_paths)
        encoded_ground_canopy_shade_levels = _encode_shade_levels(daylight_canopy_paths)

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
