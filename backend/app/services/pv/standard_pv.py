"""
Standard Photovoltaic electrical conversion model.
Accounts for direct beam shading, diffuse transposition, module efficiency, system derate,
and a toggle between Rooftop (100% GCR) and Ground-Mount (45% GCR).
"""

from typing import Tuple, Optional, Union
import numpy as np

from ...interfaces.pv_model import PVSystemModel
from ...schemas.domain import IrradianceComponents, PVConfig, DeploymentMode


class StandardPVModel(PVSystemModel):
    """
    Computes usable AC electrical power generation in kW.
    Supports dual-surface terrain and vegetative canopy shading with seasonal direct beam attenuation.
    """

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
        Calculates instantaneous usable AC power in kW and percentage of the patch shaded.
        If inclusion_mask is provided, only cells inside the polygon boundary are evaluated.
        If canopy_mask is provided, returns (power_kw, terrain_shaded_pct, canopy_shaded_pct).
        """
        cfg = config or PVConfig()

        if inclusion_mask is not None:
            active_terrain = shadow_mask[inclusion_mask]
            active_canopy = canopy_mask[inclusion_mask] if canopy_mask is not None else None
            total_cells = int(active_terrain.size)
        else:
            active_terrain = shadow_mask
            active_canopy = canopy_mask
            total_cells = int(shadow_mask.size)

        if total_cells == 0:
            if canopy_mask is not None:
                return 0.0, 0.0, 0.0
            return 0.0, 0.0

        if active_canopy is not None:
            # Dual-surface:
            # 1. Terrain unshaded: active_terrain > 0
            # 2. Canopy unshaded: active_canopy > 0
            # Pixel classification:
            #   - Unshaded: active_terrain > 0 and active_canopy > 0 (100% direct beam)
            #   - Canopy shaded: active_terrain > 0 and active_canopy == 0 (tau * direct beam)
            #   - Terrain shaded: active_terrain == 0 (0% direct beam)
            terrain_unshaded = active_terrain > 0
            canopy_unshaded = active_canopy > 0

            unshaded_cells = int(np.count_nonzero(terrain_unshaded & canopy_unshaded))
            canopy_shaded_cells = int(np.count_nonzero(terrain_unshaded & (~canopy_unshaded)))
            terrain_shaded_cells = total_cells - int(np.count_nonzero(terrain_unshaded))

            terrain_shaded_pct = float((terrain_shaded_cells / total_cells) * 100.0)
            canopy_shaded_pct = float((canopy_shaded_cells / total_cells) * 100.0)

            # Direct beam POA:
            # Unshaded cells: 1.0 * poa_direct
            # Canopy shaded cells: tau * poa_direct
            tau = float(canopy_transmittance)
            direct_incident_watts = (
                (unshaded_cells * 1.0 + canopy_shaded_cells * tau) *
                irradiance.poa_direct_w_m2 * cell_area_m2
            )
            # Diffuse POA is collected over all active cells
            diffuse_incident_watts = total_cells * irradiance.poa_diffuse_w_m2 * cell_area_m2

            total_incident_watts = direct_incident_watts + diffuse_incident_watts

            gcr = cfg.effective_gcr
            eta = cfg.module_efficiency
            pr = cfg.system_derate

            electrical_watts = total_incident_watts * gcr * eta * pr
            power_kw = float(electrical_watts / 1000.0)

            return round(power_kw, 3), round(terrain_shaded_pct, 2), round(canopy_shaded_pct, 2)

        # Single surface bare-terrain fallback
        unshaded_cells = int(np.count_nonzero(active_terrain > 0))
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
