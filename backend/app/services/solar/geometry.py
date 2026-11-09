"""
Solar geometry and seasonal optimal panel tilt calculator.
"""

from datetime import datetime
from typing import Optional
import numpy as np
import pandas as pd
import pvlib

from ...schemas.domain import SolarAngles
from ...constants import DEFAULT_TIMEZONE


def compute_seasonal_optimal_tilt(
    timestamp: datetime,
    latitude: float,
    longitude: float
) -> float:
    """
    Computes the fixed seasonal optimal panel tilt (solar noon zenith) for the given date.
    Remains constant across the entire 24-hour simulation day.
    """
    if timestamp.tzinfo is None:
        tz_timestamp = pd.Timestamp(timestamp, tz=DEFAULT_TIMEZONE)
    else:
        tz_timestamp = pd.Timestamp(timestamp)

    date_str = tz_timestamp.strftime("%Y-%m-%d")
    tz = tz_timestamp.tz
    # Sample midday hours (11:00 to 14:00) with 1-min frequency to determine solar noon zenith
    noon_times = pd.date_range(f"{date_str} 11:00", f"{date_str} 14:00", freq="1min", tz=tz)
    solpos = pvlib.solarposition.get_solarposition(noon_times, latitude, longitude)
    min_zenith = float(solpos['zenith'].min())
    return float(np.clip(min_zenith, 0.0, 90.0))


def compute_solar_angles(
    timestamp: datetime,
    latitude: float,
    longitude: float,
    optimal_tilt: Optional[float] = None
) -> SolarAngles:
    """
    Computes solar azimuth, elevation, zenith, seasonal optimal tilt,
    and beam incidence angle on a south-facing panel.
    """
    # Ensure pandas DatetimeIndex with timezone awareness
    if timestamp.tzinfo is None:
        # Default to Quebec / Eastern timezone if none provided
        tz_timestamp = pd.Timestamp(timestamp, tz=DEFAULT_TIMEZONE)
    else:
        tz_timestamp = pd.Timestamp(timestamp)

    times = pd.DatetimeIndex([tz_timestamp])
    solpos = pvlib.solarposition.get_solarposition(times, latitude, longitude)

    azimuth = float(solpos['azimuth'].iloc[0])
    elevation = float(solpos['elevation'].iloc[0])
    zenith = float(solpos['zenith'].iloc[0])

    # Fixed seasonal optimal tilt: solar noon zenith for this date, clamped to [0°, 90°]
    if optimal_tilt is None:
        optimal_tilt = compute_seasonal_optimal_tilt(tz_timestamp.to_pydatetime(), latitude, longitude)
    else:
        optimal_tilt = float(np.clip(optimal_tilt, 0.0, 90.0))

    # Panel faces due south: azimuth = 180°
    panel_azimuth = 180.0

    if elevation > 0.0:
        aoi_val = pvlib.irradiance.aoi(
            surface_tilt=optimal_tilt,
            surface_azimuth=panel_azimuth,
            solar_zenith=zenith,
            solar_azimuth=azimuth
        )
        incident_angle = float(aoi_val.iloc[0]) if hasattr(aoi_val, 'iloc') else float(aoi_val)
    else:
        incident_angle = 90.0

    return SolarAngles(
        azimuth_deg=azimuth,
        elevation_deg=elevation,
        zenith_deg=zenith,
        optimal_tilt_deg=optimal_tilt,
        incident_angle_deg=incident_angle
    )
