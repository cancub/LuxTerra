"""
Abstract Base Class for Terrain Occlusion and Ray-Marching Engines.
"""

from abc import ABC, abstractmethod
from typing import List, Tuple
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
        Computes a 2D binary shadow mask across the target patch slice for a single sun angle.
        """
        pass

    @abstractmethod
    def compute_shadow_masks_batch(
        self,
        elevation_grid: np.ndarray,
        patch_slice_y: slice,
        patch_slice_x: slice,
        sun_angles: List[Tuple[float, float]],
        resolution_m: float = 1.0,
        max_search_radius_m: float = 500.0
    ) -> List[np.ndarray]:
        """
        Computes binary shadow masks for an ordered sequence of (azimuth, elevation) pairs.
        Allows engines to optimize memory transfers by loading elevation_grid into VRAM once.
        """
        pass

    def compute_dual_shadow_mask(
        self,
        dtm_grid: np.ndarray,
        dsm_grid: np.ndarray,
        patch_slice_y: slice,
        patch_slice_x: slice,
        solar_azimuth_deg: float,
        solar_elevation_deg: float,
        resolution_m: float = 1.0,
        max_search_radius_m: float = 500.0,
        is_rooftop: bool = True,
        ground_stand_height_m: float = 1.5
    ) -> Tuple[np.ndarray, np.ndarray]:
        """
        Computes dual binary shadow masks (terrain_mask, canopy_mask) for a single sun angle.
        """
        pass

    def compute_dual_shadow_masks_batch(
        self,
        dtm_grid: np.ndarray,
        dsm_grid: np.ndarray,
        patch_slice_y: slice,
        patch_slice_x: slice,
        sun_angles: List[Tuple[float, float]],
        resolution_m: float = 1.0,
        max_search_radius_m: float = 500.0,
        is_rooftop: bool = True,
        ground_stand_height_m: float = 1.5
    ) -> Tuple[List[np.ndarray], List[np.ndarray]]:
        """
        Batch computes dual shadow masks across multiple sun angles.
        """
        pass
