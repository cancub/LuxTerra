"""
Abstract Base Class for Solar Position and Atmospheric Radiation Engines.
"""

from abc import ABC, abstractmethod
from datetime import datetime
from ..schemas.domain import SolarAngles, IrradianceComponents


class SolarEngine(ABC):
    """
    Abstract interface for solar geometry, tracking angles, and clear-sky irradiance.
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
        angles: SolarAngles
    ) -> IrradianceComponents:
        """
        Calculates direct normal, diffuse horizontal, and plane-of-array irradiance components.
        """
        pass
