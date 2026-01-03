export type LatLng = { lat: number; lng: number };

export type Spot = {
  ID: string;
  Name: string;
  Location: string; // "lat,lng"
  Latitude: number;
  Longitude: number;
  Score: number;
  size_class?: string;
  Category?: string;
  PostalCode?: string;
  Address?: string;
  Elevation?: number;
  ElevationSource?: string;
  NearestStation?: string;
  StationRoute_m?: number;
  NeighborRoute_m?: number;
  PaidFree?: string;
  Notes?: string;
  JudgeTarget: 0 | 1;
  Description?: string;
};

export type Station = {
  stationId: string; // e.g., J00736
  name: string;
  orderIndex: number; // 0..n (0=Makurazaki end, etc.)
  lat: number;
  lng: number;
  // Optional route distance (m) to adjacent stations
  prevRoute_m?: number; // distance to previous orderIndex-1 (toward Makurazaki end) or undefined
  nextRoute_m?: number; // distance to next orderIndex+1
  score?: number; // optional station score for JR check-in (default 0)
};

export type GameConfig = {
  durationMin: number; // 15min step (dropdown)
  jrEnabled: boolean;
  cpCount: number; // 0..5
  start?: LatLng; // if undefined, uses current location at start
  goal?: LatLng;  // if undefined, uses current location at start
};

export type GameProgress = {
  startedAtMs: number;
  config: GameConfig & { start: LatLng; goal: LatLng }; // resolved
  cpSpotIds: string[]; // selected CPs (spot IDs)
  reachedCpIds: string[]; // CPs reached (spot IDs)
  visitedSpotIds: string[]; // visited spots (for scoring)
  visitedStationEvents: { type: 'BOARD'|'ALIGHT', stationId: string, atMs: number }[];
  boardedStationId?: string;
  cooldownUntilMs?: number;
  /**
   * Stations that have already been scored in this game.
   * - For newly created games, this is kept in `scoredStationIds`.
   * - `usedStationIds` is retained for backward compatibility with older saved data.
   */
  scoredStationIds?: string[];
  /**
   * Backward compatible storage for station scoring.
   * Historically this was used to prohibit re-boarding/alighting at the same station.
   * Now it mirrors `scoredStationIds` and is used as a fallback when loading older data.
   */
  usedStationIds: string[];
  score: number;
  penalty: number;
  endedAtMs?: number;
  lastLocation?: { lat: number; lng: number; accuracy: number; atMs: number };
};
