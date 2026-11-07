"""
Standard Photovoltaic electrical conversion model.
Accounts for direct beam shading, diffuse transposition, module efficiency, system derate,
and a toggle between Rooftop (100% GCR) and Ground-Mount (45% GCR).
"""

from typing import Tuple, Optional
import numpy as np

from ...interfaces.pv_model import PVSystemModel
from ...schemas.domain import IrradianceComponents, PVConfig, DeploymentMode


class StandardPVModel(PVSystemModel):
    """
    Computes usable AC electrical power generation in kW.
    """

    def calculate_power_kw(
        self,
        shadow_mask: np.ndarray,
        irradiance: IrradianceComponents,
        cell_area_m2: float = 1.0,
        config: Optional[PVConfig] = None
    ) -> Tuple[float, float]:
        """
        Calculates instantaneous usable AC power in kW and percentage of the patch shaded.
        """
        cfg = config or PVConfig()
        
        total_cells = shadow_mask.size
        if total_cells == 0:
            return 0.0, 0.0

        # Unshaded cells have mask == 1, shaded cells have mask == 0
        unshaded_cells = int(np.count_nonzero(shadow_mask > 0))
        shaded_cells = total_cells - unshaded_cells
        percent_shaded = float((shaded_cells / total_cells) * 100.0)

        # Unshaded cells receive direct + diffuse POA irradiance
        # Shaded cells receive diffuse POA irradiance (unobstructed sky view factor SVF = 1.0)
        total_incident_watts = (
            (unshaded_cells * irradiance.poa_direct_w_m2 * cell_area_m2) +
            (total_cells * irradiance.poa_diffuse_w_m2 * cell_area_m2)
        )

        # Apply Ground Coverage Ratio (GCR), Module Efficiency (eta), and System Derate (PR)
        gcr = cfg.effective_gcr
        eta = cfg.module_efficiency
        pr = cfg.system_derate

        electrical_watts = total_incident_watts * gcr * eta * pr
        power_kw = float(electrical_watts / 1000.0)

        return round(power_kw, 3), round(percent_shaded, 2)
