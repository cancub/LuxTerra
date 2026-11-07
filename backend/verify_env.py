"""
LuxTerra Environment & Hardware Verification Script
Tests Python environment, CUDA / CuPy GPU functionality, GDAL / rasterio, and pvlib.
"""

import sys

def verify_environment():
    print("=== LuxTerra Diagnostic Suite ===")
    print(f"Python Version: {sys.version.split()[0]}")
    
    all_ok = True
    
    # 1. Test GPU / CuPy
    print("\n--- 1. Testing GPU & CUDA (CuPy) ---")
    try:
        import cupy as cp
        device_count = cp.cuda.runtime.getDeviceCount()
        device_id = cp.cuda.Device().id
        device_name = cp.cuda.runtime.getDeviceProperties(device_id)['name'].decode('utf-8')
        print(f"CUDA Available: YES (Found {device_count} device(s))")
        print(f"Primary Device [{device_id}]: {device_name}")
        
        # Test basic array allocation and arithmetic on GPU
        a = cp.array([1.0, 2.0, 3.0], dtype=cp.float32)
        b = a * 2.0
        assert float(b[1]) == 4.0
        print("GPU Memory Allocation & Math Kernel: PASS")
    except ImportError:
        print("CuPy is NOT installed. GPU acceleration will be disabled.")
        all_ok = False
    except Exception as e:
        print(f"CUDA/CuPy Error: {e}")
        all_ok = False

    # 2. Test GDAL / Rasterio
    print("\n--- 2. Testing Geospatial & Raster Drivers (rasterio) ---")
    try:
        import rasterio
        from rasterio.io import MemoryFile
        import numpy as np
        
        print(f"rasterio Version: {rasterio.__version__}")
        print(f"GDAL Version: {rasterio.__gdal_version__}")
        
        # Test in-memory GeoTIFF creation & read
        from rasterio.transform import from_origin
        data = np.ones((10, 10), dtype=np.float32)
        transform = from_origin(0, 10, 1, 1)
        with MemoryFile() as memfile:
            with memfile.open(
                driver='GTiff',
                height=10,
                width=10,
                count=1,
                dtype=data.dtype,
                crs='EPSG:4326',
                transform=transform
            ) as dataset:
                dataset.write(data, 1)
            
            with memfile.open() as dataset:
                read_data = dataset.read(1)
                assert read_data.shape == (10, 10)
        print("Rasterio In-Memory GeoTIFF Read/Write: PASS")
    except ImportError:
        print("rasterio is NOT installed.")
        all_ok = False
    except Exception as e:
        print(f"rasterio Error: {e}")
        all_ok = False

    # 3. Test Solar Engine (pvlib)
    print("\n--- 3. Testing Solar Modeling (pvlib) ---")
    try:
        import pvlib
        import pandas as pd
        print(f"pvlib Version: {pvlib.__version__}")
        
        # Quick test calculation for Montreal
        times = pd.date_range("2026-06-21 12:00", periods=1, freq="h", tz="America/Toronto")
        solpos = pvlib.solarposition.get_solarposition(times, 45.503, -73.618)
        elevation = float(solpos['elevation'].iloc[0])
        azimuth = float(solpos['azimuth'].iloc[0])
        print(f"Montreal Summer Solstice Noon Sun: Elevation = {elevation:.1f}°, Azimuth = {azimuth:.1f}°")
        print("Solar Position & pvlib Engine: PASS")
    except ImportError:
        print("pvlib is NOT installed.")
        all_ok = False
    except Exception as e:
        print(f"pvlib Error: {e}")
        all_ok = False

    # 4. Test Coordinate Transformations (pyproj & shapely)
    print("\n--- 4. Testing Projections & Geometry (pyproj & shapely) ---")
    try:
        import pyproj
        import shapely
        from shapely.geometry import box
        
        # Test WGS84 to Quebec Lambert (EPSG:32198)
        transformer = pyproj.Transformer.from_crs("EPSG:4326", "EPSG:32198", always_xy=True)
        x, y = transformer.transform(-73.618, 45.503)
        print(f"Reprojection Montreal (-73.618, 45.503) -> MTM/Quebec Lambert: ({x:.1f}, {y:.1f})")
        
        b = box(0, 0, 100, 100)
        assert b.area == 10000.0
        print("Coordinate Transformer & Shapely Geometry: PASS")
    except ImportError as e:
        print(f"Geometry/Projection Library missing: {e}")
        all_ok = False
    except Exception as e:
        print(f"Projection Error: {e}")
        all_ok = False

    print("\n==================================")
    if all_ok:
        print("ALL DIAGNOSTICS PASSED! Environment is ready.")
        return 0
    else:
        print("DIAGNOSTICS FAILED. Missing or broken components.")
        return 1

if __name__ == "__main__":
    sys.exit(verify_environment())
