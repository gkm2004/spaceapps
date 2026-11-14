Coordinates: degrees, planetocentric latitude, east-positive longitude.
Heights and distances in metres.

GET /api/sites
  -> [{ id, name, center: [lon, lat], bbox: [west, south, east, north] }]
     bbox = the zone where ground view is unlocked

GET /api/route?site=ID&start=LON,LAT&end=LON,LAT
  -> GeoJSON Feature, LineString of [lon, lat, height]
     properties: { distance_m, ascent_m, est_minutes, max_slope_deg,
                   profile: [[dist_m, height_m], ...] }

GET /api/waypoints?site=ID
  -> GeoJSON FeatureCollection of Points
     properties: { sol, images: [{ thumb_url, full_url, camera }] }

GET /tiles/{site}/danger/{z}/{x}/{y}.png
  -> transparent PNG tiles: green < 10 deg slope, yellow 10-20, red > 20
