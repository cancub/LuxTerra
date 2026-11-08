"""
Application-wide constants, geographic defaults, and verified benchmark presets for LuxTerra.
"""

# Default Quebec timezone for solar calculations and time-series indexing
DEFAULT_TIMEZONE = "America/Toronto"

# Preloaded test locations in Quebec
TEST_LOCATION_PRESETS = {
    "montreal": {
        "name": "Montréal - 2201 boul. Édouard-Montpetit",
        "filename": "dtm_montreal_edouard_montpetit.tif",
        "dsm_filename": "dsm_montreal_edouard_montpetit.tif",
        "center_lon": -73.618,
        "center_lat": 45.503,
        # ~2.5km x 2.5km coverage around Mount Royal flank
        "bbox": [-73.635, 45.492, -73.601, 45.514],
        "cog_url": "https://canelevation-dem.s3.ca-central-1.amazonaws.com/hrdem-lidar/QC-600023_52_CMM_2023-1m-dtm.tif",
        "dsm_cog_url": "https://canelevation-dem.s3.ca-central-1.amazonaws.com/hrdem-lidar/QC-600023_52_CMM_2023-1m-dsm.tif",
        "utm_crs": "EPSG:32618",
        "elevation_base": 125.0,
        "description": "Flank of Mount Royal with steep urban terrain gradient."
    },
    "sainte-lucie": {
        "name": "Sainte-Lucie-des-Laurentides - 2120 chemin du Golf",
        "filename": "dtm_sainte_lucie_laurentides.tif",
        "dsm_filename": "dsm_sainte_lucie_laurentides.tif",
        "center_lon": -74.195,
        "center_lat": 46.136,
        # ~2.5km x 2.5km coverage in Laurentians valley/mountain terrain
        "bbox": [-74.212, 46.124, -74.178, 46.148],
        "cog_url": "https://canelevation-dem.s3.ca-central-1.amazonaws.com/hrdem-lidar/QC-DIF_Grand_Montreal_2018-1m-dtm.tif",
        "dsm_cog_url": "https://canelevation-dem.s3.ca-central-1.amazonaws.com/hrdem-lidar/QC-DIF_Grand_Montreal_2018-1m-dsm.tif",
        "utm_crs": "EPSG:32618",
        "elevation_base": 440.0,
        "description": "Laurentian mountain ridge and valley topography with pronounced geological shadows."
    }
}
