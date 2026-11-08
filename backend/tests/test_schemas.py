"""
Unit tests for API request/response schemas and domain validations.
"""

import pytest
from pydantic import ValidationError

from backend.app.schemas.domain import GeoBoundingBox, DeploymentMode
from backend.app.schemas.simulate import SimulateRequest, SimulateResponse
from backend.app.schemas.elevation import LocationPreset, ElevationLocationsResponse


def test_geo_bounding_box_valid():
    bbox = GeoBoundingBox(
        min_lon=-73.618,
        min_lat=45.503,
        max_lon=-73.6166,
        max_lat=45.504
    )
    assert bbox.min_lon == -73.618
    assert bbox.max_lat == 45.504


def test_geo_bounding_box_auto_normalization():
    # Inverted coordinates
    bbox = GeoBoundingBox(
        min_lon=-73.6166,
        min_lat=45.504,
        max_lon=-73.618,
        max_lat=45.503
    )
    assert bbox.min_lon == -73.618
    assert bbox.max_lon == -73.6166
    assert bbox.min_lat == 45.503
    assert bbox.max_lat == 45.504


def test_geo_bounding_box_area_limit_raises():
    # ~1km x 1km = 1,000,000 m² > 100,000 m² limit
    with pytest.raises(ValidationError, match="exceeds the maximum allowable limit"):
        GeoBoundingBox(
            min_lon=-73.63,
            min_lat=45.50,
            max_lon=-73.61,
            max_lat=45.51
        )


def test_simulate_request_valid():
    req_default = SimulateRequest(
        bbox=GeoBoundingBox(
            min_lon=-73.618,
            min_lat=45.503,
            max_lon=-73.6166,
            max_lat=45.504
        ),
        date="2026-06-21"
    )
    assert req_default.time_step_minutes == 1

    req = SimulateRequest(
        bbox=GeoBoundingBox(
            min_lon=-73.618,
            min_lat=45.503,
            max_lon=-73.6166,
            max_lat=45.504
        ),
        date="2026-06-21",
        time_step_minutes=15,
        deployment_mode=DeploymentMode.GROUND_MOUNT,
        module_efficiency=0.22,
        system_derate=0.85
    )
    assert req.date == "2026-06-21"
    assert req.time_step_minutes == 15
    assert req.deployment_mode == DeploymentMode.GROUND_MOUNT
    assert req.module_efficiency == 0.22


def test_simulate_request_invalid_date():
    with pytest.raises(ValidationError, match="Invalid date format"):
        SimulateRequest(
            bbox=GeoBoundingBox(
                min_lon=-73.618,
                min_lat=45.503,
                max_lon=-73.6166,
                max_lat=45.504
            ),
            date="invalid-date-string"
        )


def test_simulate_request_invalid_efficiency():
    with pytest.raises(ValidationError):
        SimulateRequest(
            bbox=GeoBoundingBox(
                min_lon=-73.618,
                min_lat=45.503,
                max_lon=-73.6166,
                max_lat=45.504
            ),
            date="2026-06-21",
            module_efficiency=0.90 # > 0.40 max limit
        )
