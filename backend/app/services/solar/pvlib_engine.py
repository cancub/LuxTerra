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
from .geometry import compute_solar_angles


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
        if timestamps.tz is None:
            times = timestamps.tz_localize("America/Toronto")
        else:
            times = timestamps

        solpos = pvlib.solarposition.get_solarposition(times, latitude, longitude)
        azimuths = solpos['azimuth'].to_numpy(dtype=np.float64)
        elevations = solpos['elevation'].to_numpy(dtype=np.float64)
        zeniths = solpos['zenith'].to_numpy(dtype=np.float64)

        # Vectorized optimal tilt: clamped zenith during daytime, latitude at night
        day_mask = elevations > 0.0
        optimal_tilts = np.where(day_mask, np.clip(zeniths, 0.0, 90.0), np.clip(latitude, 0.0, 90.0))

        # Vectorized angle of incidence (AOI) facing true south (azimuth = 180.0)
        aoi_series = pvlib.irradiance.aoi(
            surface_tilt=optimal_tilts,
            surface_azimuth=180.0,
            solar_zenith=zeniths,
            solar_azimuth=azimuths
        )
        aoi_vals = np.where(day_mask, np.asarray(aoi_series, dtype=np.float64), 90.0)

        results = []
        for az, el, zen, tilt, inc in zip(azimuths, elevations, zeniths, optimal_tilts, aoi_vals):
            results.append(
                SolarAngles(
                    azimuth_deg=float(az),
                    elevation_deg=float(el),
                    zenith_deg=float(zen),
                    optimal_tilt_deg=float(tilt),
                    incident_angle_deg=float(inc)
                )
            )
        return results

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
        """
        if angles.elevation_deg <= 0.0:
            return IrradianceComponents(
                dni_w_m2=0.0,
                dhi_w_m2=0.0,
                poa_direct_w_m2=0.0,
                poa_diffuse_w_m2=0.0,
                poa_global_w_m2=0.0
            )

        if timestamp.tzinfo is None:
            tz_timestamp = pd.Timestamp(timestamp, tz="America/Toronto")
        else:
            tz_timestamp = pd.Timestamp(timestamp)

        times = pd.DatetimeIndex([tz_timestamp])
        location = pvlib.location.Location(latitude, longitude, altitude=altitude_m, tz="America/Toronto")
        
        cs = location.get_clearsky(times, model="ineichen")
        dni = float(cs["dni"].iloc[0])
        dhi = float(cs["dhi"].iloc[0])

        cos_inc = max(0.0, np.cos(np.radians(angles.incident_angle_deg)))
        poa_direct = float(dni * cos_inc)

        tilt_rad = np.radians(angles.optimal_tilt_deg)
        sky_view_factor = float((1.0 + np.cos(tilt_rad)) / 2.0)
        poa_diffuse = float(dhi * sky_view_factor)

        poa_global = float(poa_direct + poa_diffuse)

        return IrradianceComponents(
            dni_w_m2=dni,
            dhi_w_m2=dhi,
            poa_direct_w_m2=poa_direct,
            poa_diffuse_w_m2=poa_diffuse,
            poa_global_w_m2=poa_global
        )

    def calculate_irradiance_series(
        self,
        timestamps: pd.DatetimeIndex,
        latitude: float,
        longitude: float,
        angles_list: List[SolarAngles],
        altitude_m: float = 0.0
    ) -> List[IrradianceComponents]:
        """
        Vectorized computation of clear-sky Ineichen irradiance across an entire DatetimeIndex in one pass.
        """
        if len(timestamps) == 0:
            return []

        if timestamps.tz is None:
            times = timestamps.tz_localize("America/Toronto")
        else:
            times = timestamps

        location = pvlib.location.Location(latitude, longitude, altitude=altitude_m, tz="America/Toronto")
        cs = location.get_clearsky(times, model="ineichen")

        dni_arr = cs["dni"].to_numpy(dtype=np.float64)
        dhi_arr = cs["dhi"].to_numpy(dtype=np.float64)

        results = []
        for dni, dhi, angles in zip(dni_arr, dhi_arr, angles_list):
            if angles.elevation_deg <= 0.0:
                results.append(
                    IrradianceComponents(
                        dni_w_m2=0.0,
                        dhi_w_m2=0.0,
                        poa_direct_w_m2=0.0,
                        poa_diffuse_w_m2=0.0,
                        poa_global_w_m2=0.0
                    )
                )
                continue

            cos_inc = max(0.0, np.cos(np.radians(angles.incident_angle_deg)))
            poa_direct = float(dni * cos_inc)

            tilt_rad = np.radians(angles.optimal_tilt_deg)
            sky_view_factor = float((1.0 + np.cos(tilt_rad)) / 2.0)
            poa_diffuse = float(dhi * sky_view_factor)
            poa_global = float(poa_direct + poa_diffuse)

            results.append(
                IrradianceComponents(
                    dni_w_m2=float(dni),
                    dhi_w_m2=float(dhi),
                    poa_direct_w_m2=poa_direct,
                    poa_diffuse_w_m2=poa_diffuse,
                    poa_global_w_m2=poa_global
                )
            )

        return results
