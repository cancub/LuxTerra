"""
FastAPI application entrypoint for LuxTerra.
"""

from pathlib import Path
from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

from .config import AppConfig, get_config
from .services.occlusion.factory import is_gpu_available
from .routers.simulate import router as simulate_router
from .routers.elevation import router as elevation_router

cfg = get_config()

app = FastAPI(
    title=cfg.app_title,
    version=cfg.app_version,
    description="High-resolution Quebec solar potential and geological terrain-shadow simulation API."
)

app.add_middleware(GZipMiddleware, minimum_size=4096, compresslevel=1)
app.add_middleware(
    CORSMiddleware,
    allow_origins=cfg.cors_origins,
    allow_credentials=("*" not in cfg.cors_origins),
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(simulate_router)
app.include_router(elevation_router)


@app.get("/api/health", tags=["System"])
def health_check(app_cfg: AppConfig = Depends(get_config)):
    """
    Health check returning system status, version, and GPU acceleration status.
    """
    gpu_active = is_gpu_available()
    device_name = None
    if gpu_active:
        try:
            import cupy as cp
            device_name = cp.cuda.runtime.getDeviceProperties(0)['name'].decode('utf-8')
        except Exception:
            device_name = "NVIDIA CUDA Device"

    return {
        "status": "ok",
        "app": app_cfg.app_title,
        "version": app_cfg.app_version,
        "gpu_available": gpu_active,
        "gpu_device": device_name,
        "max_patch_area_m2": app_cfg.max_patch_area_m2,
        "default_buffer_meters": app_cfg.default_buffer_meters
    }


# Serve production frontend static assets if built
FRONTEND_DIST_DIR = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if FRONTEND_DIST_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIST_DIR), html=True), name="frontend")
