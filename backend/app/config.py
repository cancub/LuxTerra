"""
Centralized application configuration and injectable simulation defaults.
"""

from typing import List
from pydantic import BaseModel


class AppConfig(BaseModel):
    """
    Configuration parameters for LuxTerra backend services.
    All numeric parameters are injectable and configurable.
    """
    app_title: str = "LuxTerra Solar & Occlusion API"
    app_version: str = "1.0.0"
    
    # Geographic and DTM limits
    max_patch_area_m2: float = 100000.0
    default_buffer_meters: float = 1000.0

    # CORS
    cors_origins: List[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "*"
    ]


# Singleton default config instance
config = AppConfig()


def get_config() -> AppConfig:
    """Dependency provider for application configuration."""
    return config
