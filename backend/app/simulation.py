"""
Verkehrssimulation auf Basis eines Graphmodells.

Methode: iterative Verkehrsumlegung (Method of Successive Averages, MSA) mit der
BPR-Funktion (Bureau of Public Roads) zur Umrechnung von Verkehrsfluss in Fahrzeit.
Das ist ein etabliertes Standardverfahren der Verkehrsplanung, kein Custom-Hack:
https://en.wikipedia.org/wiki/Route_assignment#Frank-Wolfe_algorithm (verwandtes Verfahren)

Kernidee: Jede Straße hat eine "freie" Fahrzeit (ohne Verkehr) und eine Kapazität.
Je mehr Fahrzeuge pro Stunde auf einer Straße unterwegs sind relativ zu ihrer
Kapazität, desto länger dauert die Fahrt (Stau). Wir verteilen die Nachfrage
(Fahrten von A nach B) iterativ auf die schnellsten Routen, aktualisieren dabei
die Fahrzeiten, und wiederholen das, bis sich ein Gleichgewicht einpendelt.
"""

import heapq
from collections import defaultdict
from typing import Callable, Dict, List, Optional, Tuple

from .models import DemandEntry, EdgeResult, Network, ODResult, SimulationResult

# BPR-Standardparameter (Bureau of Public Roads, seit den 1960ern in der
# Verkehrsplanung verwendet): t = t0 * (1 + alpha * (v/c)^beta)
BPR_ALPHA = 0.15
BPR_BETA = 4
CAPACITY_PER_LANE_VPH = 1800  # Fahrzeuge/Stunde/Fahrstreifen, HCM-Richtwert
MSA_ITERATIONS = 30


class _EdgeState:
    __slots__ = ("id", "from_id", "to_id", "free_flow_time", "capacity", "flow")

    def __init__(self, id_: str, from_id: str, to_id: str, free_flow_time: float, capacity: float):
        self.id = id_
        self.from_id = from_id
        self.to_id = to_id
        self.free_flow_time = free_flow_time
        self.capacity = capacity
        self.flow = 0.0


def _bpr_time(edge: _EdgeState) -> float:
    if edge.capacity <= 0:
        return float("inf")
    return edge.free_flow_time * (1 + BPR_ALPHA * (edge.flow / edge.capacity) ** BPR_BETA)


def _build_graph(network: Network, closed_edges: set) -> Tuple[Dict[str, List[_EdgeState]], Dict[str, _EdgeState]]:
    adjacency: Dict[str, List[_EdgeState]] = defaultdict(list)
    edges_by_id: Dict[str, _EdgeState] = {}
    for e in network.edges:
        if e.id in closed_edges:
            continue
        free_flow_time = e.length_km / e.speed_kmh * 60  # Minuten
        capacity = e.lanes * CAPACITY_PER_LANE_VPH
        state = _EdgeState(e.id, e.from_id, e.to_id, free_flow_time, capacity)
        edges_by_id[e.id] = state
        # Straßen werden hier als beidseitig befahrbar angenommen (keine Einbahnstraßen-Modellierung in v1)
        adjacency[e.from_id].append(state)
        adjacency[e.to_id].append(state)
    return adjacency, edges_by_id


def _dijkstra(
    adjacency: Dict[str, List[_EdgeState]],
    source: str,
    target: str,
    edge_time_fn: Callable[[_EdgeState], float],
) -> Tuple[float, List[str], List[str]]:
    if source not in adjacency and source != target:
        return float("inf"), [], []

    dist: Dict[str, float] = {source: 0.0}
    prev: Dict[str, Tuple[str, str]] = {}
    visited = set()
    pq = [(0.0, source)]

    while pq:
        d, u = heapq.heappop(pq)
        if u in visited:
            continue
        visited.add(u)
        if u == target:
            break
        for edge in adjacency.get(u, []):
            v = edge.to_id if edge.from_id == u else edge.from_id
            w = edge_time_fn(edge)
            nd = d + w
            if nd < dist.get(v, float("inf")):
                dist[v] = nd
                prev[v] = (u, edge.id)
                heapq.heappush(pq, (nd, v))

    if target not in dist:
        return float("inf"), [], []

    path_nodes = [target]
    path_edges = []
    cur = target
    while cur != source:
        u, eid = prev[cur]
        path_edges.append(eid)
        path_nodes.append(u)
        cur = u
    path_nodes.reverse()
    path_edges.reverse()
    return dist[target], path_nodes, path_edges


def run_simulation(network: Network, demand: List[DemandEntry], closed_edges: Optional[List[str]] = None) -> SimulationResult:
    closed_set = set(closed_edges or [])
    adjacency, edges_by_id = _build_graph(network, closed_set)

    # Iterative Umlegung: bei jeder Iteration n wird die Nachfrage komplett neu
    # auf die (aktuell) schnellsten Routen verteilt, und der bekannte Fluss wird
    # nur um 1/n in diese Richtung bewegt (MSA). Dadurch pendelt sich der Fluss
    # auf ein Gleichgewicht ein, statt bei jeder Iteration komplett umzuschlagen.
    for n in range(1, MSA_ITERATIONS + 1):
        aux_flow: Dict[str, float] = {eid: 0.0 for eid in edges_by_id}
        for d in demand:
            _, _, path_edges = _dijkstra(adjacency, d.from_id, d.to_id, _bpr_time)
            for eid in path_edges:
                aux_flow[eid] += d.vehicles_per_hour
        step = 1.0 / n
        for eid, edge in edges_by_id.items():
            edge.flow = edge.flow + step * (aux_flow[eid] - edge.flow)

    # Finale Routen mit den eingependelten Fahrzeiten für die Ausgabe berechnen
    od_results: List[ODResult] = []
    for d in demand:
        t, path_nodes, path_edges = _dijkstra(adjacency, d.from_id, d.to_id, _bpr_time)
        reachable = t != float("inf")
        od_results.append(
            ODResult(
                from_id=d.from_id,
                to_id=d.to_id,
                reachable=reachable,
                travel_time_min=t if reachable else None,
                path_nodes=path_nodes,
                path_edges=path_edges,
            )
        )

    edge_results: List[EdgeResult] = []
    total_vehicle_minutes = 0.0
    for e in network.edges:
        if e.id in closed_set:
            edge_results.append(
                EdgeResult(
                    id=e.id,
                    closed=True,
                    flow=0.0,
                    free_flow_time_min=e.length_km / e.speed_kmh * 60,
                    travel_time_min=None,
                    capacity_vph=e.lanes * CAPACITY_PER_LANE_VPH,
                    vc_ratio=None,
                )
            )
            continue
        state = edges_by_id[e.id]
        t = _bpr_time(state)
        total_vehicle_minutes += state.flow * t
        edge_results.append(
            EdgeResult(
                id=e.id,
                closed=False,
                flow=state.flow,
                free_flow_time_min=state.free_flow_time,
                travel_time_min=t,
                capacity_vph=state.capacity,
                vc_ratio=state.flow / state.capacity if state.capacity > 0 else None,
            )
        )

    return SimulationResult(edges=edge_results, od_results=od_results, total_vehicle_minutes=total_vehicle_minutes)
