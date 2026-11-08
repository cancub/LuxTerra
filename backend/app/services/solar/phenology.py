"""
Quebec seasonal canopy phenology model.
Models direct beam and diffuse solar transmittance through deciduous and mixed
boreal/temperate canopy as a function of Day of Year (DOY) in southern and Laurentian Quebec.
"""

from dataclasses import dataclass
from datetime import date, datetime
from typing import Union, Optional


@dataclass(frozen=True)
class CanopyTransmittance:
    direct: float
    diffuse: float
    doy: int
    season_name: str


# Summer Leaf-On: Dense foliage
SUMMER_DIRECT = 0.15
SUMMER_DIFFUSE = 0.25

# Winter Leaf-Off: Bare deciduous branches + conifer background retention
WINTER_DIRECT = 0.60
WINTER_DIFFUSE = 0.70

# Transition boundary DOYs (standard non-leap reference)
# Spring Budburst: Apr 16 (106) to May 14 (134)
SPRING_START_DOY = 106
SPRING_END_DOY = 134

# Summer Leaf-On: May 15 (135) to Oct 15 (288)
SUMMER_START_DOY = 135
SUMMER_END_DOY = 288

# Autumn Senescence: Oct 16 (289) to Nov 15 (319)
AUTUMN_START_DOY = 289
AUTUMN_END_DOY = 319


def get_day_of_year(target_date: Union[date, datetime, str, int]) -> int:
    """Extracts integer Day of Year (1..366) from various date formats."""
    if isinstance(target_date, int):
        return max(1, min(366, target_date))
    elif isinstance(target_date, str):
        # Format "YYYY-MM-DD"
        dt = date.fromisoformat(target_date)
        return dt.timetuple().tm_yday
    elif isinstance(target_date, (date, datetime)):
        return target_date.timetuple().tm_yday
    raise ValueError(f"Unsupported date format: {target_date} (type {type(target_date)})")


def calculate_canopy_transmittance(
    target_date: Union[date, datetime, str, int],
    mode: str = "seasonal"
) -> CanopyTransmittance:
    """
    Computes solar direct beam and diffuse transmittance through tree canopy.

    Modes:
      - 'seasonal': Dynamically computed from Day of Year (DOY) in Quebec.
      - 'leaf_on': Fixed summer canopy density (tau_direct = 0.15, tau_diffuse = 0.25).
      - 'leaf_off': Fixed winter bare-branch canopy (tau_direct = 0.60, tau_diffuse = 0.70).
      - 'bare_terrain': Complete canopy penetration / disabled (tau_direct = 1.0, tau_diffuse = 1.0).
    """
    doy = get_day_of_year(target_date)

    mode_lower = mode.lower().strip()
    if mode_lower == "leaf_on":
        return CanopyTransmittance(
            direct=SUMMER_DIRECT,
            diffuse=SUMMER_DIFFUSE,
            doy=doy,
            season_name="leaf_on"
        )
    elif mode_lower == "leaf_off":
        return CanopyTransmittance(
            direct=WINTER_DIRECT,
            diffuse=WINTER_DIFFUSE,
            doy=doy,
            season_name="leaf_off"
        )
    elif mode_lower == "bare_terrain":
        return CanopyTransmittance(
            direct=1.0,
            diffuse=1.0,
            doy=doy,
            season_name="bare_terrain"
        )
    elif mode_lower != "seasonal":
        raise ValueError(
            f"Unknown canopy mode '{mode}'. Supported modes: 'seasonal', 'leaf_on', 'leaf_off', 'bare_terrain'."
        )

    # Seasonal phenology schedule for Quebec
    if SUMMER_START_DOY <= doy <= SUMMER_END_DOY:
        # Full Summer Leaf-On (May 15 – Oct 15)
        return CanopyTransmittance(
            direct=SUMMER_DIRECT,
            diffuse=SUMMER_DIFFUSE,
            doy=doy,
            season_name="summer_leaf_on"
        )

    elif AUTUMN_START_DOY <= doy <= AUTUMN_END_DOY:
        # Autumn Senescence transition (Oct 16 – Nov 15)
        # Linear ramp from 0.15 up to 0.60
        span = float(AUTUMN_END_DOY - AUTUMN_START_DOY + 1)
        f = (doy - AUTUMN_START_DOY) / span
        direct = SUMMER_DIRECT + f * (WINTER_DIRECT - SUMMER_DIRECT)
        diffuse = SUMMER_DIFFUSE + f * (WINTER_DIFFUSE - SUMMER_DIFFUSE)
        return CanopyTransmittance(
            direct=float(round(direct, 4)),
            diffuse=float(round(diffuse, 4)),
            doy=doy,
            season_name="autumn_senescence"
        )

    elif SPRING_START_DOY <= doy <= SPRING_END_DOY:
        # Spring Budburst transition (Apr 16 – May 14)
        # Linear ramp from 0.60 down to 0.15
        span = float(SPRING_END_DOY - SPRING_START_DOY + 1)
        f = (doy - SPRING_START_DOY) / span
        direct = WINTER_DIRECT - f * (WINTER_DIRECT - SUMMER_DIRECT)
        diffuse = WINTER_DIFFUSE - f * (WINTER_DIFFUSE - SUMMER_DIFFUSE)
        return CanopyTransmittance(
            direct=float(round(direct, 4)),
            diffuse=float(round(diffuse, 4)),
            doy=doy,
            season_name="spring_budburst"
        )

    else:
        # Winter Leaf-Off (Nov 16 – Apr 15 / DOY 320–365 & 1–105)
        return CanopyTransmittance(
            direct=WINTER_DIRECT,
            diffuse=WINTER_DIFFUSE,
            doy=doy,
            season_name="winter_leaf_off"
        )
