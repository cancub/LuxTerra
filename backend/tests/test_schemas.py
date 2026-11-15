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


def test_simulate_request_malformed_bbox_with_polygon_raises_validation_error():
    poly = [[-73.618, 45.503], [-73.617, 45.503], [-73.617, 45.504]]
    # Missing required key
    with pytest.raises(ValidationError):
        SimulateRequest.model_validate({
            "bbox": {"min_lon": -73.618, "min_lat": 45.503, "max_lon": -73.617},
            "polygon": poly,
            "date": "2026-06-21",
        })
    # Non-numeric / list value (previously raised TypeError -> HTTP 500)
    with pytest.raises(ValidationError):
        SimulateRequest.model_validate({
            "bbox": {"min_lon": [1], "min_lat": 45.503, "max_lon": -73.617, "max_lat": 45.504},
            "polygon": poly,
            "date": "2026-06-21",
        })
    # Out-of-range WGS84 value (previously bypassed via model_construct)
    with pytest.raises(ValidationError):
        SimulateRequest.model_validate({
            "bbox": {"min_lon": -200.0, "min_lat": 45.503, "max_lon": -73.617, "max_lat": 45.504},
            "polygon": poly,
            "date": "2026-06-21",
        })


def test_simulate_request_degenerate_zero_area_polygon_rejected():
    collinear = [[-73.618, 45.503], [-73.6175, 45.5035], [-73.617, 45.504]]
    with pytest.raises(ValidationError, match="zero or degenerate area"):
        SimulateRequest(
            bbox=GeoBoundingBox(
                min_lon=-73.618,
                min_lat=45.503,
                max_lon=-73.617,
                max_lat=45.504,
            ),
            polygon=collinear,
            date="2026-06-21",
        )


def test_utm_crs_clamped_at_antimeridian():
    from backend.app.services.elevation.geo_utils import get_utm_crs_for_lon_lat
    assert get_utm_crs_for_lon_lat(180.0, 45.0) == "EPSG:32660"
    assert get_utm_crs_for_lon_lat(-180.0, -45.0) == "EPSG:32701"
