"""
Solar Engine implementation using pvlib clear-sky Ineichen model.
Features vectorized DatetimeIndex operations for maximum simulation throughput.
"""

from typing import List
from datetime import datetime
import numpy as np
import pandas as pd
import pvlib

from ...interfaces.solar_engine import SolarEngine
from ...schemas.domain import SolarAngles, IrradianceComponents
from ...constants import DEFAULT_TIMEZONE
from .geometry import compute_solar_angles, compute_seasonal_optimal_tilt


class PvlibSolarEngine(SolarEngine):
    """
    Solar engine computing solar vectors and Ineichen clear-sky atmospheric radiation.
    """

    def calculate_solar_angles(
        self,
        timestamp: datetime,
        latitude: float,
        longitude: float
    ) -> SolarAngles:
        """
        Calculates sun azimuth, elevation, zenith, optimal tilt, and incident angle for a single timestamp.
        """
        return compute_solar_angles(timestamp, latitude, longitude)

    def calculate_solar_angles_series(
        self,
        timestamps: pd.DatetimeIndex,
        latitude: float,
        longitude: float
    ) -> List[SolarAngles]:
        """
        Vectorized computation of solar angles across a DatetimeIndex in a single C/Fortran pass.
        """
        if len(timestamps) == 0:
            return []

        if timestamps.tz is None:
            times = timestamps.tz_localize(DEFAULT_TIMEZONE)
        else:
            times = timestamps

        solpos = pvlib.solarposition.get_solarposition(times, latitude, longitude)
        azimuths = solpos['azimuth'].to_numpy(dtype=np.float64)
        elevations = solpos['elevation'].to_numpy(dtype=np.float64)
        zeniths = solpos['zenith'].to_numpy(dtype=np.float64)

        # Fixed seasonal optimal tilt: solar noon zenith across the entire day
        day_mask = elevations > 0.0
        if len(times) > 1 and np.any(day_mask):
            seasonal_tilt = float(np.clip(np.min(zeniths[day_mask]), 0.0, 90.0))
        else:
            seasonal_tilt = compute_seasonal_optimal_tilt(times[0].to_pydatetime(), latitude, longitude)
        optimal_tilts = np.full_like(zeniths, seasonal_tilt)

        # Vectorized angle of incidence (AOI) facing true south (azimuth = 180.0)
        aoi_series = pvlib.irradiance.aoi(
            surface_tilt=optimal_tilts,
            surface_azimuth=180.0,
            solar_zenith=zeniths,
            solar_azimuth=azimuths
        )
        aoi_vals = np.where(day_mask, np.asarray(aoi_series, dtype=np.float64), 90.0)

        return [
            SolarAngles(
                azimuth_deg=float(az),
                elevation_deg=float(el),
                zenith_deg=float(zen),
                optimal_tilt_deg=float(tilt),
                incident_angle_deg=float(inc)
            )
            for az, el, zen, tilt, inc in zip(azimuths, elevations, zeniths, optimal_tilts, aoi_vals)
        ]

    def calculate_irradiance(
        self,
        timestamp: datetime,
        latitude: float,
        longitude: float,
        angles: SolarAngles,
        altitude_m: float = 0.0
    ) -> IrradianceComponents:
        """
        Calculates clear-sky DNI, DHI, and unshaded Plane-of-Array (POA) irradiance for a single timestamp.
        Delegates to the vectorized series engine.
        """
        if angles.elevation_deg <= 0.0:
            return IrradianceComponents(
                dni_w_m2=0.0,
                dhi_w_m2=0.0,
                poa_direct_w_m2=0.0,
                poa_diffuse_w_m2=0.0,
                poa_global_w_m2=0.0
            )

        tz_timestamp = pd.Timestamp(timestamp, tz=DEFAULT_TIMEZONE) if timestamp.tzinfo is None else pd.Timestamp(timestamp)
        return self.calculate_irradiance_series(
            pd.DatetimeIndex([tz_timestamp]),
            latitude,
            longitude,
            [angles],
            altitude_m=altitude_m
        )[0]

    def calculate_irradiance_series(
        self,
        timestamps: pd.DatetimeIndex,
        latitude: float,
        longitude: float,
        angles_list: List[SolarAngles],
        altitude_m: float = 0.0
    ) -> List[IrradianceComponents]:
        """
        Vectorized computation of clear-sky Ineichen irradiance and POA trigonometry across a DatetimeIndex.
        """
        if len(timestamps) == 0:
            return []

        if timestamps.tz is None:
            times = timestamps.tz_localize(DEFAULT_TIMEZONE)
        else:
            times = timestamps

        location = pvlib.location.Location(latitude, longitude, altitude=altitude_m, tz=DEFAULT_TIMEZONE)
        cs = location.get_clearsky(times, model="ineichen")

        dni_arr = cs["dni"].to_numpy(dtype=np.float64)
        dhi_arr = cs["dhi"].to_numpy(dtype=np.float64)

        elevs = np.array([a.elevation_deg for a in angles_list], dtype=np.float64)
        inc_rads = np.radians([a.incident_angle_deg for a in angles_list])
        tilt_rads = np.radians([a.optimal_tilt_deg for a in angles_list])

        day_mask = elevs > 0.0
        cos_inc = np.maximum(0.0, np.cos(inc_rads))
        poa_direct_arr = np.where(day_mask, dni_arr * cos_inc, 0.0)

        # Unobstructed Sky View Factor (SVF = 1.0) on tilted panel: (1 + cos(tilt)) / 2
        svf_arr = (1.0 + np.cos(tilt_rads)) / 2.0
        poa_diffuse_arr = np.where(day_mask, dhi_arr * svf_arr, 0.0)
        poa_global_arr = poa_direct_arr + poa_diffuse_arr

        dni_clean = np.where(day_mask, dni_arr, 0.0)
        dhi_clean = np.where(day_mask, dhi_arr, 0.0)

        return [
            IrradianceComponents(
                dni_w_m2=float(dni),
                dhi_w_m2=float(dhi),
                poa_direct_w_m2=float(p_dir),
                poa_diffuse_w_m2=float(p_dif),
                poa_global_w_m2=float(p_glob)
            )
            for dni, dhi, p_dir, p_dif, p_glob in zip(
                dni_clean, dhi_clean, poa_direct_arr, poa_diffuse_arr, poa_global_arr
            )
        ]
