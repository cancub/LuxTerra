"""
Factory for instantiating the optimal OcclusionEngine backend.
Automatically detects GPU hardware and falls back gracefully to NumPy CPU.
"""

import logging
from ...interfaces.occlusion_engine import OcclusionEngine
from .numpy_raymarch import NumPyOcclusionEngine

logger = logging.getLogger(__name__)


def is_gpu_available() -> bool:
    """Check if CUDA and CuPy are operational on the host."""
    try:
        import cupy as cp
        return cp.cuda.is_available() and cp.cuda.runtime.getDeviceCount() > 0
    except Exception:
        return False


def get_best_occlusion_engine(prefer_gpu: bool = True) -> OcclusionEngine:
    """
    Returns CuPyOcclusionEngine if GPU is available and preferred, else NumPyOcclusionEngine.
    """
    if prefer_gpu and is_gpu_available():
        try:
            from .cupy_raymarch import CuPyOcclusionEngine
            engine = CuPyOcclusionEngine()
            logger.info("Initialized CuPyOcclusionEngine with NVIDIA GPU acceleration.")
            return engine
        except Exception as e:
            logger.warning(f"Failed to initialize CuPyOcclusionEngine: {e}. Falling back to NumPy CPU engine.")

    logger.info("Initialized NumPyOcclusionEngine (CPU fallback).")
    return NumPyOcclusionEngine()
