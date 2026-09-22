/*
 * Gemeinsame Logik für builder.html und city.html.
 * Unterschied zwischen den Modi wird über `MODE` gesteuert ('builder' | 'city'),
 * das jede Seite vor dem Einbinden dieser Datei per <script> setzt.
 *
 * Im Builder-Modus ist die Karte ein leerer Canvas (Leaflet mit CRS.Simple,
 * keine echten Kacheln) - node.lat/node.lon sind dort also keine echten
 * Geo-Koordinaten, sondern nur eine ebene x/y-Zeichenfläche. Straßenlängen
 * werden deshalb im Builder direkt vom Nutzer eingegeben, nicht aus
 * Koordinaten berechnet.
 */

let map;
let nodeLayer, edgeLayer;
let network = { nodes: [], edges: [] };
let demand = [];
let closedEdges = new Set();
let nodeCounter = 0;
let edgeCounter = 0;
let demandCounter = 0;
let currentTool = "node"; // 'node' | 'edge' | 'demand' | 'close' | 'signal'
let pendingNodeId = null; // zwei-Klicks-Fluss bei 'demand'
let pendingEdgeStart = null; // zwei/mehr-Klicks-Fluss bei 'edge'
let pendingWaypoints = [];
let previewLine = null;
let lastResult = null;
let edgeLinesById = {};
let nodeMarkersById = {};
let carLayer;
let carMarkers = [];
let carAnimHandle = null;

function initMap() {
  if (MODE === "builder") {
    map = L.map("map", { crs: L.CRS.Simple, minZoom: -6, maxZoom: 8 }).setView([0, 0], 2);
    document.getElementById("map").classList.add("blank-canvas");
  } else {
    map = L.map("map").setView([51.1657, 10.4515], 6);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap-Mitwirkende",
      maxZoom: 19,
    }).addTo(map);
  }
  nodeLayer = L.layerGroup().addTo(map);
  edgeLayer = L.layerGroup().addTo(map);
  carLayer = L.layerGroup().addTo(map);
  map.on("click", (e) => onMapClick(e.latlng));

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") cancelPending();
  });
}

function setTool(tool) {
  currentTool = tool;
  cancelPending();
  document.querySelectorAll("[data-tool]").forEach((el) => {
    el.classList.toggle("active-tool", el.dataset.tool === tool);
  });
}

function cancelPending() {
  // Reihenfolge wichtig: erst die pending-IDs zurücksetzen, DANN neu zeichnen -
  // sonst hält redrawNodeStyle() den gerade abgewählten Knoten für "noch
  // pending" und malt ihn wieder grün an, statt ihn zurückzusetzen.
  pendingNodeId = null;
  pendingEdgeStart = null;
  pendingWaypoints = [];
  clearPendingHighlight();
  if (previewLine) {
    edgeLayer.removeLayer(previewLine);
    previewLine = null;
  }
}

function clearPendingHighlight() {
  network.nodes.forEach((n) => redrawNodeStyle(n.id));
}

function onMapClick(latlng) {
  if (currentTool === "node" && MODE === "builder") {
    addNode(latlng.lat, latlng.lng);
  } else if (currentTool === "edge" && pendingEdgeStart !== null) {
    // Klick auf leere Fläche während eine Straße gezogen wird -> Kurvenpunkt
    // (z.B. für eine Ausfahrt/Rampe, die nicht schnurgerade ist)
    pendingWaypoints.push([latlng.lat, latlng.lng]);
    updatePreviewLine();
  }
}

function addNode(lat, lon) {
  const id = `n${++nodeCounter}`;
  network.nodes.push({ id, lat, lon, signal: null });
  drawNode({ id, lat, lon, signal: null });
  return id;
}

function nodeMarkerStyle(node) {
  if (node.signal) {
    return { radius: 7, color: "#e0b93d", fillColor: "#e0b93d", fillOpacity: 0.95, weight: 3, className: "node-signal" };
  }
  return { radius: 6, color: "#4f8cff", fillColor: "#4f8cff", fillOpacity: 0.9, weight: 2 };
}

function drawNode(node) {
  const marker = L.circleMarker([node.lat, node.lon], nodeMarkerStyle(node)).addTo(nodeLayer);
  marker.on("click", (e) => {
    L.DomEvent.stopPropagation(e);
    onNodeClick(node.id);
  });
  nodeMarkersById[node.id] = marker;
}

function redrawNodeStyle(nodeId) {
  const node = network.nodes.find((n) => n.id === nodeId);
  const marker = nodeMarkersById[nodeId];
  if (!node || !marker) return;
  const style = nodeMarkerStyle(node);
  if (nodeId === pendingEdgeStart || nodeId === pendingNodeId) {
    style.weight = 5;
    style.color = "#3ecf8e";
  }
  marker.setStyle(style);
}

function onNodeClick(nodeId) {
  if (currentTool === "edge") {
    if (pendingEdgeStart === null) {
      pendingEdgeStart = nodeId;
      pendingWaypoints = [];
      redrawNodeStyle(nodeId);
    } else if (pendingEdgeStart === nodeId) {
      cancelPending();
    } else {
      const startId = pendingEdgeStart;
      const waypoints = pendingWaypoints;
      cancelPending();
      finishEdge(startId, nodeId, waypoints);
    }
  } else if (currentTool === "demand") {
    handleTwoClickFlow(nodeId, onDemandPairSelected);
  } else if (currentTool === "signal") {
    openSignalModal(nodeId);
  }
}

function handleTwoClickFlow(nodeId, onComplete) {
  if (pendingNodeId === null) {
    pendingNodeId = nodeId;
    redrawNodeStyle(nodeId);
  } else if (pendingNodeId === nodeId) {
    cancelPending();
  } else {
    const a = pendingNodeId;
    cancelPending();
    onComplete(a, nodeId);
  }
}

function updatePreviewLine() {
  if (previewLine) {
    edgeLayer.removeLayer(previewLine);
    previewLine = null;
  }
  if (pendingEdgeStart === null) return;
  const startNode = network.nodes.find((n) => n.id === pendingEdgeStart);
  const points = [[startNode.lat, startNode.lon], ...pendingWaypoints];
  if (points.length < 2) return;
  previewLine = L.polyline(points, { color: "#3ecf8e", weight: 3, dashArray: "4 6" }).addTo(edgeLayer);
}

/* --- Generisches Modal (ersetzt native prompt()-Dialoge zuverlässig) --- */
function showModal(title, fields, onSubmit, hint) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const box = document.createElement("div");
  box.className = "modal-box";
  box.innerHTML = `<h3>${title}</h3>`;

  const inputs = {};
  fields.forEach((f) => {
    const label = document.createElement("label");
    label.textContent = f.label;
    box.appendChild(label);

    if (f.type === "select") {
      const select = document.createElement("select");
      f.options.forEach((opt) => {
        const optionEl = document.createElement("option");
        optionEl.value = opt.value;
        optionEl.textContent = opt.label;
        select.appendChild(optionEl);
      });
      select.value = f.value;
      select.addEventListener("change", () => {
        if (f.onChange) f.onChange(select.value, inputs);
      });
      box.appendChild(select);
      inputs[f.key] = select;
      return;
    }

    const input = document.createElement("input");
    input.type = f.type === "checkbox" ? "checkbox" : f.type === "text" ? "text" : "number";
    if (f.type === "checkbox") {
      input.checked = !!f.value;
    } else {
      input.value = f.value ?? "";
      if (f.step !== undefined) input.step = f.step;
    }
    box.appendChild(input);
    inputs[f.key] = input;
  });

  if (hint) {
    const hintEl = document.createElement("p");
    hintEl.className = "modal-hint";
    hintEl.textContent = hint;
    box.appendChild(hintEl);
  }

  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "secondary";
  cancelBtn.textContent = "Abbrechen";
  const okBtn = document.createElement("button");
  okBtn.textContent = "OK";
  actions.appendChild(cancelBtn);
  actions.appendChild(okBtn);
  box.appendChild(actions);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  function close() {
    document.body.removeChild(overlay);
  }
  cancelBtn.onclick = close;
  overlay.onclick = (e) => {
    if (e.target === overlay) close();
  };
  okBtn.onclick = () => {
    const values = {};
    fields.forEach((f) => {
      const input = inputs[f.key];
      values[f.key] =
        f.type === "checkbox" ? input.checked : f.type === "text" || f.type === "select" ? input.value : parseFloat(input.value);
    });
    close();
    onSubmit(values);
  };

  const firstInput = box.querySelector("input, select");
  if (firstInput) firstInput.focus();
}

// "Lego"-Presets für typische Straßentypen - füllen Tempolimit/Fahrstreifen
// vor, bleiben aber danach frei editierbar (z.B. für eine langsamere Baustelle
// auf einer sonst normalen Autobahn).
const ROAD_PRESETS = {
  custom: { label: "Benutzerdefiniert", speed: 50, lanes: 1 },
  autobahn: { label: "Autobahn", speed: 130, lanes: 3 },
  landstrasse: { label: "Landstraße", speed: 100, lanes: 1 },
  bundesstrasse: { label: "Bundesstraße", speed: 70, lanes: 1 },
  stadtstrasse: { label: "Stadtstraße", speed: 50, lanes: 1 },
  wohnstrasse: { label: "Wohnstraße", speed: 30, lanes: 1 },
};

function finishEdge(aId, bId, waypoints) {
  showModal(
    "Straße anlegen",
    [
      {
        key: "preset",
        label: "Straßentyp",
        type: "select",
        value: "custom",
        options: Object.entries(ROAD_PRESETS).map(([value, p]) => ({ value, label: p.label })),
        onChange: (value, inputs) => {
          const preset = ROAD_PRESETS[value];
          if (preset && value !== "custom") {
            inputs.speed_kmh.value = preset.speed;
            inputs.lanes.value = preset.lanes;
          }
        },
      },
      { key: "length_km", label: "Länge (km)", value: 1, step: 0.1 },
      { key: "speed_kmh", label: "Tempolimit (km/h)", value: 50, step: 5 },
      { key: "lanes", label: "Fahrstreifen (pro Richtung)", value: 1, step: 1 },
      { key: "name", label: "Name (optional)", value: "", type: "text" },
    ],
    (values) => {
      const id = `e${++edgeCounter}`;
      const edge = {
        id,
        from: aId,
        to: bId,
        length_km: values.length_km > 0 ? values.length_km : 1,
        speed_kmh: values.speed_kmh > 0 ? values.speed_kmh : 50,
        lanes: Math.max(1, Math.round(values.lanes) || 1),
        name: values.name || null,
        waypoints,
      };
      network.edges.push(edge);
      drawEdge(edge);
      renderEdgeList();
    }
  );
}

function onDemandPairSelected(aId, bId) {
  showModal("Route (Nachfrage)", [{ key: "vph", label: "Fahrzeuge pro Stunde", value: 300, step: 50 }], (values) => {
    if (!values.vph || values.vph <= 0) return;
    demand.push({ id: `d${++demandCounter}`, from: aId, to: bId, vehicles_per_hour: values.vph });
    renderDemandList();
  });
}

function openSignalModal(nodeId) {
  const node = network.nodes.find((n) => n.id === nodeId);
  const existing = node.signal;
  showModal(
    "Ampel einstellen",
    [
      { key: "hasSignal", label: "Ampel an dieser Kreuzung", value: !!existing, type: "checkbox" },
      { key: "cycle_s", label: "Umlaufzeit (Sekunden)", value: existing ? existing.cycle_s : 60, step: 5 },
      { key: "green_s", label: "Grünzeit (Sekunden)", value: existing ? existing.green_s : 30, step: 5 },
    ],
    (values) => {
      if (values.hasSignal) {
        const cycle = Math.max(1, values.cycle_s || 60);
        const green = Math.max(0, Math.min(cycle, values.green_s || 0));
        node.signal = { cycle_s: cycle, green_s: green };
      } else {
        node.signal = null;
      }
      redrawNodeStyle(nodeId);
    },
    "Der Grünzeitanteil (Grünzeit / Umlaufzeit) reduziert in der Simulation die nutzbare Kapazität aller Straßen, die an dieser Kreuzung ankommen."
  );
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
  const points = [[nodeA.lat, nodeA.lon], ...(edge.waypoints || []), [nodeB.lat, nodeB.lon]];
  const line = L.polyline(points, {
    color: edgeColor(edge.id),
    weight: 4,
    dashArray: closedEdges.has(edge.id) ? "6 6" : null,
  }).addTo(edgeLayer);
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
  clearCars();
}

/* --- Autos als animierte rote Punkte entlang der Straßen ---
 * Anzahl Punkte je Straße ~ simulierter Fahrzeugfluss, Umlaufzeit der
 * Animation ~ simulierte Fahrzeit (länger/gestauter = sichtbar langsamer). */
const VEHICLES_PER_DOT = 150;
const MAX_DOTS_PER_EDGE = 6;

function pointAlongPath(points, t) {
  const segLengths = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const d = Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]);
    segLengths.push(d);
    total += d;
  }
  if (total === 0) return points[0];
  let target = t * total;
  for (let i = 0; i < segLengths.length; i++) {
    if (target <= segLengths[i] || i === segLengths.length - 1) {
      const frac = segLengths[i] === 0 ? 0 : Math.min(1, target / segLengths[i]);
      const [lat1, lon1] = points[i];
      const [lat2, lon2] = points[i + 1];
      return [lat1 + (lat2 - lat1) * frac, lon1 + (lon2 - lon1) * frac];
    }
    target -= segLengths[i];
  }
  return points[points.length - 1];
}

function clearCars() {
  if (carAnimHandle) {
    cancelAnimationFrame(carAnimHandle);
    carAnimHandle = null;
  }
  carMarkers.forEach((c) => carLayer.removeLayer(c.marker));
  carMarkers = [];
}

function updateCarAnimation(simResult) {
  clearCars();
  network.edges.forEach((edge) => {
    if (closedEdges.has(edge.id)) return;
    const r = simResult.edges.find((e) => e.id === edge.id);
    if (!r || r.closed || !r.flow || r.flow <= 0) return;
    const nodeA = network.nodes.find((n) => n.id === edge.from);
    const nodeB = network.nodes.find((n) => n.id === edge.to);
    if (!nodeA || !nodeB) return;
    const points = [[nodeA.lat, nodeA.lon], ...(edge.waypoints || []), [nodeB.lat, nodeB.lon]];
    const dotCount = Math.max(1, Math.min(MAX_DOTS_PER_EDGE, Math.round(r.flow / VEHICLES_PER_DOT)));
    // Umlaufzeit der Animation grob proportional zur simulierten Fahrzeit -
    // rein zur Veranschaulichung, keine exakte Zeitskala.
    const periodMs = Math.max(1200, (r.travel_time_min || 1) * 900);
    for (let i = 0; i < dotCount; i++) {
      const marker = L.circleMarker(points[0], {
        radius: 3,
        color: "#ff3b30",
        fillColor: "#ff3b30",
        fillOpacity: 1,
        weight: 0,
      }).addTo(carLayer);
      carMarkers.push({ marker, points, periodMs, offset: i / dotCount });
    }
  });
  if (carMarkers.length) startCarAnimation();
}

function startCarAnimation() {
  const start = performance.now();
  function frame(now) {
    const elapsed = now - start;
    carMarkers.forEach((c) => {
      const t = (elapsed / c.periodMs + c.offset) % 1;
      c.marker.setLatLng(pointAlongPath(c.points, t));
    });
    carAnimHandle = requestAnimationFrame(frame);
  }
  carAnimHandle = requestAnimationFrame(frame);
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
      const curveNote = e.waypoints && e.waypoints.length ? " · kurvig" : "";
      return `<tr>
        <td>${label}<br><span class="empty-note">${e.length_km.toFixed(2)} km · ${e.speed_kmh} km/h · ${e.lanes} Spur(en)${curveNote}</span></td>
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
    nodes: network.nodes.map((n) => ({ id: n.id, lat: n.lat, lon: n.lon, signal: n.signal || null })),
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
  // kurz warten, damit der Browser den "Simuliere..."-Text noch anzeigt, bevor
  // die (synchrone) Berechnung den Main-Thread blockiert. setTimeout statt
  // requestAnimationFrame, weil rAF in einem inaktiven/verdeckten Tab pausiert
  // und die Simulation sonst hängen bliebe, bis der Tab wieder sichtbar ist.
  await new Promise((resolve) => setTimeout(resolve, 30));
  try {
    lastResult = simulateCompare(networkToApiFormat(), demandToApiFormat(), Array.from(closedEdges));
    renderResults(lastResult);
    network.edges.forEach((e) => {
      const line = edgeLinesById[e.id];
      if (line) line.setStyle({ color: edgeColor(e.id) });
    });
    updateCarAnimation(lastResult.with_closure);
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
