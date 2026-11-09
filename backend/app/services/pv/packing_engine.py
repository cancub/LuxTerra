"""
Maximal solar panel distribution and racking geometry packing engine.
Computes optimal East-West ground-mount solar table layout within arbitrary polygons or bounding boxes,
enforcing Winter Solstice Solar Noon self-shading clearance pitch.
"""

from typing import List, Tuple, Optional, Union
import numpy as np
import shapely
from shapely.geometry import Polygon as ShapelyPolygon, box, MultiPolygon, Point

from ...schemas.domain import PVLayoutResult, PVTableGeometry, GeoBoundingBox
from ..elevation.geo_utils import get_utm_crs_for_lon_lat, transform_geometry, get_transformer


def calculate_winter_solstice_pitch(
    latitude: float,
    tilt_deg: float,
    slant_height_m: float = 4.56,
    stand_height_m: float = 1.0,
    buffer_m: float = 0.5
) -> Tuple[float, float, float]:
    """
    Calculates inter-row pitch and gap based on Winter Solstice Solar Noon cutoff.
    Ensures zero row-to-row shading when the sun is at its lowest midday point (Dec 21).

    Returns:
        (row_pitch_m, row_depth_m, inter_row_gap_m)
    """
    if tilt_deg <= 0.0:
        # Flat horizontal layout
        return round(slant_height_m + buffer_m, 2), round(slant_height_m, 2), round(buffer_m, 2)

    # Solar declination on Dec 21 is -23.44°
    # Solar noon elevation = 90 - (latitude - declination) = 90 - (latitude + 23.44)
    winter_noon_elevation = max(5.0, 90.0 - (abs(latitude) + 23.44))
    elevation_rad = np.radians(winter_noon_elevation)
    tilt_rad = np.radians(tilt_deg)

    # Horizontal footprint depth of tilted table
    row_depth_m = slant_height_m * np.cos(tilt_rad)

    # Vertical height rise of panel table
    height_rise_m = slant_height_m * np.sin(tilt_rad)

    # Shadow length cast to the north at solar noon
    shadow_length_m = height_rise_m / np.tan(elevation_rad)

    # Row pitch (distance between front edges of adjacent rows)
    row_pitch_m = row_depth_m + shadow_length_m + buffer_m
    inter_row_gap_m = shadow_length_m + buffer_m

    return round(float(row_pitch_m), 2), round(float(row_depth_m), 2), round(float(inter_row_gap_m), 2)


class PVPackingEngine:
    """
    High-performance 2D/3D solar table layout synthesizer for arbitrary polygons and boxes.
    """

    def __init__(
        self,
        module_wattage_w: float = 550.0,
        module_width_m: float = 1.134,
        module_length_m: float = 2.278,
        stand_height_m: float = 1.0,
        setback_m: float = 2.0,
        max_pairs_per_table: int = 10,
        min_pairs_per_table: int = 2,
        aisle_width_m: float = 0.8
    ):
        self.module_wattage_w = module_wattage_w
        self.module_width_m = module_width_m
        self.module_length_m = module_length_m
        self.stand_height_m = stand_height_m
        self.setback_m = setback_m
        self.max_pairs_per_table = max_pairs_per_table
        self.min_pairs_per_table = min_pairs_per_table
        self.aisle_width_m = aisle_width_m

        # 2-in-portrait configuration: 2 panels stacked along the slope
        self.slant_height_m = round(2.0 * module_length_m + 0.02, 3)
        self.pair_width_m = round(module_width_m + 0.02, 3)

    def generate_layout(
        self,
        boundary: Union[List[List[float]], GeoBoundingBox],
        latitude: float,
        design_tilt_deg: float = 30.0,
        current_tilt_deg: Optional[float] = None,
        tilt_deg: Optional[float] = None,
        buffer_m: float = 0.5
    ) -> PVLayoutResult:
        """
        Synthesizes the maximal ground-mount solar table layout within the given boundary.
        The physical layout (row pitch, table locations, panel count, installed DC capacity)
        is permanently locked to the site civil design tilt (default: 30° True South).
        If current_tilt_deg is provided (e.g. seasonal optimal tilt), each table tilts around
        its fixed ground center without changing its physical placement or panel count.

        Args:
            boundary: List of [lon, lat] coordinates defining a closed polygon, or a GeoBoundingBox.
            latitude: Site latitude in degrees North.
            design_tilt_deg: Permanent array civil racking design tilt (default: 30.0°).
            current_tilt_deg: Optional operational/seasonal panel tilt angle for this simulation date.
            tilt_deg: Backward-compatible alias for current_tilt_deg.
            buffer_m: Extra safety buffer added to self-shading pitch.

        Returns:
            PVLayoutResult containing metrics and individual 3D table geometries.
        """
        if tilt_deg is not None and current_tilt_deg is None:
            current_tilt_deg = tilt_deg
        if current_tilt_deg is None:
            current_tilt_deg = design_tilt_deg

        # 1. Construct Shapely polygon in WGS84
        if isinstance(boundary, GeoBoundingBox):
            poly_wgs84 = box(boundary.min_lon, boundary.min_lat, boundary.max_lon, boundary.max_lat)
        elif isinstance(boundary, list) and len(boundary) >= 3:
            poly_wgs84 = ShapelyPolygon(boundary)
        else:
            return self._empty_result(0.0, 0.0, 0.0)

        if not poly_wgs84.is_valid:
            poly_wgs84 = poly_wgs84.buffer(0)

        if poly_wgs84.is_empty or poly_wgs84.area <= 0.0:
            return self._empty_result(0.0, 0.0, 0.0)

        center_lon = float(poly_wgs84.centroid.x)
        center_lat = float(poly_wgs84.centroid.y)

        # 2. Transform to local metric UTM projection
        utm_crs = get_utm_crs_for_lon_lat(center_lon, center_lat)
        poly_utm = transform_geometry(poly_wgs84, "EPSG:4326", utm_crs)
        site_area_m2 = float(poly_utm.area)

        # 3. Calculate pitch and dimensions based on permanent site civil design tilt
        pitch_m, design_depth_m, gap_m = calculate_winter_solstice_pitch(
            latitude=latitude,
            tilt_deg=design_tilt_deg,
            slant_height_m=self.slant_height_m,
            stand_height_m=self.stand_height_m,
            buffer_m=buffer_m
        )

        # 4. Apply boundary setbacks (gracefully falling back if polygon is small)
        setback_poly = poly_utm.buffer(-self.setback_m)
        if setback_poly.is_empty or setback_poly.area < 20.0:
            setback_poly = poly_utm.buffer(-1.0)
        if setback_poly.is_empty or setback_poly.area < 10.0:
            setback_poly = poly_utm.buffer(-0.5)

        if setback_poly.is_empty or setback_poly.area < 10.0:
            return self._empty_result(pitch_m, gap_m, site_area_m2)

        # Coordinate transformer for fast UTM -> WGS84 batch mapping
        transformer = get_transformer(utm_crs, "EPSG:4326")

        # Operational tilt delta for North-South projection around fixed center
        curr_tilt_rad = np.radians(current_tilt_deg)
        half_depth_curr = 0.5 * self.slant_height_m * np.cos(curr_tilt_rad)
        actual_depth_m = round(float(2.0 * half_depth_curr), 2)

        # 5. Pack East-West rows within setback polygon using permanent design pitch
        min_x, min_y, max_x, max_y = setback_poly.bounds
        avail_h = max_y - min_y
        max_rows = int((avail_h - design_depth_m) // pitch_m) + 1 if avail_h >= design_depth_m else 0
        used_h = (max_rows - 1) * pitch_m + design_depth_m if max_rows > 0 else 0
        margin_y = max(0.0, (avail_h - used_h) / 2.0)

        # Center rows vertically in the setback envelope so the bottom row is not clipped by corner slant
        y = min_y + margin_y
        row_index = 0
        table_id = 0
        tables: List[PVTableGeometry] = []
        min_table_width = self.min_pairs_per_table * self.pair_width_m

        while y + design_depth_m <= max_y + 0.01:
            band = box(min_x - 10.0, y, max_x + 10.0, y + design_depth_m)
            inter = setback_poly.intersection(band)

            if not inter.is_empty:
                geoms = inter.geoms if hasattr(inter, "geoms") else [inter]
                for g in geoms:
                    if g.area < min_table_width * design_depth_m * 0.8:
                        continue

                    gx_min, gy_min, gx_max, gy_max = g.bounds
                    x = gx_min

                    while x + min_table_width <= gx_max:
                        # Find maximum integer 2P pairs that fit within the polygon
                        fit_pairs = 0
                        for n in range(self.min_pairs_per_table, self.max_pairs_per_table + 1):
                            cand_width = n * self.pair_width_m
                            cand_box = box(x, y, x + cand_width, y + design_depth_m)
                            if setback_poly.contains(cand_box) or setback_poly.intersection(cand_box).area >= 0.96 * cand_box.area:
                                fit_pairs = n
                            else:
                                break

                        if fit_pairs >= self.min_pairs_per_table:
                            tbl_width = round(fit_pairs * self.pair_width_m, 2)
                            # Permanent table center in UTM
                            c_x = x + tbl_width / 2.0
                            c_y = y + design_depth_m / 2.0

                            # 4 corners in UTM tilted around fixed center: SW, SE, NE, NW
                            y_south = c_y - half_depth_curr
                            y_north = c_y + half_depth_curr
                            utmx = [x, x + tbl_width, x + tbl_width, x]
                            utmy = [y_south, y_south, y_north, y_north]

                            lons, lats = transformer.transform(utmx, utmy)
                            c_lon, c_lat = transformer.transform(c_x, c_y)

                            corners_wgs84 = [
                                [round(float(lo), 7), round(float(la), 7)]
                                for lo, la in zip(lons, lats)
                            ]

                            tables.append(
                                PVTableGeometry(
                                    table_id=table_id,
                                    row_index=row_index,
                                    panel_count=fit_pairs * 2,
                                    corners_wgs84=corners_wgs84,
                                    center_wgs84=[round(float(c_lon), 7), round(float(c_lat), 7)],
                                    azimuth_deg=180.0,
                                    tilt_deg=round(current_tilt_deg, 1),
                                    stand_height_m=self.stand_height_m,
                                    slant_height_m=self.slant_height_m,
                                    width_m=tbl_width,
                                    depth_m=actual_depth_m
                                )
                            )
                            table_id += 1
                            x += tbl_width + self.aisle_width_m
                        else:
                            x += 0.5

            y += pitch_m
            row_index += 1

        # Re-index row_index consecutively from 0 (southernmost front row) upwards
        if tables:
            distinct_rows = sorted(list({t.row_index for t in tables}))
            row_map = {old_idx: new_idx for new_idx, old_idx in enumerate(distinct_rows)}
            for t in tables:
                t.row_index = row_map[t.row_index]

        total_panels = sum(t.panel_count for t in tables)
        total_tables = len(tables)
        installed_dc_kw = round(total_panels * self.module_wattage_w / 1000.0, 2)
        total_module_area = total_panels * (self.module_width_m * self.module_length_m)
        physical_gcr = round(total_module_area / site_area_m2, 3) if site_area_m2 > 0 else 0.0

        return PVLayoutResult(
            total_panels=total_panels,
            total_tables=total_tables,
            installed_dc_kw=installed_dc_kw,
            module_wattage_w=self.module_wattage_w,
            module_width_m=self.module_width_m,
            module_length_m=self.module_length_m,
            row_pitch_m=pitch_m,
            inter_row_gap_m=gap_m,
            physical_gcr=physical_gcr,
            tables=tables
        )

    def _empty_result(self, pitch_m: float, gap_m: float, site_area_m2: float) -> PVLayoutResult:
        return PVLayoutResult(
            total_panels=0,
            total_tables=0,
            installed_dc_kw=0.0,
            module_wattage_w=self.module_wattage_w,
            module_width_m=self.module_width_m,
            module_length_m=self.module_length_m,
            row_pitch_m=pitch_m,
            inter_row_gap_m=gap_m,
            physical_gcr=0.0,
            tables=[]
        )
