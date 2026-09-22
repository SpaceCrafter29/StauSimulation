/*
 * Client-seitiger OSM-Import - Portierung von backend/app/osm.py.
 * Ruft Nominatim/Overpass direkt aus dem Browser auf (beide unterstützen
 * CORS für einzelne, nicht-automatisierte Anfragen), damit die Seite ohne
 * eigenen Server läuft. Browser dürfen aus Sicherheitsgründen keinen eigenen
 * User-Agent-Header setzen; der automatisch mitgesendete Referer genügt für
 * die Nutzungsrichtlinien von Nominatim/Overpass bei diesem Nutzungsumfang.
 */

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];

const HIGHWAY_DEFAULTS = {
  motorway: { speed: 110, lanes: 3 },
  motorway_link: { speed: 60, lanes: 1 },
  trunk: { speed: 90, lanes: 2 },
  trunk_link: { speed: 50, lanes: 1 },
  primary: { speed: 70, lanes: 2 },
  primary_link: { speed: 40, lanes: 1 },
  secondary: { speed: 50, lanes: 1 },
  tertiary: { speed: 50, lanes: 1 },
};

const MAX_BBOX_SPAN_DEG = 0.4;

async function geocodeCity(cityName) {
  const url = `${NOMINATIM_URL}?city=${encodeURIComponent(cityName)}&format=json&limit=1`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Nominatim-Fehler (${resp.status})`);
  const results = await resp.json();
  if (!results.length) throw new Error(`Stadt '${cityName}' wurde nicht gefunden.`);
  const r = results[0];
  const [south, north, west, east] = r.boundingbox.map(Number);
  return { south, north, west, east };
}

function clampBbox(bbox, maxSpan = MAX_BBOX_SPAN_DEG) {
  let clamped = false;
  let { south, north, west, east } = bbox;
  if (north - south > maxSpan) {
    const center = (north + south) / 2;
    south = center - maxSpan / 2;
    north = center + maxSpan / 2;
    clamped = true;
  }
  if (east - west > maxSpan) {
    const center = (east + west) / 2;
    west = center - maxSpan / 2;
    east = center + maxSpan / 2;
    clamped = true;
  }
  return [{ south, north, west, east }, clamped];
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function parseMaxspeed(value) {
  if (!value) return null;
  value = value.trim();
  if (/^\d+(\.\d+)?$/.test(value)) return parseFloat(value);
  if (value.includes("mph")) {
    const m = parseFloat(value.replace("mph", "").trim());
    return isNaN(m) ? null : m * 1.60934;
  }
  return null; // implizite Werte wie "DE:urban" -> Fallback auf highway-Default
}

function parseLanes(value) {
  if (!value) return null;
  const n = parseInt(value, 10);
  return isNaN(n) ? null : Math.max(1, n);
}

async function fetchOverpassWays(bbox) {
  const highwayFilter = Object.keys(HIGHWAY_DEFAULTS).join("|");
  const query = `[out:json][timeout:50];\nway["highway"~"^(${highwayFilter})$"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});\nout geom;`;
  let lastError = null;
  for (const url of OVERPASS_URLS) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (!resp.ok) throw new Error(`Overpass-Fehler (${resp.status})`);
      const data = await resp.json();
      return data.elements || [];
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    "Die OpenStreetMap-Server sind gerade überlastet oder nicht erreichbar. Bitte in ein paar Minuten nochmal versuchen."
  );
}

function parseWaysToNetwork(elements) {
  const nodes = {}; // id -> [lat, lon]
  const edges = [];
  let edgeCounter = 0;

  elements.forEach((el) => {
    if (el.type !== "way") return;
    const tags = el.tags || {};
    const highway = tags.highway;
    const defaults = HIGHWAY_DEFAULTS[highway] || { speed: 50, lanes: 1 };
    const speed = parseMaxspeed(tags.maxspeed) || defaults.speed;
    const lanes = parseLanes(tags.lanes) || defaults.lanes;
    const name = tags.name || null;
    const geometry = el.geometry || [];

    const wayNodeIds = geometry.map((pt) => {
      const nid = `${pt.lat.toFixed(6)}_${pt.lon.toFixed(6)}`;
      nodes[nid] = [pt.lat, pt.lon];
      return nid;
    });

    for (let i = 0; i < wayNodeIds.length - 1; i++) {
      const a = wayNodeIds[i];
      const b = wayNodeIds[i + 1];
      if (a === b) continue;
      const [lat1, lon1] = nodes[a];
      const [lat2, lon2] = nodes[b];
      const length = haversineKm(lat1, lon1, lat2, lon2);
      if (length <= 0) continue;
      edgeCounter++;
      edges.push({ id: `e${edgeCounter}`, from: a, to: b, length_km: length, speed_kmh: speed, lanes, name });
    }
  });

  const nodeList = Object.entries(nodes).map(([id, [lat, lon]]) => ({ id, lat, lon, signal: null }));
  return { nodes: nodeList, edges };
}

/* Kontrahiert Ketten von reinen Geometriepunkten (Grad-2-Knoten mit
 * identischen Straßeneigenschaften) zu einer Kante - siehe backend/app/osm.py
 * für die ausführliche Erklärung. Reduziert z.B. Konstanz von ~4700 auf ~580
 * Knoten, ohne die Topologie oder Streckenlänge zu verändern. */
function simplifyNetwork(nodes, edges) {
  const edgesById = {};
  edges.forEach((e) => (edgesById[e.id] = { ...e }));
  const adjacency = {};
  Object.values(edgesById).forEach((e) => {
    (adjacency[e.from] = adjacency[e.from] || new Set()).add(e.id);
    (adjacency[e.to] = adjacency[e.to] || new Set()).add(e.id);
  });

  const otherEnd = (edge, nodeId) => (edge.from === nodeId ? edge.to : edge.from);
  const compatible = (e1, e2) => e1.speed_kmh === e2.speed_kmh && e1.lanes === e2.lanes && e1.name === e2.name;

  const queue = Object.keys(adjacency).filter((nid) => adjacency[nid].size === 2);
  const removedNodes = new Set();

  while (queue.length) {
    const nid = queue.shift();
    if (removedNodes.has(nid) || !adjacency[nid] || adjacency[nid].size !== 2) continue;
    const [eid1, eid2] = [...adjacency[nid]];
    if (eid1 === eid2 || !edgesById[eid1] || !edgesById[eid2]) continue;
    const e1 = edgesById[eid1];
    const e2 = edgesById[eid2];
    if (!compatible(e1, e2)) continue;
    const n1 = otherEnd(e1, nid);
    const n2 = otherEnd(e2, nid);
    if (n1 === n2 || n1 === nid || n2 === nid) continue;

    const merged = {
      id: eid1,
      from: n1,
      to: n2,
      length_km: e1.length_km + e2.length_km,
      speed_kmh: e1.speed_kmh,
      lanes: e1.lanes,
      name: e1.name,
    };
    delete edgesById[eid1];
    delete edgesById[eid2];
    adjacency[n1].delete(eid1);
    adjacency[n1].delete(eid2);
    adjacency[n2].delete(eid1);
    adjacency[n2].delete(eid2);
    delete adjacency[nid];
    removedNodes.add(nid);

    edgesById[merged.id] = merged;
    adjacency[n1].add(merged.id);
    adjacency[n2].add(merged.id);

    [n1, n2].forEach((cand) => {
      if (adjacency[cand] && adjacency[cand].size === 2) queue.push(cand);
    });
  }

  const finalNodes = nodes.filter((n) => !removedNodes.has(n.id));
  const finalEdges = Object.values(edgesById);
  return [finalNodes, finalEdges];
}

async function fetchCityNetwork(cityName) {
  const bboxRaw = await geocodeCity(cityName);
  const [bbox, clamped] = clampBbox(bboxRaw);
  const elements = await fetchOverpassWays(bbox);
  const parsed = parseWaysToNetwork(elements);
  const [simplifiedNodes, simplifiedEdges] = simplifyNetwork(parsed.nodes, parsed.edges);
  const network = { nodes: simplifiedNodes, edges: simplifiedEdges };

  let note = null;
  if (clamped) note = "Das Gebiet wurde auf ca. 40 km Kantenlänge begrenzt (nur Hauptstraßen, sonst zu viele Daten).";
  if (!network.edges.length) note = "Keine Hauptstraßen (motorway/trunk/primary/secondary) in diesem Gebiet gefunden.";
  return { network, note };
}
