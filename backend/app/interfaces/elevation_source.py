"""
Abstract Base Class for Elevation Providers.
Allows swapping between Local GeoTIFFs, WCS on-demand querying, or synthetic test rasters.
"""

from abc import ABC, abstractmethod
from typing import Dict, Any, Tuple
import numpy as np


class ElevationProvider(ABC):
    """
    Abstract interface for retrieving windowed Digital Terrain Model (DTM) data.
    """

    @abstractmethod
    def get_elevation_window(
        self,
        min_lon: float,
        min_lat: float,
        max_lon: float,
        max_lat: float,
        buffer_meters: float = 500.0,
        target_resolution_m: float = 1.0
    ) -> Dict[str, Any]:
        """
        Extracts elevation matrix for the bounding box + outward buffer.
        
        Returns a dict containing:
          - "buffered_elevation": 2D numpy array of shape (H, W) in float32 (meters)
          - "patch_slice_y": slice(y_start, y_end) representing the patch inside buffered_elevation
          - "patch_slice_x": slice(x_start, x_end) representing the patch inside buffered_elevation
          - "resolution_m": float, cell size in meters
          - "crs": str, EPSG or WKT of the metric grid
          - "affine_transform": Affine transformation matrix
          - "median_elevation_m": float, median bare-earth elevation of the target patch
          - "geo_info": metadata from buffer_bounding_box_meters
        """
        pass
