"""
Unit tests for standard PV electrical conversion model.
"""

import pytest
import numpy as np

from backend.app.schemas.domain import IrradianceComponents, PVConfig, DeploymentMode
from backend.app.services.pv.standard_pv import StandardPVModel


@pytest.fixture
def sample_irradiance():
    return IrradianceComponents(
        dni_w_m2=900.0,
        dhi_w_m2=150.0,
        poa_direct_w_m2=800.0,
        poa_diffuse_w_m2=200.0,
        poa_global_w_m2=1000.0
    )


def test_pv_unshaded_rooftop(sample_irradiance):
    model = StandardPVModel()
    
    # 100x100 grid = 10,000 cells (10,000 m² at 1m resolution)
    mask = np.ones((100, 100), dtype=np.uint8)
    config = PVConfig(deployment_mode=DeploymentMode.ROOFTOP, module_efficiency=0.20, system_derate=0.80)
    
    # Total watts = 10,000 * (800 + 200) = 10,000,000 W
    # kW = 10,000 * 1.0 (GCR) * 0.20 (eta) * 0.80 (PR) = 1,600 kW
    power_kw, shaded_pct = model.calculate_power_kw(mask, sample_irradiance, cell_area_m2=1.0, config=config)
    
    assert shaded_pct == 0.0
    assert power_kw == 1600.0


def test_pv_unshaded_ground_mount(sample_irradiance):
    model = StandardPVModel()
    
    mask = np.ones((100, 100), dtype=np.uint8)
    config = PVConfig(deployment_mode=DeploymentMode.GROUND_MOUNT, module_efficiency=0.20, system_derate=0.80)
    
    # Ground mount GCR = 0.45
    # kW = 1,600 * 0.45 = 720 kW
    power_kw, shaded_pct = model.calculate_power_kw(mask, sample_irradiance, cell_area_m2=1.0, config=config)
    
    assert shaded_pct == 0.0
    assert power_kw == 720.0


def test_pv_partial_shading(sample_irradiance):
    model = StandardPVModel()
    
    # 50% shaded: first 50 rows 0 (shaded), bottom 50 rows 1 (unshaded)
    mask = np.zeros((100, 100), dtype=np.uint8)
    mask[50:, :] = 1
    
    config = PVConfig(deployment_mode=DeploymentMode.ROOFTOP, module_efficiency=0.20, system_derate=0.80)
    
    # Direct POA: 5,000 cells * 800 W = 4,000,000 W
    # Diffuse POA: 10,000 cells * 200 W = 2,000,000 W
    # Total watts = 6,000,000 W = 6,000 kW incident
    # AC kW = 6,000 * 1.0 * 0.20 * 0.80 = 960 kW
    power_kw, shaded_pct = model.calculate_power_kw(mask, sample_irradiance, cell_area_m2=1.0, config=config)
    
    assert shaded_pct == 50.0
    assert power_kw == 960.0


def test_pv_full_shading(sample_irradiance):
    model = StandardPVModel()
    
    # 100% shaded (deep terrain shade)
    mask = np.zeros((100, 100), dtype=np.uint8)
    config = PVConfig(deployment_mode=DeploymentMode.ROOFTOP, module_efficiency=0.20, system_derate=0.80)
    
    # Direct POA = 0
    # Diffuse POA: 10,000 cells * 200 W = 2,000,000 W = 2,000 kW incident
    # AC kW = 2,000 * 1.0 * 0.20 * 0.80 = 320 kW (diffuse skylight still collected!)
    power_kw, shaded_pct = model.calculate_power_kw(mask, sample_irradiance, cell_area_m2=1.0, config=config)
    
    assert shaded_pct == 100.0
    assert power_kw == 320.0
