"""
Import eines realen Straßennetzes (Hauptstraßen) einer Stadt über OpenStreetMap.

Ablauf:
1. Nominatim: Stadtname -> Bounding Box (geografischer Suchbereich)
2. Overpass API: alle Straßen mit highway=motorway/trunk/primary/secondary etc.
   innerhalb dieser Box abfragen
3. Aus den Straßen (OSM "ways") einen Graphen bauen: jeder Punkt entlang einer
   Straße wird zu einem Knoten, aufeinanderfolgende Punkte zu einer Kante.
   Wo sich zwei Straßen an denselben Koordinaten treffen, entsteht dadurch
   automatisch eine gemeinsame Kreuzung im Graphen.
"""

import math
from typing import Optional, Tuple

import requests

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
USER_AGENT = "StauSimulation-JugendForscht/0.1 (+https://github.com/SpaceCrafter29/StauSimulation)"

# Nur "Hauptstraßen" laden (siehe Anforderung), keine Wohnstraßen/Feldwege -
# hält den Graphen klein genug für eine Simulation im Browser.
HIGHWAY_DEFAULTS = {
    "motorway": {"speed": 110, "lanes": 3},
    "motorway_link": {"speed": 60, "lanes": 1},
    "trunk": {"speed": 90, "lanes": 2},
    "trunk_link": {"speed": 50, "lanes": 1},
    "primary": {"speed": 70, "lanes": 2},
    "primary_link": {"speed": 40, "lanes": 1},
    "secondary": {"speed": 50, "lanes": 1},
    "tertiary": {"speed": 50, "lanes": 1},
}

MAX_BBOX_SPAN_DEG = 0.4  # ~ 40-45 km; verhindert riesige Overpass-Anfragen bei z.B. "Bayern"


class CityNotFoundError(Exception):
    pass


def _geocode_city(city_name: str) -> dict:
    resp = requests.get(
        NOMINATIM_URL,
        params={"city": city_name, "format": "json", "limit": 1},
        headers={"User-Agent": USER_AGENT},
        timeout=10,
    )
    resp.raise_for_status()
    results = resp.json()
    if not results:
        raise CityNotFoundError(f"Stadt '{city_name}' wurde nicht gefunden.")
    r = results[0]
    south, north, west, east = (float(x) for x in r["boundingbox"])
    return {"south": south, "north": north, "west": west, "east": east}


def _clamp_bbox(bbox: dict, max_span: float = MAX_BBOX_SPAN_DEG) -> Tuple[dict, bool]:
    clamped = False
    lat_span = bbox["north"] - bbox["south"]
    if lat_span > max_span:
        center = (bbox["north"] + bbox["south"]) / 2
        bbox = {**bbox, "south": center - max_span / 2, "north": center + max_span / 2}
        clamped = True
    lon_span = bbox["east"] - bbox["west"]
    if lon_span > max_span:
        center = (bbox["east"] + bbox["west"]) / 2
        bbox = {**bbox, "west": center - max_span / 2, "east": center + max_span / 2}
        clamped = True
    return bbox, clamped


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _parse_maxspeed(value: Optional[str]) -> Optional[float]:
    if not value:
        return None
    value = value.strip()
    try:
        return float(value)
    except ValueError:
        pass
    if "mph" in value:
        try:
            return float(value.replace("mph", "").strip()) * 1.60934
        except ValueError:
            return None
    return None  # implizite Werte wie "DE:urban" -> Fallback auf highway-Default


def _parse_lanes(value: Optional[str]) -> Optional[int]:
    if not value:
        return None
    try:
        return max(1, int(value))
    except ValueError:
        return None


def _fetch_overpass_ways(bbox: dict) -> list:
    highway_filter = "|".join(HIGHWAY_DEFAULTS.keys())
    query = f"""
    [out:json][timeout:25];
    way["highway"~"^({highway_filter})$"]({bbox['south']},{bbox['west']},{bbox['north']},{bbox['east']});
    out geom;
    """
    resp = requests.post(OVERPASS_URL, data={"data": query}, headers={"User-Agent": USER_AGENT}, timeout=30)
    resp.raise_for_status()
    return resp.json().get("elements", [])


def _parse_ways_to_network(elements: list) -> dict:
    nodes: dict = {}  # node_id -> (lat, lon)
    edges = []
    edge_counter = 0

    for el in elements:
        if el.get("type") != "way":
            continue
        tags = el.get("tags", {})
        highway = tags.get("highway")
        defaults = HIGHWAY_DEFAULTS.get(highway, {"speed": 50, "lanes": 1})
        speed = _parse_maxspeed(tags.get("maxspeed")) or defaults["speed"]
        lanes = _parse_lanes(tags.get("lanes")) or defaults["lanes"]
        name = tags.get("name")
        geometry = el.get("geometry") or []

        # Koordinaten auf ~11cm gerundet als Knoten-ID: zwei Straßen, die sich am
        # selben Punkt treffen, bekommen so automatisch denselben Knoten (= Kreuzung).
        way_node_ids = []
        for pt in geometry:
            nid = f"{pt['lat']:.6f}_{pt['lon']:.6f}"
            nodes[nid] = (pt["lat"], pt["lon"])
            way_node_ids.append(nid)

        for i in range(len(way_node_ids) - 1):
            a, b = way_node_ids[i], way_node_ids[i + 1]
            if a == b:
                continue
            lat1, lon1 = nodes[a]
            lat2, lon2 = nodes[b]
            length = _haversine_km(lat1, lon1, lat2, lon2)
            if length <= 0:
                continue
            edge_counter += 1
            edges.append(
                {
                    "id": f"e{edge_counter}",
                    "from": a,
                    "to": b,
                    "length_km": length,
                    "speed_kmh": speed,
                    "lanes": lanes,
                    "name": name,
                }
            )

    node_list = [{"id": nid, "lat": lat, "lon": lon} for nid, (lat, lon) in nodes.items()]
    return {"nodes": node_list, "edges": edges}


def fetch_city_network(city_name: str) -> dict:
    bbox = _geocode_city(city_name)
    bbox, clamped = _clamp_bbox(bbox)
    elements = _fetch_overpass_ways(bbox)
    network = _parse_ways_to_network(elements)
    note = None
    if clamped:
        note = "Das Gebiet wurde auf ca. 40 km Kantenlänge begrenzt (nur Hauptstraßen, sonst zu viele Daten)."
    if not network["edges"]:
        note = "Keine Hauptstraßen (motorway/trunk/primary/secondary) in diesem Gebiet gefunden."
    return {"network": network, "note": note}
