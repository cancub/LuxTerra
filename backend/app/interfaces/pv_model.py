"""
Abstract Base Class for Photovoltaic (PV) Electrical Modeling.
"""

from abc import ABC, abstractmethod
from typing import Tuple, Optional, Union
import numpy as np

from ..schemas.domain import IrradianceComponents, PVConfig


class PVSystemModel(ABC):
    """
    Abstract interface for converting incident irradiance and binary shadow masks
    into usable electrical power (kW).
    """

    @abstractmethod
    def calculate_power_kw(
        self,
        shadow_mask: np.ndarray,
        irradiance: IrradianceComponents,
        cell_area_m2: float = 1.0,
        config: Optional[PVConfig] = None,
        inclusion_mask: Optional[np.ndarray] = None,
        canopy_mask: Optional[np.ndarray] = None,
        canopy_transmittance: float = 0.15
    ) -> Union[Tuple[float, float], Tuple[float, float, float]]:
        """
        Calculates instantaneous usable AC electrical power output and percentage of patch shaded.
        
        Parameters:
          - shadow_mask: 2D uint8 array (1 = unshaded by terrain, 0 = terrain shaded)
          - irradiance: IrradianceComponents containing DNI, DHI, and POA values
          - cell_area_m2: Area of each grid cell in square meters (default: 1.0)
          - config: PVConfig containing efficiency, derate, and deployment mode (GCR)
          - inclusion_mask: Optional 2D boolean array defining active user polygon boundary
          - canopy_mask: Optional 2D uint8 array (1 = unshaded by canopy, 0 = canopy shaded)
          - canopy_transmittance: Fractional direct beam transmittance through canopy (tau)
          
        Returns:
          - (power_kw, percent_shaded) if canopy_mask is None
          - (power_kw, terrain_shaded_pct, canopy_shaded_pct) if canopy_mask is provided
        """
        pass
