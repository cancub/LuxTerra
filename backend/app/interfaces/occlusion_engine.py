"""
Abstract Base Class for Terrain Occlusion and Ray-Marching Engines.
"""

from abc import ABC, abstractmethod
import numpy as np


class OcclusionEngine(ABC):
    """
    Abstract interface for computing terrain shadow masks.
    Can be backed by GPU kernels (CuPy) or CPU vectorization (NumPy).
    """

    @abstractmethod
    def compute_shadow_mask(
        self,
        elevation_grid: np.ndarray,
        patch_slice_y: slice,
        patch_slice_x: slice,
        solar_azimuth_deg: float,
        solar_elevation_deg: float,
        resolution_m: float = 1.0,
        max_search_radius_m: float = 500.0
    ) -> np.ndarray:
        """
        Computes a 2D binary shadow mask across the target patch slice.
        
        Parameters:
          - elevation_grid: 2D array of buffered elevation (patch + 500m perimeter) in meters
          - patch_slice_y: Row slice for the target patch within elevation_grid
          - patch_slice_x: Column slice for the target patch within elevation_grid
          - solar_azimuth_deg: Solar azimuth in degrees (180° = True South)
          - solar_elevation_deg: Solar elevation angle above horizon in degrees
          - resolution_m: Spatial resolution of each cell (default: 1.0m)
          - max_search_radius_m: Maximum distance outward to check for shadow-casting features (default: 500m)
          
        Returns:
          - 2D uint8 numpy array corresponding to the target patch:
            1 = Unshaded (direct line-of-sight to the sun)
            0 = Shaded (occluded by terrain)
        """
        pass
