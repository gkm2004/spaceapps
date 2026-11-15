"""Rover waypoints with photos, as the static JSON that /api/waypoints serves.

1. Downloads the rover's waypoints GeoJSON from NASA's mission map.
2. Keeps the waypoints inside the site bbox.
3. For each one, picks 3-6 Navcam/Mastcam images from NASA's raw image feed.
   Images are matched by sol. Where the feed records the rover's position
   counters (site/drive, NASA's "RMC": Perseverance does, Curiosity doesn't),
   images taken at the waypoint's exact position are preferred, and other
   images from that sol only fill up to the minimum of 3.

Writes data/waypoints/{site}.json (small, safe to commit). Raw NASA responses
are cached in data/raw/waypoints/ (ignored by git), so reruns are offline.

4. Adds `pov`: the left-Navcam frames taken at that stop, each with the compass
   direction it faces, for the street-view style viewer. Directions come from
   each frame's camera axis (rover frame) rotated by the rover's attitude
   quaternion into the local north/east/down frame.

Output per CONTRACT.md: FeatureCollection of Points [lon, lat, height],
properties { sol, images: [{ thumb_url, full_url, camera }],
             pov: [{ url, az, el, hfov, vfov }] }.

Usage (from the repo root):
    python data/scripts/waypoints.py --site jezero
    python data/scripts/waypoints.py --site gale
    python data/scripts/waypoints.py --site jezero --bbox 77.42,18.42,77.48,18.47
"""

import argparse
import json
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]
PROCESSED = REPO / "data" / "processed"
CACHE = REPO / "data" / "raw" / "waypoints"

# One rover per site. The two missions publish the same kind of feed with different
# camera names, image sizes and amounts of metadata; everything that differs is here.
ROVERS = {
    "jezero": {
        "rover": "Perseverance",
        "waypoints": "https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json",
        "category": "mars2020",
        "cameras": ["NAVCAM_LEFT", "NAVCAM_RIGHT", "MCZ_LEFT", "MCZ_RIGHT"],
        "thumb": "small",   # 320 px wide JPG
        "full": "large",    # 1200 px wide JPG (full_res PNGs are tens of MB)
        # Navcam full-colour frames and Mastcam-Z's RGB filter (not its 7 narrowband ones)
        "is_colour": lambda img: img["imageid"][:3] in ("NLF", "NRF", "ZL0", "ZR0"),
        "is_pov": lambda img: img["imageid"].startswith("NLF"),  # left Navcam, colour
        # Navcam: 5120 x 3840 px sensor, 96 x 73 degree field of view. Frames arrive as the
        # whole sensor downsampled, or as tiles (usually quarter-sensor), so each frame's
        # field of view follows from how much of the sensor it covers.
        "sensor_px": (5120, 3840),
        "fov_deg": (96.0, 73.0),
        "has_rmc": True,    # images carry site/drive, so they can be tied to an exact stop
    },
    "gale": {
        "rover": "Curiosity",
        "waypoints": "https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json",
        "category": "msl",
        # Navcam A until the computer swap around sol 200, B after it
        "cameras": ["NAV_LEFT_A", "NAV_LEFT_B", "NAV_RIGHT_A", "NAV_RIGHT_B", "MAST_LEFT", "MAST_RIGHT"],
        "thumb": "medium",  # ~145 KB JPG ("small" is a 10 KB thumbnail, too coarse for the panel)
        "full": "large",    # ~550 KB JPG
        "is_colour": lambda img: img["camera"]["instrument"].startswith("MAST"),  # Navcam is greyscale
        "is_pov": lambda img: img["camera"]["instrument"] in ("NAV_LEFT_A", "NAV_LEFT_B"),
        "sensor_px": (1024, 1024),  # Navcam: 45 x 45 degrees, always the whole frame
        "fov_deg": (45.0, 45.0),
        "has_rmc": False,   # site/drive are blank in this feed: match by sol only
    },
}
FEED = "https://mars.nasa.gov/rss/api/?feed=raw_images&feedtype=json&ver=1.2"
MIN_IMAGES, MAX_IMAGES = 3, 6
MIN_SIDE_PX = 600  # skip small sub-frames (sun checks, calibration-target crops)
POV_MAX_ELEVATION = 35.0  # frames centred higher are sky/Sun shots
USER_AGENT = "mars-map-hackathon/0.1 (python-urllib)"


def fetch_json(url: str, cache_file: Path, refresh: bool):
    if cache_file.exists() and not refresh:
        return json.loads(cache_file.read_text(encoding="utf-8"))
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                data = res.read()
            break
        except OSError:
            if attempt == 2:
                raise
            time.sleep(2 * (attempt + 1))
    parsed = json.loads(data)
    cache_file.parent.mkdir(parents=True, exist_ok=True)
    cache_file.write_bytes(data)
    return parsed


def site_bbox(site: str):
    """[west, south, east, north] of the site's grid (same maths as danger_tiles.py)."""
    from affine import Affine
    from pyproj import CRS, Transformer

    from crop_dem import geographic_helpers, wrap180

    meta = json.loads((PROCESSED / f"{site}_grid.json").read_text())
    t, (rows, cols) = Affine(*meta["transform"]), meta["shape"]
    crs = CRS.from_wkt(meta["crs_wkt"])
    geo, to_pc, _, lon_sign = geographic_helpers(crs)
    w, s, e, n = Transformer.from_crs(crs, geo, always_xy=True).transform_bounds(
        t.c, t.f + rows * t.e, t.c + cols * t.a, t.f, densify_pts=21)
    west, east = sorted(float(v) for v in wrap180([lon_sign * w, lon_sign * e]))
    return [west, float(to_pc(s)), east, float(to_pc(n))]


def https(url):
    """Curiosity's feed lists http:// links; an https page can't load those."""
    return url.replace("http://", "https://", 1)


def parse_tuple(text):
    return [float(v) for v in text.strip("()").split(",")]


def rotate(q, v):
    """Rotate vector v by unit quaternion q = (w, x, y, z)."""
    w, x, y, z = q
    u = np.array([x, y, z])
    return v + 2.0 * np.cross(u, np.cross(u, v) + w * v)


def direction(img):
    """(azimuth clockwise from north, elevation above the horizon) of the image centre, in
    degrees, or None when the feed has no pointing for this image.

    The camera axis comes in the rover's frame: Perseverance gives it directly, Curiosity
    as the "A" vector of its CAHVOR camera model. The rover's attitude quaternion turns it
    into the local north/east/down frame.
    """
    cam = img.get("camera", {})
    try:
        if cam.get("camera_vector"):
            v = np.array(parse_tuple(cam["camera_vector"]))
        else:
            v = np.array(parse_tuple(cam["camera_model_component_list"].split(";")[1]))
        q = parse_tuple(img["attitude"])
        if len(v) != 3 or len(q) != 4:
            return None
    except (KeyError, ValueError, AttributeError, IndexError):
        return None
    n, e, d = rotate(q, v / np.linalg.norm(v))
    return float(np.degrees(np.arctan2(e, n))) % 360.0, float(np.degrees(np.arcsin(-d)))


def is_full(img):
    return str(img.get("sample_type", "")).lower() == "full"


def usable(img, rover):
    if not is_full(img) or img["camera"]["instrument"] not in rover["cameras"]:
        return False
    dimension = (img.get("extended") or {}).get("dimension")
    if not dimension:
        return True  # Curiosity: no size given; "full" frames are whole images
    try:
        w, h = (int(v) for v in dimension.strip("()").split(","))
    except (ValueError, AttributeError):
        return False
    return min(w, h) >= MIN_SIDE_PX


def spread(images, n):
    """n images evenly spaced through the list (sorted by azimuth = around the horizon)."""
    if len(images) <= n:
        return images
    idx = np.unique(np.round(np.linspace(0, len(images) - 1, n)).astype(int))
    return [images[i] for i in idx]


def azimuth(img):
    """Where the mast pointed, for spreading picks around the horizon."""
    try:
        return float(img["extended"]["mastAz"])
    except (KeyError, TypeError, ValueError):
        d = direction(img)
        return d[0] if d else 0.0


def elevation(img):
    try:
        return float(img["extended"]["mastEl"])
    except (KeyError, TypeError, ValueError):
        d = direction(img)
        return d[1] if d else 0.0


def is_ground_view(img):
    """Camera pointed at the terrain or horizon, not the sky/Sun or straight down at the deck."""
    return -45.0 <= elevation(img) <= 10.0


def at_stop(img, rover, site_no, drive_no):
    """Was this image taken at this exact rover stop? Always true when the feed can't say."""
    if not rover["has_rmc"]:
        return True
    return str(img.get("site")) == str(site_no) and str(img.get("drive")) == str(drive_no)


def pick_images(sol_images, site_no, drive_no, rover):
    """3-6 images for one waypoint. Left eye only when possible (right is a stereo twin)."""
    ok = [i for i in sol_images if usable(i, rover)]
    # Best first: colour ground views; relax only if that leaves too few for this sol.
    for keep in (lambda i: rover["is_colour"](i) and is_ground_view(i), is_ground_view, lambda i: True):
        tier = [i for i in ok if keep(i)]
        if len(tier) >= MIN_IMAGES:
            break
    left = [i for i in tier if "LEFT" in i["camera"]["instrument"]]
    pool = sorted(left if len(left) >= MIN_IMAGES else tier, key=azimuth)
    here = [i for i in pool if at_stop(i, rover, site_no, drive_no)]
    chosen = spread(here, MAX_IMAGES)
    if len(chosen) < MIN_IMAGES:  # top up with other images from the same sol
        rest = [i for i in pool if i not in chosen]
        chosen = chosen + spread(rest, MIN_IMAGES - len(chosen))
    return [{
        "thumb_url": https(i["image_files"][rover["thumb"]]),
        "full_url": https(i["image_files"][rover["full"]]),
        "camera": i["camera"]["instrument"],
    } for i in chosen], len(here)


def pov_frames(sol_images, site_no, drive_no, rover):
    """Left-Navcam frames taken at this stop, each with the direction it faces.

    az: degrees clockwise from north, el: degrees above the horizon (centre of
    the frame); hfov/vfov: the frame's angular size in degrees.
    """
    sensor_w, sensor_h = rover["sensor_px"]
    frames = []
    for i in sol_images:
        if not (rover["is_pov"](i) and is_full(i) and at_stop(i, rover, site_no, drive_no)):
            continue
        facing = direction(i)
        if facing is None:
            continue
        try:  # x, y, w, h of the frame on the sensor; absent = the whole sensor
            sub = parse_tuple(i["extended"]["subframeRect"])
        except (KeyError, TypeError, ValueError, AttributeError):
            sub = [0, 0, sensor_w, sensor_h]
        az, el = facing
        if el > POV_MAX_ELEVATION or min(sub[2] / sensor_w, sub[3] / sensor_h) < 0.17:  # sky shots, thin strips
            continue
        frames.append({
            "url": https(i["image_files"][rover["full"]]),
            "az": round(az, 1),
            "el": round(el, 1),
            "hfov": round(rover["fov_deg"][0] * sub[2] / sensor_w, 1),
            "vfov": round(rover["fov_deg"][1] * sub[3] / sensor_h, 1),
            "_t": i.get("date_taken_utc", ""),
        })
    # The rover often re-shoots the same direction; keep the newest frame per direction.
    frames.sort(key=lambda f: f["_t"], reverse=True)
    kept = []
    for f in frames:
        if not any(abs((f["az"] - k["az"] + 180) % 360 - 180) < 3 and abs(f["el"] - k["el"]) < 3
                   and abs(f["hfov"] - k["hfov"]) < 1 for k in kept):
            kept.append(f)
    for f in kept:
        del f["_t"]
    # whole frames first (drawn underneath), then tiles; each group around the compass
    return sorted(kept, key=lambda f: (-f["hfov"], f["az"], f["el"]))


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--site", default="jezero")
    p.add_argument("--bbox", default=None, help="west,south,east,north; default: the site's grid bbox")
    p.add_argument("--refresh", action="store_true", help="re-download instead of using the cache")
    p.add_argument("--out", default=None, help="default: data/waypoints/{site}.json")
    args = p.parse_args()

    if args.site not in ROVERS:
        raise SystemExit(f"No rover configured for site {args.site!r} (known: {sorted(ROVERS)}).")
    rover = ROVERS[args.site]
    bbox = [float(v) for v in args.bbox.split(",")] if args.bbox else site_bbox(args.site)
    west, south, east, north = bbox

    wp = fetch_json(rover["waypoints"], CACHE / f"{args.site}_waypoints_source.json", args.refresh)
    inside = [f for f in wp["features"]
              if west <= f["properties"]["lon"] <= east and south <= f["properties"]["lat"] <= north]
    sols = sorted({int(f["properties"]["sol"]) for f in inside})
    print(f"rover:     {rover['rover']}")
    print(f"waypoints: {len(wp['features'])} from NASA, {len(inside)} inside bbox {[round(v, 6) for v in bbox]}")
    print(f"sols:      {len(sols)} distinct ({sols[0]}..{sols[-1]}); fetching the raw image feed for each")

    search = urllib.parse.quote("|" + "|".join(rover["cameras"]))

    def sol_images(sol):
        url = f"{FEED}&category={rover['category']}&sol={sol}&search={search}"
        return sol, fetch_json(url, CACHE / f"{args.site}_sol_{sol:05d}.json", args.refresh).get("images", [])

    with ThreadPoolExecutor(max_workers=4) as pool:  # be gentle with NASA's server
        by_sol = dict(pool.map(sol_images, sols))

    features, counts, exact = [], [], 0
    for f in sorted(inside, key=lambda f: (f["properties"]["sol"], f["properties"]["drive"])):
        pr = f["properties"]
        images, n_here = pick_images(by_sol[int(pr["sol"])], pr["site"], pr["drive"], rover)
        exact += n_here >= MIN_IMAGES
        counts.append(len(images))
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point",
                         "coordinates": [round(pr["lon"], 7), round(pr["lat"], 7), round(pr["elev_geoid"], 2)]},
            "properties": {"sol": int(pr["sol"]), "images": images,
                           "pov": pov_frames(by_sol[int(pr["sol"])], pr["site"], pr["drive"], rover)},
        })

    out = Path(args.out) if args.out else REPO / "data" / "waypoints" / f"{args.site}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"type": "FeatureCollection", "features": features}, indent=1), encoding="utf-8")

    c = np.array(counts)
    print(f"images:    {int((c >= MIN_IMAGES).sum())} waypoints with {MIN_IMAGES}-{MAX_IMAGES} images, "
          f"{int(((c > 0) & (c < MIN_IMAGES)).sum())} with 1-2, {int((c == 0).sum())} with none "
          f"(NASA has no full Navcam/Mastcam-Z frames for that sol)")
    if rover["has_rmc"]:
        print(f"matching:  {exact} waypoints used only images taken at that exact stop; "
              f"the rest were topped up from the same sol")
    else:
        print("matching:  by sol only (this rover's feed doesn't record where each image was taken)")
    npov = np.array([len(f["properties"]["pov"]) for f in features])
    turn = []
    for f in features:
        seen = np.zeros(360, bool)
        for v in f["properties"]["pov"]:
            half = v["hfov"] / 2 / max(np.cos(np.radians(v["el"])), 0.5)
            seen[np.arange(int(v["az"] - half), int(v["az"] + half) + 1) % 360] = True
        turn.append(seen.sum())
    turn = np.array(turn)
    median = int(np.median(npov[npov > 0])) if (npov > 0).any() else 0
    print(f"pov:       {int((npov > 0).sum())} waypoints have street-view frames (median {median} "
          f"frames); full 360 at {int((turn >= 358).sum())}, at least 180 at {int((turn >= 180).sum())}")
    print(f"wrote:     {out}  ({out.stat().st_size / 1024:.0f} KB, {len(features)} waypoints, {int(c.sum())} images)")


if __name__ == "__main__":
    main()
