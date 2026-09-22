/*
 * Gemeinsame Logik für builder.html und city.html.
 * Unterschied zwischen den Modi wird über `MODE` gesteuert ('builder' | 'city'),
 * das jede Seite vor dem Einbinden dieser Datei per <script> setzt.
 */

const API_BASE = "";

let map;
let nodeLayer, edgeLayer;
let network = { nodes: [], edges: [] };
let demand = [];
let closedEdges = new Set();
let nodeCounter = 0;
let edgeCounter = 0;
let demandCounter = 0;
let currentTool = "node"; // 'node' | 'edge' | 'demand' | 'close'
let pendingNodeId = null; // für den zwei-Klicks-Fluss bei 'edge' und 'demand'
let lastResult = null;
let edgeLinesById = {};
let nodeMarkersById = {};

function initMap() {
  map = L.map("map").setView([51.1657, 10.4515], 6);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap-Mitwirkende",
    maxZoom: 19,
  }).addTo(map);
  nodeLayer = L.layerGroup().addTo(map);
  edgeLayer = L.layerGroup().addTo(map);

  if (MODE === "builder") {
    map.on("click", (e) => {
      if (currentTool === "node") {
        addNode(e.latlng.lat, e.latlng.lng);
      }
    });
  }
}

function setTool(tool) {
  currentTool = tool;
  pendingNodeId = null;
  document.querySelectorAll("[data-tool]").forEach((el) => {
    el.classList.toggle("active-tool", el.dataset.tool === tool);
  });
  clearPendingHighlight();
}

function clearPendingHighlight() {
  Object.values(nodeMarkersById).forEach((m) => m.setStyle({ weight: 2 }));
}

function addNode(lat, lon) {
  const id = `n${++nodeCounter}`;
  network.nodes.push({ id, lat, lon });
  drawNode({ id, lat, lon });
  return id;
}

function drawNode(node) {
  const marker = L.circleMarker([node.lat, node.lon], {
    radius: 6,
    color: "#4f8cff",
    fillColor: "#4f8cff",
    fillOpacity: 0.9,
    weight: 2,
  }).addTo(nodeLayer);
  marker.on("click", (e) => {
    L.DomEvent.stopPropagation(e);
    onNodeClick(node.id);
  });
  nodeMarkersById[node.id] = marker;
}

function onNodeClick(nodeId) {
  if (currentTool === "edge") {
    handleTwoClickFlow(nodeId, onEdgePairSelected);
  } else if (currentTool === "demand") {
    handleTwoClickFlow(nodeId, onDemandPairSelected);
  }
}

function handleTwoClickFlow(nodeId, onComplete) {
  if (pendingNodeId === null) {
    pendingNodeId = nodeId;
    nodeMarkersById[nodeId].setStyle({ weight: 5, color: "#e0b93d" });
  } else if (pendingNodeId === nodeId) {
    // gleicher Knoten nochmal geklickt -> Auswahl aufheben
    clearPendingHighlight();
    pendingNodeId = null;
  } else {
    const a = pendingNodeId;
    clearPendingHighlight();
    pendingNodeId = null;
    onComplete(a, nodeId);
  }
}

function onEdgePairSelected(aId, bId) {
  const speedStr = prompt("Tempolimit (km/h)?", "50");
  if (speedStr === null) return;
  const lanesStr = prompt("Fahrstreifen (pro Richtung)?", "1");
  if (lanesStr === null) return;
  const speed = parseFloat(speedStr) || 50;
  const lanes = parseInt(lanesStr, 10) || 1;
  const id = `e${++edgeCounter}`;
  const nodeA = network.nodes.find((n) => n.id === aId);
  const nodeB = network.nodes.find((n) => n.id === bId);
  const length_km = haversineKm(nodeA.lat, nodeA.lon, nodeB.lat, nodeB.lon);
  const edge = { id, from: aId, to: bId, length_km, speed_kmh: speed, lanes, name: null };
  network.edges.push(edge);
  drawEdge(edge);
  renderEdgeList();
}

function onDemandPairSelected(aId, bId) {
  const vphStr = prompt("Fahrzeuge pro Stunde auf dieser Route?", "300");
  if (vphStr === null) return;
  const vph = parseFloat(vphStr) || 0;
  if (vph <= 0) return;
  demand.push({ id: `d${++demandCounter}`, from: aId, to: bId, vehicles_per_hour: vph });
  renderDemandList();
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function edgeColor(edgeId) {
  if (closedEdges.has(edgeId)) return "#555f6b";
  if (!lastResult) return "#4f8cff";
  const r = lastResult.with_closure.edges.find((e) => e.id === edgeId);
  if (!r || r.vc_ratio === null || r.vc_ratio === undefined) return "#4f8cff";
  const vc = r.vc_ratio;
  if (vc < 0.6) return "#3ecf8e";
  if (vc < 0.85) return "#e0b93d";
  if (vc < 1.0) return "#e08a3d";
  return "#e0543d";
}

function drawEdge(edge) {
  const nodeA = network.nodes.find((n) => n.id === edge.from);
  const nodeB = network.nodes.find((n) => n.id === edge.to);
  if (!nodeA || !nodeB) return;
  const line = L.polyline(
    [
      [nodeA.lat, nodeA.lon],
      [nodeB.lat, nodeB.lon],
    ],
    {
      color: edgeColor(edge.id),
      weight: 4,
      dashArray: closedEdges.has(edge.id) ? "6 6" : null,
    }
  ).addTo(edgeLayer);
  line.bindTooltip(edgeTooltip(edge), { sticky: true });
  line.on("click", (e) => {
    L.DomEvent.stopPropagation(e);
    if (currentTool === "close") {
      toggleClosed(edge.id);
    }
  });
  edgeLinesById[edge.id] = line;
}

function edgeTooltip(edge) {
  const name = edge.name ? `${edge.name} ` : "";
  return `${name}(${edge.length_km.toFixed(2)} km, ${edge.speed_kmh} km/h, ${edge.lanes} Spur(en))`;
}

function redrawAll() {
  nodeLayer.clearLayers();
  edgeLayer.clearLayers();
  nodeMarkersById = {};
  edgeLinesById = {};
  network.nodes.forEach(drawNode);
  network.edges.forEach(drawEdge);
}

function toggleClosed(edgeId) {
  if (closedEdges.has(edgeId)) closedEdges.delete(edgeId);
  else closedEdges.add(edgeId);
  renderEdgeList();
  const line = edgeLinesById[edgeId];
  if (line) {
    line.setStyle({ color: edgeColor(edgeId), dashArray: closedEdges.has(edgeId) ? "6 6" : null });
  }
}

function deleteEdge(edgeId) {
  network.edges = network.edges.filter((e) => e.id !== edgeId);
  closedEdges.delete(edgeId);
  if (edgeLinesById[edgeId]) {
    edgeLayer.removeLayer(edgeLinesById[edgeId]);
    delete edgeLinesById[edgeId];
  }
  renderEdgeList();
}

function deleteDemand(demandId) {
  demand = demand.filter((d) => d.id !== demandId);
  renderDemandList();
}

function renderEdgeList() {
  const el = document.getElementById("edgeList");
  if (!network.edges.length) {
    el.innerHTML = '<p class="empty-note">Noch keine Straßen vorhanden.</p>';
    return;
  }
  const rows = network.edges
    .map((e) => {
      const checked = closedEdges.has(e.id) ? "checked" : "";
      const label = e.name || `${e.from} → ${e.to}`;
      return `<tr>
        <td>${label}<br><span class="empty-note">${e.length_km.toFixed(2)} km · ${e.speed_kmh} km/h · ${e.lanes} Spur(en)</span></td>
        <td style="text-align:center"><input type="checkbox" ${checked} onchange="toggleClosed('${e.id}')" title="gesperrt"></td>
        <td><button class="small secondary" onclick="deleteEdge('${e.id}')">✕</button></td>
      </tr>`;
    })
    .join("");
  el.innerHTML = `<table class="list-table">
    <tr><th>Straße</th><th>gesperrt</th><th></th></tr>${rows}
  </table>`;
}

function renderDemandList() {
  const el = document.getElementById("demandList");
  if (!demand.length) {
    el.innerHTML = '<p class="empty-note">Noch keine Routen/Nachfrage vorhanden.</p>';
    return;
  }
  const rows = demand
    .map(
      (d) => `<tr>
        <td>${d.from} → ${d.to}</td>
        <td>${d.vehicles_per_hour} Fz/h</td>
        <td><button class="small secondary" onclick="deleteDemand('${d.id}')">✕</button></td>
      </tr>`
    )
    .join("");
  el.innerHTML = `<table class="list-table">
    <tr><th>Route</th><th>Nachfrage</th><th></th></tr>${rows}
  </table>`;
}

function networkToApiFormat() {
  return {
    nodes: network.nodes.map((n) => ({ id: n.id, lat: n.lat, lon: n.lon })),
    edges: network.edges.map((e) => ({
      id: e.id,
      from: e.from,
      to: e.to,
      length_km: e.length_km,
      speed_kmh: e.speed_kmh,
      lanes: e.lanes,
      name: e.name || null,
    })),
  };
}

function demandToApiFormat() {
  return demand.map((d) => ({ from: d.from, to: d.to, vehicles_per_hour: d.vehicles_per_hour }));
}

async function runComparison() {
  if (network.nodes.length === 0) {
    alert("Es ist noch kein Straßennetz vorhanden.");
    return;
  }
  if (demand.length === 0) {
    alert("Bitte mindestens eine Route (Nachfrage) hinzufügen, bevor simuliert wird.");
    return;
  }
  const btn = document.getElementById("simulateBtn");
  btn.disabled = true;
  btn.textContent = "Simuliere...";
  try {
    const resp = await fetch(`${API_BASE}/api/simulate/compare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        network: networkToApiFormat(),
        demand: demandToApiFormat(),
        closed_edges: Array.from(closedEdges),
      }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.detail || `Serverfehler (${resp.status})`);
    }
    lastResult = await resp.json();
    renderResults(lastResult);
    network.edges.forEach((e) => {
      const line = edgeLinesById[e.id];
      if (line) line.setStyle({ color: edgeColor(e.id) });
    });
  } catch (err) {
    alert(`Simulation fehlgeschlagen: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Simulation starten";
  }
}

function fmtMin(v) {
  if (v === null || v === undefined) return "nicht erreichbar";
  return `${v.toFixed(1)} min`;
}

function renderResults(result) {
  const el = document.getElementById("results");
  const delta = result.delta_total_vehicle_minutes;

  // Wird eine Route durch die Sperrung komplett unerreichbar, sinkt die
  // Gesamt-Fahrzeug-Minuten-Summe scheinbar (weil diese Fahrzeuge gar nicht mehr
  // fließen) - das sähe fälschlich wie eine "Verbesserung" aus. Deshalb hier
  // explizit prüfen und in diesem Fall nie als "besser" (grün) anzeigen.
  const newlyUnreachable = result.with_closure.od_results.filter(
    (odAfter, i) => odAfter.travel_time_min === null && result.baseline.od_results[i].travel_time_min !== null
  ).length;
  const deltaClass = newlyUnreachable > 0 || delta > 0.01 ? "delta-worse" : delta < -0.01 ? "delta-better" : "";
  const deltaSign = delta > 0 ? "+" : "";
  const unreachableWarning =
    newlyUnreachable > 0
      ? `<p class="hint" style="color:var(--red)">⚠ ${newlyUnreachable} Route(n) sind nach der Sperrung nicht mehr erreichbar. Die Gesamtsumme ist dadurch nicht direkt vergleichbar (nicht fließende Fahrzeuge zählen nicht mehr mit).</p>`
      : "";

  const odRows = result.baseline.od_results
    .map((odBefore, i) => {
      const odAfter = result.with_closure.od_results[i];
      const before = odBefore.travel_time_min;
      const after = odAfter.travel_time_min;
      let deltaCell = "–";
      if (before !== null && after !== null) {
        const d = after - before;
        const cls = d > 0.01 ? "delta-worse" : d < -0.01 ? "delta-better" : "";
        deltaCell = `<span class="${cls}">${d > 0 ? "+" : ""}${d.toFixed(1)} min</span>`;
      } else if (after === null) {
        deltaCell = '<span class="delta-worse">nicht mehr erreichbar</span>';
      }
      return `<tr>
        <td>${odBefore.from} → ${odBefore.to}</td>
        <td>${fmtMin(before)}</td>
        <td>${fmtMin(after)}</td>
        <td>${deltaCell}</td>
      </tr>`;
    })
    .join("");

  el.innerHTML = `
    <div class="result-box">
      <strong>Gesamtbelastung im Netz</strong> (Summe Fahrzeug-Minuten, Standardmaß für Netzauslastung)<br>
      vorher: ${result.baseline.total_vehicle_minutes.toFixed(0)} &nbsp;→&nbsp;
      nachher: ${result.with_closure.total_vehicle_minutes.toFixed(0)}
      (<span class="${deltaClass}">${deltaSign}${delta.toFixed(0)}</span>)
    </div>
    ${unreachableWarning}
    <table class="list-table" style="margin-top:10px">
      <tr><th>Route</th><th>vorher</th><th>nachher</th><th>Δ</th></tr>
      ${odRows}
    </table>
  `;
}
