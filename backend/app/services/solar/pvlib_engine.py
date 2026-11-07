"""
Solar Engine implementation using pvlib clear-sky Ineichen model.
"""

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
        Calculates sun azimuth, elevation, zenith, optimal tilt, and incident angle.
        """
        return compute_solar_angles(timestamp, latitude, longitude)

    def calculate_irradiance(
        self,
        timestamp: datetime,
        latitude: float,
        longitude: float,
        angles: SolarAngles
    ) -> IrradianceComponents:
        """
        Calculates clear-sky DNI, DHI, and unshaded Plane-of-Array (POA) irradiance.
        Applies unobstructed sky view factor (SVF = 1.0) isotropic diffuse transposition.
        """
        # If sun is below horizon, irradiance is 0
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
        location = pvlib.location.Location(latitude, longitude, tz="America/Toronto")
        
        # Calculate Ineichen clear-sky DNI, DHI, GHI
        cs = location.get_clearsky(times, model="ineichen")
        dni = float(cs["dni"].iloc[0])
        dhi = float(cs["dhi"].iloc[0])

        # Beam irradiance on tilted panel
        cos_inc = max(0.0, np.cos(np.radians(angles.incident_angle_deg)))
        poa_direct = float(dni * cos_inc)

        # Diffuse sky irradiance on tilted panel with unobstructed view factor (SVF = 1.0)
        # Isotropic sky transposition factor = (1 + cos(tilt)) / 2
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
