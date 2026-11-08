"""
Abstract Base Class for Photovoltaic (PV) Electrical Modeling.
"""

from abc import ABC, abstractmethod
from typing import Tuple, Optional
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
        inclusion_mask: Optional[np.ndarray] = None
    ) -> Tuple[float, float]:
        """
        Calculates instantaneous usable AC electrical power output and percentage of patch shaded.
        
        Parameters:
          - shadow_mask: 2D uint8 array (1 = unshaded, 0 = shaded)
          - irradiance: IrradianceComponents containing DNI, DHI, and POA values
          - cell_area_m2: Area of each grid cell in square meters (default: 1.0)
          - config: PVConfig containing efficiency, derate, and deployment mode (GCR)
          
        Returns:
          - (power_kw, percent_shaded):
            power_kw: Total instantaneous usable AC power in kW
            percent_shaded: Float percentage of cells in shadow (0.0 to 100.0)
        """
        pass
