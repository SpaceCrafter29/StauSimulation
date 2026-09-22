from typing import List, Optional
from pydantic import BaseModel, ConfigDict, Field


class Node(BaseModel):
    id: str
    lat: float
    lon: float


class Edge(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    from_id: str = Field(alias="from")
    to_id: str = Field(alias="to")
    length_km: float
    speed_kmh: float
    lanes: int = 1
    name: Optional[str] = None


class Network(BaseModel):
    nodes: List[Node]
    edges: List[Edge]


class DemandEntry(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    from_id: str = Field(alias="from")
    to_id: str = Field(alias="to")
    vehicles_per_hour: float


class SimulateRequest(BaseModel):
    network: Network
    demand: List[DemandEntry]
    closed_edges: List[str] = []


class EdgeResult(BaseModel):
    id: str
    closed: bool
    flow: float
    free_flow_time_min: float
    travel_time_min: Optional[float]
    capacity_vph: float
    vc_ratio: Optional[float]


class ODResult(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    from_id: str = Field(alias="from")
    to_id: str = Field(alias="to")
    reachable: bool
    travel_time_min: Optional[float]
    path_nodes: List[str] = []
    path_edges: List[str] = []


class SimulationResult(BaseModel):
    edges: List[EdgeResult]
    od_results: List[ODResult]
    total_vehicle_minutes: float


class CompareResult(BaseModel):
    baseline: SimulationResult
    with_closure: SimulationResult
    delta_total_vehicle_minutes: float


class CityNetworkRequest(BaseModel):
    city: str


class CityNetworkResponse(BaseModel):
    network: Network
    note: Optional[str] = None
