import type { Spot, Station, LatLng } from '../types';
import { haversineMeters } from './geo';

/**
 * Distance logic B (graph shortest path).
 * Nodes:
 * - Stations (stationId)
 * - Spots (spot.ID for JudgeTarget=1)
 * Edges:
 * - spot <-> nearest station (weight=StationRoute_m if present else haversine)
 * - spot <-> spot (neighbor) (weight=NeighborRoute_m if present else haversine)  ※MVP: neighbor is approximated by kNN.
 * - station <-> adjacent station by orderIndex (weight=route distance from CSV (prevRoute_m/nextRoute_m) if present, else haversine fallback)
 *
 * NOTE: Spot CSV provides NeighborRoute_m as a single number (legacy). For graph we need actual neighbor pairs.
 * MVP strategy: build k-nearest neighbor edges (k=4) using haversine and set weight = haversine (or NeighborRoute_m if provided but that's not per-pair).
 */
type NodeKey = string; // "S:stationId" or "P:spotId"

function sKey(stationId: string): NodeKey { return `S:${stationId}`; }
function pKey(spotId: string): NodeKey { return `P:${spotId}`; }

export type Graph = Map<NodeKey, { to: NodeKey; w: number }[]>;

export function buildGraph(spots: Spot[], stations: Station[]): Graph {
  const g: Graph = new Map();

  const addEdge = (a: NodeKey, b: NodeKey, w: number) => {
    if (!isFinite(w) || w < 0) return;
    if (!g.has(a)) g.set(a, []);
    g.get(a)!.push({ to: b, w });
  };
  const addUndir = (a: NodeKey, b: NodeKey, w: number) => {
    addEdge(a,b,w); addEdge(b,a,w);
  };

  const stationByName = new Map(stations.map(s => [s.name, s] as const));
  const stationByOrder = new Map(stations.map(s => [s.orderIndex, s] as const));

  // station adjacency
  for (const st of stations) {
    const prev = stationByOrder.get(st.orderIndex - 1);
    const next = stationByOrder.get(st.orderIndex + 1);
    if (prev) {
      const w = st.prevRoute_m ?? prev.nextRoute_m ?? haversineMeters({lat:st.lat,lng:st.lng},{lat:prev.lat,lng:prev.lng});
      addUndir(sKey(st.stationId), sKey(prev.stationId), w);
    }
    if (next) {
      const w = st.nextRoute_m ?? next.prevRoute_m ?? haversineMeters({lat:st.lat,lng:st.lng},{lat:next.lat,lng:next.lng});
      addUndir(sKey(st.stationId), sKey(next.stationId), w);
    }
  }

  const judgeSpots = spots.filter(s => s.JudgeTarget === 1);

  // spot <-> nearest station
  for (const sp of judgeSpots) {
    const ns = sp.NearestStation ? stationByName.get(sp.NearestStation) : undefined;
    if (ns) {
      const w = sp.StationRoute_m ?? haversineMeters({lat:sp.Latitude,lng:sp.Longitude},{lat:ns.lat,lng:ns.lng});
      addUndir(pKey(sp.ID), sKey(ns.stationId), w);
    }
  }

  // kNN spot edges (MVP). NeighborRoute_m is not per neighbor, so we use haversine.
  const k = 4;
  for (const sp of judgeSpots) {
    const a = { lat: sp.Latitude, lng: sp.Longitude };
    const dists = judgeSpots
      .filter(o => o.ID !== sp.ID)
      .map(o => ({ id: o.ID, d: haversineMeters(a, {lat:o.Latitude,lng:o.Longitude}) }))
      .sort((x,y)=>x.d-y.d)
      .slice(0,k);
    for (const n of dists) {
      addUndir(pKey(sp.ID), pKey(n.id), n.d);
    }
  }

  return g;
}

export function dijkstra(g: Graph, from: NodeKey): Map<NodeKey, number> {
  const dist = new Map<NodeKey, number>();
  const visited = new Set<NodeKey>();
  dist.set(from, 0);

  // simple O(V^2) is fine for ~ few hundred nodes
  const nodes = Array.from(g.keys());
  while (true) {
    let u: NodeKey | null = null;
    let best = Infinity;
    for (const n of nodes) {
      if (visited.has(n)) continue;
      const d = dist.get(n);
      if (d !== undefined && d < best) { best = d; u = n; }
    }
    if (!u) break;
    visited.add(u);
    const edges = g.get(u) ?? [];
    for (const e of edges) {
      const nd = best + e.w;
      const cur = dist.get(e.to);
      if (cur === undefined || nd < cur) dist.set(e.to, nd);
    }
  }
  return dist;
}

/** For CP detour ratio in MVP: approximate start/goal as virtual point connected by haversine to all spots */
export function detourRatioMVP(spots: Spot[], start: LatLng, goal: LatLng, candidate: Spot): number {
  const dSG = haversineMeters(start, goal) || 1;
  const d = (a: LatLng, b: LatLng) => haversineMeters(a,b);
  const dS = d(start, {lat:candidate.Latitude,lng:candidate.Longitude});
  const dG = d(goal, {lat:candidate.Latitude,lng:candidate.Longitude});
  return (dS + dG) / dSG;
}
