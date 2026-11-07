"""
FastAPI dependency injection wiring for LuxTerra services.
Enables component swapping and dependency inversion.
"""

from functools import lru_cache

from .config import AppConfig, get_config
from .interfaces.elevation_source import ElevationProvider
from .interfaces.solar_engine import SolarEngine
from .interfaces.occlusion_engine import OcclusionEngine
from .interfaces.pv_model import PVSystemModel

from .services.elevation.tile_cache import TileCacheManager
from .services.elevation.local_geotiff import LocalGeoTIFFProvider
from .services.solar.pvlib_engine import PvlibSolarEngine
from .services.occlusion.factory import get_best_occlusion_engine
from .services.pv.standard_pv import StandardPVModel


@lru_cache()
def get_tile_cache_manager() -> TileCacheManager:
    return TileCacheManager()


@lru_cache()
def get_elevation_provider() -> ElevationProvider:
    return LocalGeoTIFFProvider(cache_manager=get_tile_cache_manager())


@lru_cache()
def get_solar_engine() -> SolarEngine:
    return PvlibSolarEngine()


@lru_cache()
def get_occlusion_engine() -> OcclusionEngine:
    return get_best_occlusion_engine(prefer_gpu=True)


@lru_cache()
def get_pv_model() -> PVSystemModel:
    return StandardPVModel()
