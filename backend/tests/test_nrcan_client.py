"""
Unit tests for NRCanClient STAC querying and DSM/DTM downloads.
"""

from pathlib import Path
from unittest.mock import MagicMock
import pytest
import requests

from backend.app.services.elevation.nrcan_client import NRCanClient


@pytest.fixture
def mock_stac_response():
    return {
        "features": [
            {
                "id": "QC-TEST-TILE-2023-1m",
                "bbox": [-73.65, 45.48, -73.58, 45.53],
                "properties": {"collection": "hrdem-lidar"},
                "assets": {
                    "dtm": {
                        "href": "https://canelevation-dem.s3.ca-central-1.amazonaws.com/hrdem-lidar/QC-TEST-dtm.tif",
                        "type": "image/tiff; application=geotiff; profile=cloud-optimized"
                    },
                    "dsm": {
                        "href": "https://canelevation-dem.s3.ca-central-1.amazonaws.com/hrdem-lidar/QC-TEST-dsm.tif",
                        "type": "image/tiff; application=geotiff; profile=cloud-optimized"
                    }
                }
            }
        ]
    }


def test_query_tiles_by_bbox_extracts_both_dtm_and_dsm(monkeypatch, mock_stac_response):
    client = NRCanClient()
    
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = mock_stac_response
    
    monkeypatch.setattr(client.session, "get", lambda *args, **kwargs: mock_resp)
    
    tiles = client.query_tiles_by_bbox(-73.62, 45.50, -73.61, 45.51)
    assert len(tiles) == 1
    tile = tiles[0]
    
    assert tile["id"] == "QC-TEST-TILE-2023-1m"
    assert tile["dtm_url"] == "https://canelevation-dem.s3.ca-central-1.amazonaws.com/hrdem-lidar/QC-TEST-dtm.tif"
    assert tile["dsm_url"] == "https://canelevation-dem.s3.ca-central-1.amazonaws.com/hrdem-lidar/QC-TEST-dsm.tif"


def test_query_tiles_when_dsm_absent(monkeypatch):
    client = NRCanClient()
    
    legacy_response = {
        "features": [
            {
                "id": "QC-LEGACY-TILE",
                "bbox": [-73.65, 45.48, -73.58, 45.53],
                "assets": {
                    "dtm": {"href": "https://example.com/legacy-dtm.tif"}
                }
            }
        ]
    }
    
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = legacy_response
    
    monkeypatch.setattr(client.session, "get", lambda *args, **kwargs: mock_resp)
    
    tiles = client.query_tiles_by_bbox(-73.62, 45.50, -73.61, 45.51)
    assert len(tiles) == 1
    assert tiles[0]["dtm_url"] == "https://example.com/legacy-dtm.tif"
    assert tiles[0]["dsm_url"] is None


def test_download_tile_creates_file(tmp_path, monkeypatch):
    client = NRCanClient()
    
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.iter_content.return_value = [b"FAKE_GEOTIFF_DATA_CHUNK_1", b"_CHUNK_2"]
    
    monkeypatch.setattr(client.session, "get", lambda *args, **kwargs: mock_resp)
    
    dest_file = tmp_path / "test_tile.tif"
    result_path = client.download_tile("https://example.com/tile.tif", dest_file)
    
    assert result_path.exists()
    assert result_path.read_bytes() == b"FAKE_GEOTIFF_DATA_CHUNK_1_CHUNK_2"


def test_download_tile_pair(tmp_path, monkeypatch):
    client = NRCanClient()
    
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.iter_content.return_value = [b"TIFF_DATA"]
    
    monkeypatch.setattr(client.session, "get", lambda *args, **kwargs: mock_resp)
    
    item = {
        "id": "QC_MONTREAL_01",
        "dtm_url": "https://example.com/mtl_dtm.tif",
        "dsm_url": "https://example.com/mtl_dsm.tif"
    }
    
    dtm_path, dsm_path = client.download_tile_pair(item, tmp_path)
    assert dtm_path is not None and dtm_path.exists()
    assert dsm_path is not None and dsm_path.exists()
    assert dtm_path.name == "QC_MONTREAL_01_dtm.tif"
    assert dsm_path.name == "QC_MONTREAL_01_dsm.tif"
