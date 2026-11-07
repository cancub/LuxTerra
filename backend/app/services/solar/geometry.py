"""
Solar geometry and seasonal optimal panel tilt calculator.
"""

from datetime import datetime
import numpy as np
import pandas as pd
import pvlib

from ...schemas.domain import SolarAngles


def compute_solar_angles(
    timestamp: datetime,
    latitude: float,
    longitude: float
) -> SolarAngles:
    """
    Computes solar azimuth, elevation, zenith, optimal instantaneous tilt,
    and beam incidence angle on a south-facing panel.
    """
    # Ensure pandas DatetimeIndex with timezone awareness
    if timestamp.tzinfo is None:
        # Default to Quebec / Eastern timezone if none provided
        tz_timestamp = pd.Timestamp(timestamp, tz="America/Toronto")
    else:
        tz_timestamp = pd.Timestamp(timestamp)

    times = pd.DatetimeIndex([tz_timestamp])
    solpos = pvlib.solarposition.get_solarposition(times, latitude, longitude)

    azimuth = float(solpos['azimuth'].iloc[0])
    elevation = float(solpos['elevation'].iloc[0])
    zenith = float(solpos['zenith'].iloc[0])

    # For optimal seasonal tilt: matches instantaneous zenith when sun is up, clamped to [0°, 90°]
    if elevation > 0.0:
        optimal_tilt = max(0.0, min(90.0, zenith))
    else:
        optimal_tilt = max(0.0, min(90.0, latitude)) # default to latitude when night

    # Panel faces due south: azimuth = 180°
    panel_azimuth = 180.0

    if elevation > 0.0:
        aoi_val = pvlib.irradiance.aoi(
            surface_tilt=optimal_tilt,
            surface_azimuth=panel_azimuth,
            solar_zenith=zenith,
            solar_azimuth=azimuth
        )
        incident_angle = float(aoi_val.iloc[0])
    else:
        incident_angle = 90.0

    return SolarAngles(
        azimuth_deg=azimuth,
        elevation_deg=elevation,
        zenith_deg=zenith,
        optimal_tilt_deg=optimal_tilt,
        incident_angle_deg=incident_angle
    )
