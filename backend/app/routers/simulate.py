"""
FastAPI router for solar potential and terrain occlusion simulation.
"""

from fastapi import APIRouter, Depends, HTTPException, status
import logging

from ..schemas.simulate import SimulateRequest, SimulateResponse
from ..interfaces.elevation_source import ElevationProvider
from ..interfaces.solar_engine import SolarEngine
from ..interfaces.occlusion_engine import OcclusionEngine
from ..interfaces.pv_model import PVSystemModel

from ..dependencies import (
    get_elevation_provider,
    get_solar_engine,
    get_occlusion_engine,
    get_pv_model
)
from ..services.simulator import SimulationOrchestrator

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["Simulation"])


@router.post(
    "/simulate",
    response_model=SimulateResponse,
    status_code=status.HTTP_200_OK,
    summary="Full-Day Solar and Terrain Shadow Batch Simulation",
    description=(
        "Precalculates the 24-hour timeseries of solar irradiance, GPU terrain shadow masks, "
        "and usable electrical generation (kW) for any patch up to 100,000 m² in Quebec."
    )
)
def simulate(
    request: SimulateRequest,
    elevation_provider: ElevationProvider = Depends(get_elevation_provider),
    solar_engine: SolarEngine = Depends(get_solar_engine),
    occlusion_engine: OcclusionEngine = Depends(get_occlusion_engine),
    pv_model: PVSystemModel = Depends(get_pv_model)
) -> SimulateResponse:
    """
    Executes full-day batch simulation.
    """
    orchestrator = SimulationOrchestrator(
        elevation_provider=elevation_provider,
        solar_engine=solar_engine,
        occlusion_engine=occlusion_engine,
        pv_model=pv_model
    )

    try:
        response = orchestrator.run_simulation(request)
        return response
    except FileNotFoundError as e:
        logger.warning(f"Elevation data not found: {e}")
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e)
        )
    except ValueError as e:
        logger.warning(f"Validation error in simulation request: {e}")
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(e)
        )
    except Exception as e:
        logger.error(f"Unexpected error during simulation: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Simulation failed due to an internal error: {str(e)}"
        )
