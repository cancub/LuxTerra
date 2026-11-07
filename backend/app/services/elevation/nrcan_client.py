"""
NRCan CanElevation / HRDEM STAC & WCS Client for Quebec LiDAR Elevation Data.
"""

import logging
from typing import List, Dict, Any, Optional
import requests

logger = logging.getLogger(__name__)

# Official Geo.ca / CanElevation STAC API endpoint
NRCAN_STAC_URL = "https://datacube.services.geo.ca/stac/api/collections/hrdem-lidar/items"
NRCAN_WCS_URL = "https://maps-cartes.services.geo.ca/server_serveur/rest/services/NRCan/can_elevation_wcs/MapServer/WCSServer"


class NRCanClient:
    """
    Client for discovering and retrieving Canadian High Resolution Digital Elevation Model (HRDEM)
    bare-earth DTM rasters.
    """

    def __init__(self, timeout: int = 30):
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": "LuxTerra-ElevationClient/1.0"})

    def query_tiles_by_bbox(
        self,
        min_lon: float,
        min_lat: float,
        max_lon: float,
        max_lat: float,
        limit: int = 10
    ) -> List[Dict[str, Any]]:
        """
        Query NRCan STAC API for LiDAR DTM tiles intersecting the given WGS84 bounding box.
        """
        bbox_str = f"{min_lon},{min_lat},{max_lon},{max_lat}"
        params = {
            "bbox": bbox_str,
            "limit": limit
        }
        
        try:
            logger.info(f"Querying NRCan STAC catalog for bbox [{bbox_str}]...")
            resp = self.session.get(NRCAN_STAC_URL, params=params, timeout=self.timeout)
            if resp.status_code == 200:
                data = resp.json()
                features = data.get("features", [])
                logger.info(f"NRCan STAC returned {len(features)} matching tile(s).")
                
                results = []
                for feat in features:
                    assets = feat.get("assets", {})
                    # Look for DTM Cloud-Optimized GeoTIFF asset
                    dtm_asset = assets.get("dtm") or assets.get("data")
                    url = dtm_asset.get("href") if dtm_asset else None
                    
                    results.append({
                        "id": feat.get("id"),
                        "bbox": feat.get("bbox"),
                        "properties": feat.get("properties", {}),
                        "dtm_url": url,
                        "assets": assets
                    })
                return results
            else:
                logger.warning(f"NRCan STAC API returned HTTP {resp.status_code}: {resp.text[:200]}")
                return []
        except Exception as e:
            logger.warning(f"Failed to query NRCan STAC API: {e}")
            return []

    def get_wcs_coverage_url(
        self,
        min_lon: float,
        min_lat: float,
        max_lon: float,
        max_lat: float,
        crs: str = "EPSG:4326"
    ) -> str:
        """
        Constructs an OGC WCS 2.0.1 GetCoverage URL to directly extract a GeoTIFF
        from NRCan's CanElevation WCS server.
        """
        query_params = [
            ("SERVICE", "WCS"),
            ("VERSION", "2.0.1"),
            ("REQUEST", "GetCoverage"),
            ("COVERAGEID", "dtm"),
            ("FORMAT", "image/tiff"),
            ("SUBSET", f"Long({min_lon},{max_lon})"),
            ("SUBSET", f"Lat({min_lat},{max_lat})"),
        ]
        param_str = "&".join(f"{k}={v}" for k, v in query_params)
        return f"{NRCAN_WCS_URL}?{param_str}"
