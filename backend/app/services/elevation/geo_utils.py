"""
Geospatial transformation and geodesic buffering utilities for LuxTerra.
"""

from typing import Tuple, Dict, Any
import pyproj
from shapely.geometry import box, Polygon
from shapely.ops import transform


def get_utm_crs_for_lon_lat(lon: float, lat: float) -> str:
    """
    Determine the optimal UTM EPSG code for a given WGS84 longitude and latitude.
    For Quebec (Zones 17, 18, 19, 20 North), this ensures metric accuracy.
    """
    zone = int((lon + 180) // 6) + 1
    epsg = 32600 + zone if lat >= 0 else 32700 + zone
    return f"EPSG:{epsg}"


def calculate_bbox_area_meters(min_lon: float, min_lat: float, max_lon: float, max_lat: float) -> float:
    """
    Calculate the accurate surface area of a WGS84 bounding box in square meters.
    Uses equal-area / local UTM projection to avoid high-latitude distortion.
    """
    center_lon = (min_lon + max_lon) / 2.0
    center_lat = (min_lat + max_lat) / 2.0
    utm_crs = get_utm_crs_for_lon_lat(center_lon, center_lat)
    
    project = pyproj.Transformer.from_crs("EPSG:4326", utm_crs, always_xy=True).transform
    geom_wgs84 = box(min_lon, min_lat, max_lon, max_lat)
    geom_metric = transform(project, geom_wgs84)
    
    return float(geom_metric.area)


def buffer_bounding_box_meters(
    min_lon: float,
    min_lat: float,
    max_lon: float,
    max_lat: float,
    buffer_meters: float = 500.0,
    target_crs: str = None
) -> Dict[str, Any]:
    """
    Buffers a WGS84 bounding box outward by `buffer_meters` in metric planar coordinates.
    Returns:
      - target_crs: The metric CRS used (e.g. UTM Zone 18N or provided CRS)
      - patch_bounds_metric: (min_x, min_y, max_x, max_y)
      - buffered_bounds_metric: (min_x, min_y, max_x, max_y)
      - patch_area_m2: Surface area of the target patch
      - patch_bounds_wgs84: (min_lon, min_lat, max_lon, max_lat)
      - buffered_bounds_wgs84: (min_lon, min_lat, max_lon, max_lat)
    """
    center_lon = (min_lon + max_lon) / 2.0
    center_lat = (min_lat + max_lat) / 2.0
    
    if target_crs is None:
        target_crs = get_utm_crs_for_lon_lat(center_lon, center_lat)
        
    to_metric = pyproj.Transformer.from_crs("EPSG:4326", target_crs, always_xy=True).transform
    to_wgs84 = pyproj.Transformer.from_crs(target_crs, "EPSG:4326", always_xy=True).transform
    
    patch_wgs84 = box(min_lon, min_lat, max_lon, max_lat)
    patch_metric = transform(to_metric, patch_wgs84)
    
    min_x, min_y, max_x, max_y = patch_metric.bounds
    patch_area = float(patch_metric.area)
    
    # Expand box outward by buffer_meters in all four cardinal directions
    buff_min_x = min_x - buffer_meters
    buff_min_y = min_y - buffer_meters
    buff_max_x = max_x + buffer_meters
    buff_max_y = max_y + buffer_meters
    
    buffered_metric_box = box(buff_min_x, buff_min_y, buff_max_x, buff_max_y)
    buffered_wgs84 = transform(to_wgs84, buffered_metric_box)
    b_min_lon, b_min_lat, b_max_lon, b_max_lat = buffered_wgs84.bounds
    
    return {
        "target_crs": target_crs,
        "patch_bounds_metric": (min_x, min_y, max_x, max_y),
        "buffered_bounds_metric": (buff_min_x, buff_min_y, buff_max_x, buff_max_y),
        "patch_area_m2": patch_area,
        "patch_bounds_wgs84": (min_lon, min_lat, max_lon, max_lat),
        "buffered_bounds_wgs84": (b_min_lon, b_min_lat, b_max_lon, b_max_lat),
        "patch_width_m": max_x - min_x,
        "patch_height_m": max_y - min_y,
        "buffered_width_m": buff_max_x - buff_min_x,
        "buffered_height_m": buff_max_y - buff_min_y,
    }
