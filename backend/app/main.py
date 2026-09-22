from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .models import (
    CityNetworkRequest,
    CityNetworkResponse,
    CompareResult,
    SimulateRequest,
    SimulationResult,
)
from .osm import CityNotFoundError, fetch_city_network
from .simulation import run_simulation

app = FastAPI(title="StauSimulation API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/api/network/from-city", response_model=CityNetworkResponse)
def network_from_city(req: CityNetworkRequest):
    try:
        result = fetch_city_network(req.city)
    except CityNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return CityNetworkResponse(**result)


@app.post("/api/simulate", response_model=SimulationResult)
def simulate(req: SimulateRequest):
    return run_simulation(req.network, req.demand, req.closed_edges)


@app.post("/api/simulate/compare", response_model=CompareResult)
def simulate_compare(req: SimulateRequest):
    baseline = run_simulation(req.network, req.demand, closed_edges=[])
    with_closure = run_simulation(req.network, req.demand, closed_edges=req.closed_edges)
    return CompareResult(
        baseline=baseline,
        with_closure=with_closure,
        delta_total_vehicle_minutes=with_closure.total_vehicle_minutes - baseline.total_vehicle_minutes,
    )


# Frontend als statische Dateien mitausliefern, damit alles auf einem Port läuft
# (kein CORS-Ärger, kein zweiter Server nötig).
FRONTEND_DIR = Path(__file__).resolve().parent.parent.parent / "frontend"
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
