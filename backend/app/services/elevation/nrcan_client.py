"""
NRCan CanElevation / HRDEM STAC & WCS Client for Quebec LiDAR Elevation Data.
"""

import logging
import uuid
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple
import requests

logger = logging.getLogger(__name__)

# Official Geo.ca / CanElevation STAC API endpoint
NRCAN_STAC_URL = "https://datacube.services.geo.ca/stac/api/collections/hrdem-lidar/items"
NRCAN_WCS_URL = "https://maps-cartes.services.geo.ca/server_serveur/rest/services/NRCan/can_elevation_wcs/MapServer/WCSServer"


class NRCanClient:
    """
    Client for discovering and retrieving Canadian High Resolution Digital Elevation Model (HRDEM)
    bare-earth DTM and surface DSM rasters.
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
        Query NRCan STAC API for LiDAR DTM and DSM tiles intersecting the given WGS84 bounding box.
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
                    # Look for DTM and DSM Cloud-Optimized GeoTIFF assets
                    dtm_asset = assets.get("dtm") or assets.get("data")
                    dtm_url = dtm_asset.get("href") if dtm_asset else None
                    
                    dsm_asset = assets.get("dsm")
                    dsm_url = dsm_asset.get("href") if dsm_asset else None
                    
                    results.append({
                        "id": feat.get("id"),
                        "bbox": feat.get("bbox"),
                        "properties": feat.get("properties", {}),
                        "dtm_url": dtm_url,
                        "dsm_url": dsm_url,
                        "assets": assets
                    })
                return results
            else:
                logger.warning(f"NRCan STAC API returned HTTP {resp.status_code}: {resp.text[:200]}")
                return []
        except Exception as e:
            logger.warning(f"Failed to query NRCan STAC API: {e}")
            return []

    def download_tile(self, url: str, output_path: Path, timeout: int = 60) -> Path:
        """
        Downloads a GeoTIFF tile from a remote URL to the target path.
        Streams chunk-by-chunk to a temporary file before atomic rename.
        """
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        
        if output_path.exists() and output_path.stat().st_size > 0:
            logger.info(f"File {output_path.name} already exists. Skipping download.")
            return output_path

        temp_path = output_path.with_name(f"{output_path.name}.{uuid.uuid4().hex}.tmp")
        logger.info(f"Downloading raster from {url} to {temp_path}...")

        try:
            resp = self.session.get(url, stream=True, timeout=timeout)
            resp.raise_for_status()

            with open(temp_path, "wb") as f:
                for chunk in resp.iter_content(chunk_size=1024 * 1024):
                    if chunk:
                        f.write(chunk)

            temp_path.replace(output_path)
        except Exception:
            if temp_path.exists():
                temp_path.unlink(missing_ok=True)
            raise
        logger.info(f"Saved raster to {output_path} ({output_path.stat().st_size} bytes)")
        return output_path

    def download_dtm_tile(self, dtm_url: str, output_path: Path, timeout: int = 60) -> Path:
        """Downloads a bare-earth DTM raster from CanElevation."""
        return self.download_tile(dtm_url, output_path, timeout=timeout)

    def download_dsm_tile(self, dsm_url: str, output_path: Path, timeout: int = 60) -> Path:
        """Downloads a surface/canopy DSM raster from CanElevation."""
        return self.download_tile(dsm_url, output_path, timeout=timeout)

    def download_tile_pair(
        self,
        item: Dict[str, Any],
        target_dir: Path,
        prefix: Optional[str] = None
    ) -> Tuple[Optional[Path], Optional[Path]]:
        """
        Downloads both DTM and DSM tiles for a STAC item if available.
        Returns a tuple of (dtm_path, dsm_path).
        """
        target_dir = Path(target_dir)
        item_id = prefix or item.get("id") or "tile"
        
        dtm_path = None
        if item.get("dtm_url"):
            dest_dtm = target_dir / "dtm" / f"{item_id}_dtm.tif"
            dtm_path = self.download_dtm_tile(item["dtm_url"], dest_dtm)
            
        dsm_path = None
        if item.get("dsm_url"):
            dest_dsm = target_dir / "dsm" / f"{item_id}_dsm.tif"
            dsm_path = self.download_dsm_tile(item["dsm_url"], dest_dsm)
            
        return (dtm_path, dsm_path)

