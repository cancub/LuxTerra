"""
Simulation Orchestrator Service.
Coordinates elevation extraction, vectorized solar geometry, batch GPU ray-marching,
PV yield conversion, and daily integration.
"""

from typing import Optional, List
from datetime import datetime, date, time
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
        pv_model: PVSystemModel
    ):
        self.elevation_provider = elevation_provider
        self.solar_engine = solar_engine
        self.occlusion_engine = occlusion_engine
        self.pv_model = pv_model

    def run_simulation(self, request: SimulateRequest) -> SimulateResponse:
        """
        Executes a 24-hour simulation for the requested bounding box and date.
        """
        # 1. Extract elevation window (co-registered DTM, DSM, and CHM)
        bbox = request.bbox
        elev_data = self.elevation_provider.get_elevation_window(
            min_lon=bbox.min_lon,
            min_lat=bbox.min_lat,
            max_lon=bbox.max_lon,
            max_lat=bbox.max_lat,
            buffer_meters=request.buffer_meters,
            target_resolution_m=request.resolution_m
        )

        dtm_grid = elev_data.get("dtm", elev_data["buffered_elevation"])
        dsm_grid = elev_data.get("dsm", dtm_grid)
        has_canopy = bool(elev_data.get("has_canopy", False)) and request.include_tree_canopy
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

        # 1b. Rasterize polygon inclusion mask if an oblong/custom shape was requested
        polygon_mask = None
        polygon_area_m2 = None
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

        # 2. Build 24-hour timestep intervals (robust against DST transitions)
        sim_date = date.fromisoformat(request.date)
        step_min = request.time_step_minutes
        
        start_dt = datetime.combine(sim_date, time(0, 0), tzinfo=TZ_QUEBEC)
        end_dt = datetime.combine(sim_date, time(23, 59, 59), tzinfo=TZ_QUEBEC)
        timestamps = pd.date_range(start=start_dt, end=end_dt, freq=f"{step_min}min")

        center_lon = (bbox.min_lon + bbox.max_lon) / 2.0
        center_lat = (bbox.min_lat + bbox.max_lat) / 2.0

        # 3. Vectorized calculation of all solar positions
        all_angles = self.solar_engine.calculate_solar_angles_series(timestamps, center_lat, center_lon)

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
            if has_canopy:
                is_rooftop = (request.deployment_mode == DeploymentMode.ROOFTOP)
                daylight_masks, daylight_canopy_masks = self.occlusion_engine.compute_dual_shadow_masks_batch(
                    dtm_grid=dtm_grid,
                    dsm_grid=dsm_grid,
                    patch_slice_y=patch_slice_y,
                    patch_slice_x=patch_slice_x,
                    sun_angles=daylight_angle_pairs,
                    resolution_m=request.resolution_m,
                    max_search_radius_m=request.buffer_meters,
                    is_rooftop=is_rooftop,
                    ground_stand_height_m=1.5
                )
            else:
                daylight_masks = self.occlusion_engine.compute_shadow_masks_batch(
                    elevation_grid=dtm_grid,
                    patch_slice_y=patch_slice_y,
                    patch_slice_x=patch_slice_x,
                    sun_angles=daylight_angle_pairs,
                    resolution_m=request.resolution_m,
                    max_search_radius_m=request.buffer_meters
                )
                daylight_canopy_masks = [np.ones_like(m) for m in daylight_masks]

            # Vectorized calculation of clear-sky irradiance for all daytime frames
            daylight_times = timestamps[daylight_indices]
            daylight_irradiance = self.solar_engine.calculate_irradiance_series(
                daylight_times, center_lat, center_lon, daylight_angles, altitude_m=median_elev
            )
        else:
            daylight_masks = []
            daylight_canopy_masks = []
            daylight_irradiance = []

        # 5. PV System Configuration (incorporating overrides without duplicating schema defaults)
        pv_kwargs = {"deployment_mode": request.deployment_mode}
        if request.module_efficiency is not None:
            pv_kwargs["module_efficiency"] = request.module_efficiency
        if request.system_derate is not None:
            pv_kwargs["system_derate"] = request.system_derate
        if request.gcr is not None:
            pv_kwargs["gcr"] = request.gcr
        pv_cfg = PVConfig(**pv_kwargs)

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
                irradiance = daylight_irradiance[daylight_counter]

                pv_res = self.pv_model.calculate_power_kw(
                    shadow_mask=mask,
                    irradiance=irradiance,
                    cell_area_m2=cell_area_m2,
                    config=pv_cfg,
                    inclusion_mask=polygon_mask,
                    canopy_mask=canopy_m,
                    canopy_transmittance=canopy_transmittance
                )

                if len(pv_res) == 3:
                    power_kw, percent_shaded, canopy_shaded_pct = pv_res
                else:
                    power_kw, percent_shaded = pv_res
                    canopy_shaded_pct = 0.0

                shaded_pct_list.append(percent_shaded)
                canopy_shaded_pct_list.append(canopy_shaded_pct)

                total_active_cells = int(np.count_nonzero(polygon_mask)) if polygon_mask is not None else int(mask.size)
                conv_factor = cell_area_m2 * pv_cfg.effective_gcr * pv_cfg.module_efficiency * pv_cfg.system_derate / 1000.0

                unshaded_power_kw = round(
                    total_active_cells * (irradiance.poa_direct_w_m2 + irradiance.poa_diffuse_w_m2) * conv_factor,
                    3
                )

                if canopy_m is not None:
                    if polygon_mask is not None:
                        t_unshaded = (mask > 0) & polygon_mask
                        c_shaded = t_unshaded & (~(canopy_m > 0))
                    else:
                        t_unshaded = mask > 0
                        c_shaded = t_unshaded & (~(canopy_m > 0))
                    canopy_shaded_cells = int(np.count_nonzero(c_shaded))
                else:
                    canopy_shaded_cells = 0

                canopy_loss_kw = round(
                    canopy_shaded_cells * (1.0 - canopy_transmittance) * irradiance.poa_direct_w_m2 * conv_factor,
                    3
                )

                # Geological shade loss is the exact potential loss attributable to terrain shadow
                geological_loss_kw = round(
                    max(0.0, unshaded_power_kw - canopy_loss_kw - power_kw),
                    3
                )

                if power_kw > peak_power_kw:
                    peak_power_kw = power_kw
                    peak_time = ts_str

                timeseries_metrics.append(
                    TimestepMetric(
                        timestamp=ts_str,
                        solar_azimuth_deg=round(angles.azimuth_deg, 2),
                        solar_elevation_deg=round(angles.elevation_deg, 2),
                        power_kw=power_kw,
                        unshaded_power_kw=unshaded_power_kw,
                        canopy_loss_kw=canopy_loss_kw,
                        geological_loss_kw=geological_loss_kw,
                        percent_shaded=percent_shaded,
                        canopy_shaded_pct=canopy_shaded_pct,
                        is_daylight=True,
                        mask_index=daylight_counter
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
                        canopy_loss_kw=0.0,
                        geological_loss_kw=0.0,
                        percent_shaded=100.0,
                        canopy_shaded_pct=0.0,
                        is_daylight=False,
                        mask_index=None
                    )
                )

        # Numerical integration using trapezoidal rule over 24h curve
        power_values = [m.power_kw for m in timeseries_metrics]
        unshaded_power_values = [m.unshaded_power_kw for m in timeseries_metrics]
        canopy_loss_values = [m.canopy_loss_kw for m in timeseries_metrics]

        total_daily_kwh = float(np.trapezoid(power_values, dx=step_min / 60.0))
        unshaded_daily_kwh = float(np.trapezoid(unshaded_power_values, dx=step_min / 60.0))
        canopy_loss_kwh = float(np.trapezoid(canopy_loss_values, dx=step_min / 60.0))
        canopy_loss_pct = float(round((canopy_loss_kwh / unshaded_daily_kwh * 100.0), 1)) if unshaded_daily_kwh > 0 else 0.0
        unshaded_peak_kw = float(max(unshaded_power_values)) if unshaded_power_values else 0.0

        # 7. Encode daytime masks (masking out non-polygon cells as transparent/unshaded)
        if polygon_mask is not None and daylight_masks:
            export_masks = []
            export_canopy_masks = []
            for m, cm in zip(daylight_masks, daylight_canopy_masks):
                em = m.copy()
                em[~polygon_mask] = 1 # 1 = transparent in UI canvas
                export_masks.append(em)
                ecm = cm.copy()
                ecm[~polygon_mask] = 1
                export_canopy_masks.append(ecm)
            encoded_masks = encode_masks_batch(export_masks)
            encoded_canopy_masks = encode_masks_batch(export_canopy_masks)
        else:
            encoded_masks = encode_masks_batch(daylight_masks)
            encoded_canopy_masks = encode_masks_batch(daylight_canopy_masks)

        # Encode nighttime masks (0 = shaded inside shape, 1 = transparent outside)
        night_grid = np.zeros((patch_h, patch_w), dtype=np.uint8)
        night_canopy_grid = np.ones((patch_h, patch_w), dtype=np.uint8)
        if polygon_mask is not None:
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
            peak_power_kw=round(peak_power_kw, 2),
            unshaded_peak_kw=round(unshaded_peak_kw, 2),
            peak_time=peak_time,
            sunrise_time=sunrise_time,
            sunset_time=sunset_time,
            daylight_hours=daylight_hours,
            avg_shaded_pct=avg_shaded,
            avg_canopy_shaded_pct=avg_canopy_shaded
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
            date=request.date,
            time_step_minutes=step_min,
            buffer_meters=request.buffer_meters,
            resolution_m=request.resolution_m,
            deployment_mode=pv_cfg.deployment_mode.value,
            effective_gcr=pv_cfg.effective_gcr,
            module_efficiency=pv_cfg.module_efficiency,
            system_derate=pv_cfg.system_derate
        )

        return SimulateResponse(
            metadata=metadata,
            daily_summary=daily_summary,
            timeseries=timeseries_metrics,
            mask_encoding="bitmask_base64",
            masks=encoded_masks,
            canopy_masks=encoded_canopy_masks,
            canopy_transmittance=canopy_transmittance,
            night_mask=encoded_night_mask,
            night_canopy_mask=encoded_night_canopy_mask
        )
