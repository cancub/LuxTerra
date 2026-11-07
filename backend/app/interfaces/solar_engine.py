"""
Abstract Base Class for Solar Position and Atmospheric Radiation Engines.
"""

from abc import ABC, abstractmethod
from typing import List
from datetime import datetime
import pandas as pd
from ..schemas.domain import SolarAngles, IrradianceComponents


class SolarEngine(ABC):
    """
    Abstract interface for solar geometry, tracking angles, and clear-sky irradiance.
    Supports both single-point and high-performance vectorized series calculations.
    """

    @abstractmethod
    def calculate_solar_angles(
        self,
        timestamp: datetime,
        latitude: float,
        longitude: float
    ) -> SolarAngles:
        """
        Calculates sun azimuth, elevation, zenith, optimal tilt, and beam incidence angle.
        """
        pass

    @abstractmethod
    def calculate_irradiance(
        self,
        timestamp: datetime,
        latitude: float,
        longitude: float,
        angles: SolarAngles,
        altitude_m: float = 0.0
    ) -> IrradianceComponents:
        """
        Calculates direct normal, diffuse horizontal, and plane-of-array irradiance components.
        """
        pass

    def calculate_solar_angles_series(
        self,
        timestamps: pd.DatetimeIndex,
        latitude: float,
        longitude: float
    ) -> List[SolarAngles]:
        """
        Vectorized computation of solar angles across a DatetimeIndex.
        Default implementation falls back to per-element calls.
        """
        return [
            self.calculate_solar_angles(ts.to_pydatetime(), latitude, longitude)
            for ts in timestamps
        ]

    def calculate_irradiance_series(
        self,
        timestamps: pd.DatetimeIndex,
        latitude: float,
        longitude: float,
        angles_list: List[SolarAngles],
        altitude_m: float = 0.0
    ) -> List[IrradianceComponents]:
        """
        Vectorized computation of clear-sky irradiance across a DatetimeIndex.
        Default implementation falls back to per-element calls.
        """
        return [
            self.calculate_irradiance(ts.to_pydatetime(), latitude, longitude, ang, altitude_m)
            for ts, ang in zip(timestamps, angles_list)
        ]
