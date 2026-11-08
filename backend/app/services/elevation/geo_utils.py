"""
Geospatial transformation and geodesic buffering utilities for LuxTerra.
"""

from functools import lru_cache
from typing import Tuple, Dict, Any, Optional, List
import pyproj
import shapely
from shapely.geometry import box, Polygon


@lru_cache(maxsize=32)
def get_transformer(from_crs: str, to_crs: str) -> pyproj.Transformer:
    """
    Cached factory for pyproj.Transformer instances to avoid repeated initialization overhead.
    """
    return pyproj.Transformer.from_crs(from_crs, to_crs, always_xy=True)


def transform_geometry(geom: shapely.Geometry, from_crs: str, to_crs: str) -> shapely.Geometry:
    """
    Transforms a Shapely geometry between coordinate reference systems.
    Uses shapely.transform with interleaved=False as recommended for pyproj.Transformer.
    """
    if from_crs == to_crs:
        return geom
    transformer = get_transformer(from_crs, to_crs)
    return shapely.transform(geom, transformer.transform, interleaved=False)


def get_utm_crs_for_lon_lat(lon: float, lat: float) -> str:
    """
    Determine the optimal UTM EPSG code for a given WGS84 longitude and latitude.
    For Quebec (Zones 17, 18, 19, 20 North), this ensures metric accuracy.
    """
    zone = int((lon + 180) // 6) + 1
    epsg = 32600 + zone if lat >= 0 else 32700 + zone
    return f"EPSG:{epsg}"


def normalize_bbox(min_lon: float, min_lat: float, max_lon: float, max_lat: float) -> Tuple[float, float, float, float]:
    """
    Ensures min <= max for bounding box coordinates, gracefully handling reversed drag inputs.
    """
    norm_min_lon = min(min_lon, max_lon)
    norm_max_lon = max(min_lon, max_lon)
    norm_min_lat = min(min_lat, max_lat)
    norm_max_lat = max(min_lat, max_lat)
    return norm_min_lon, norm_min_lat, norm_max_lon, norm_max_lat


def calculate_bbox_area_meters(min_lon: float, min_lat: float, max_lon: float, max_lat: float) -> float:
    """
    Calculate the accurate surface area of a WGS84 bounding box in square meters.
    Uses local UTM projection to avoid high-latitude distortion.
    """
    min_lon, min_lat, max_lon, max_lat = normalize_bbox(min_lon, min_lat, max_lon, max_lat)
    center_lon = (min_lon + max_lon) / 2.0
    center_lat = (min_lat + max_lat) / 2.0
    utm_crs = get_utm_crs_for_lon_lat(center_lon, center_lat)
    
    geom_wgs84 = box(min_lon, min_lat, max_lon, max_lat)
    geom_metric = transform_geometry(geom_wgs84, "EPSG:4326", utm_crs)
    
    return float(geom_metric.area)


def calculate_polygon_area_meters(coordinates: List[List[float]]) -> float:
    """
    Calculate the accurate surface area of an arbitrary WGS84 polygon in square meters.
    Uses local UTM projection to ensure precise metric calculations.
    """
    from shapely.geometry import Polygon as ShapelyPolygon
    if not coordinates or len(coordinates) < 3:
        return 0.0
    poly_wgs84 = ShapelyPolygon(coordinates)
    center_lon = float(poly_wgs84.centroid.x)
    center_lat = float(poly_wgs84.centroid.y)
    utm_crs = get_utm_crs_for_lon_lat(center_lon, center_lat)
    poly_metric = transform_geometry(poly_wgs84, "EPSG:4326", utm_crs)
    return float(poly_metric.area)


def validate_patch_area(
    min_lon: float,
    min_lat: float,
    max_lon: float,
    max_lat: float,
    max_area_m2: float = 100000.0
) -> Tuple[bool, float, str]:
    """
    Validates whether a bounding box falls within the allowed maximum surface area (default 100,000 m²).
    Returns (is_valid, computed_area_m2, message).
    """
    area_m2 = calculate_bbox_area_meters(min_lon, min_lat, max_lon, max_lat)
    if area_m2 <= 0.0:
        return False, 0.0, "Bounding box area must be greater than zero."
    if area_m2 > max_area_m2:
        return (
            False,
            area_m2,
            f"Selected area ({area_m2:,.1f} m²) exceeds the maximum allowable limit of {max_area_m2:,.0f} m²."
        )
    return True, area_m2, "Area is valid."


def buffer_bounding_box_meters(
    min_lon: float,
    min_lat: float,
    max_lon: float,
    max_lat: float,
    buffer_meters: float = 1000.0,
    target_crs: Optional[str] = None
) -> Dict[str, Any]:
    """
    Buffers a WGS84 bounding box outward by `buffer_meters` in metric planar coordinates.
    Returns metric and geographic bounds, dimensions, and area.
    """
    min_lon, min_lat, max_lon, max_lat = normalize_bbox(min_lon, min_lat, max_lon, max_lat)
    center_lon = (min_lon + max_lon) / 2.0
    center_lat = (min_lat + max_lat) / 2.0
    
    if target_crs is None:
        target_crs = get_utm_crs_for_lon_lat(center_lon, center_lat)
        
    patch_wgs84 = box(min_lon, min_lat, max_lon, max_lat)
    patch_metric = transform_geometry(patch_wgs84, "EPSG:4326", target_crs)
    
    min_x, min_y, max_x, max_y = patch_metric.bounds
    patch_area = float(patch_metric.area)
    
    # Expand box outward by buffer_meters in all four cardinal directions
    buff_min_x = min_x - buffer_meters
    buff_min_y = min_y - buffer_meters
    buff_max_x = max_x + buffer_meters
    buff_max_y = max_y + buffer_meters
    
    buffered_metric_box = box(buff_min_x, buff_min_y, buff_max_x, buff_max_y)
    buffered_wgs84 = transform_geometry(buffered_metric_box, target_crs, "EPSG:4326")
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
