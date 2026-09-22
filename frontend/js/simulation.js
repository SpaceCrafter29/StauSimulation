/*
 * Verkehrssimulation im Browser - Portierung von backend/app/simulation.py.
 * Läuft komplett client-seitig, damit die Seite ohne eigenen Server (z.B. auf
 * GitHub Pages) funktioniert. Gleiche Methode wie im Python-Original: BPR-
 * Funktion (Bureau of Public Roads) + iterative Verkehrsumlegung (Method of
 * Successive Averages, MSA). Siehe backend/app/simulation.py für die
 * ausführliche Erklärung der Methode.
 */

const BPR_ALPHA = 0.15;
const BPR_BETA = 4;
const CAPACITY_PER_LANE_VPH = 1800;
const MSA_ITERATIONS = 30;

function signalGreenRatio(node) {
  if (!node || !node.signal || node.signal.cycle_s <= 0) return 1.0;
  return Math.max(0, Math.min(1, node.signal.green_s / node.signal.cycle_s));
}

function buildGraph(network, closedEdgeIds) {
  const closedSet = new Set(closedEdgeIds || []);
  const nodesById = {};
  network.nodes.forEach((n) => (nodesById[n.id] = n));
  const adjacency = {};
  const edgesById = {};
  network.edges.forEach((e) => {
    if (closedSet.has(e.id)) return;
    const freeFlowTime = (e.length_km / e.speed_kmh) * 60; // Minuten
    const greenRatio = signalGreenRatio(nodesById[e.from]) * signalGreenRatio(nodesById[e.to]);
    const capacity = e.lanes * CAPACITY_PER_LANE_VPH * greenRatio;
    const state = { id: e.id, from: e.from, to: e.to, freeFlowTime, capacity, flow: 0 };
    edgesById[e.id] = state;
    (adjacency[e.from] = adjacency[e.from] || []).push(state);
    (adjacency[e.to] = adjacency[e.to] || []).push(state);
  });
  return { adjacency, edgesById };
}

function bprTime(edge) {
  if (edge.capacity <= 0) return Infinity;
  return edge.freeFlowTime * (1 + BPR_ALPHA * Math.pow(edge.flow / edge.capacity, BPR_BETA));
}

/* Minimaler Binär-Heap für Dijkstra (Priority Queue), analog zu Pythons heapq */
class MinHeap {
  constructor() {
    this.items = [];
  }
  get size() {
    return this.items.length;
  }
  push(priority, value) {
    this.items.push([priority, value]);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent][0] <= this.items[i][0]) break;
      [this.items[parent], this.items[i]] = [this.items[i], this.items[parent]];
      i = parent;
    }
  }
  pop() {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let smallest = i;
        if (l < this.items.length && this.items[l][0] < this.items[smallest][0]) smallest = l;
        if (r < this.items.length && this.items[r][0] < this.items[smallest][0]) smallest = r;
        if (smallest === i) break;
        [this.items[smallest], this.items[i]] = [this.items[i], this.items[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

function dijkstra(adjacency, source, target, edgeTimeFn) {
  const dist = { [source]: 0 };
  const prev = {};
  const visited = new Set();
  const heap = new MinHeap();
  heap.push(0, source);

  while (heap.size > 0) {
    const [d, u] = heap.pop();
    if (visited.has(u)) continue;
    visited.add(u);
    if (u === target) break;
    for (const edge of adjacency[u] || []) {
      const v = edge.from === u ? edge.to : edge.from;
      const w = edgeTimeFn(edge);
      const nd = d + w;
      if (nd < (dist[v] ?? Infinity)) {
        dist[v] = nd;
        prev[v] = [u, edge.id];
        heap.push(nd, v);
      }
    }
  }

  if (!(target in dist)) return { time: Infinity, pathNodes: [], pathEdges: [] };

  const pathNodes = [target];
  const pathEdges = [];
  let cur = target;
  while (cur !== source) {
    const [u, eid] = prev[cur];
    pathEdges.push(eid);
    pathNodes.push(u);
    cur = u;
  }
  pathNodes.reverse();
  pathEdges.reverse();
  return { time: dist[target], pathNodes, pathEdges };
}

function runSimulation(network, demand, closedEdgeIds) {
  const closedSet = new Set(closedEdgeIds || []);
  const { adjacency, edgesById } = buildGraph(network, closedEdgeIds);

  for (let n = 1; n <= MSA_ITERATIONS; n++) {
    const auxFlow = {};
    Object.keys(edgesById).forEach((eid) => (auxFlow[eid] = 0));
    demand.forEach((d) => {
      const { pathEdges } = dijkstra(adjacency, d.from, d.to, bprTime);
      pathEdges.forEach((eid) => {
        auxFlow[eid] += d.vehicles_per_hour;
      });
    });
    const step = 1 / n;
    Object.values(edgesById).forEach((edge) => {
      edge.flow = edge.flow + step * (auxFlow[edge.id] - edge.flow);
    });
  }

  const odResults = demand.map((d) => {
    const { time, pathNodes, pathEdges } = dijkstra(adjacency, d.from, d.to, bprTime);
    const reachable = time !== Infinity;
    return {
      from: d.from,
      to: d.to,
      reachable,
      travel_time_min: reachable ? time : null,
      path_nodes: pathNodes,
      path_edges: pathEdges,
    };
  });

  let totalVehicleMinutes = 0;
  const edgeResults = network.edges.map((e) => {
    if (closedSet.has(e.id)) {
      return {
        id: e.id,
        closed: true,
        flow: 0,
        free_flow_time_min: (e.length_km / e.speed_kmh) * 60,
        travel_time_min: null,
        capacity_vph: e.lanes * CAPACITY_PER_LANE_VPH,
        vc_ratio: null,
      };
    }
    const state = edgesById[e.id];
    const t = bprTime(state);
    totalVehicleMinutes += state.flow * t;
    return {
      id: e.id,
      closed: false,
      flow: state.flow,
      free_flow_time_min: state.freeFlowTime,
      travel_time_min: t,
      capacity_vph: state.capacity,
      vc_ratio: state.capacity > 0 ? state.flow / state.capacity : null,
    };
  });

  return { edges: edgeResults, od_results: odResults, total_vehicle_minutes: totalVehicleMinutes };
}

function simulateCompare(network, demand, closedEdgeIds) {
  const baseline = runSimulation(network, demand, []);
  const withClosure = runSimulation(network, demand, closedEdgeIds);
  return {
    baseline,
    with_closure: withClosure,
    delta_total_vehicle_minutes: withClosure.total_vehicle_minutes - baseline.total_vehicle_minutes,
  };
}
