import type { GameConfig, GameProgress, LatLng, Spot, Station } from '../types';
import { haversineMeters } from '../utils/geo';
import { floorMinutesFromMs } from '../utils/time';
import { detourRatioMVP } from '../utils/graph';

export const CHECKIN_RADIUS_M = 50;
export const MAX_ACCURACY_M = 100;
export const JR_COOLDOWN_SEC = 60;

export type CheckInResult =
  | { ok: true; kind: 'SPOT'|'CP'|'JR_BOARD'|'JR_ALIGHT'|'GOAL'; message: string; progress: GameProgress }
  | { ok: false; code: string; message: string };

function nowMs() { return Date.now(); }

export function calcPenalty(startedAtMs: number, durationMin: number, goalAtMs: number): number {
  const plannedEnd = startedAtMs + durationMin * 60_000;
  const earlyThreshold = plannedEnd - 15 * 60_000;
  if (goalAtMs < earlyThreshold) return floorMinutesFromMs(earlyThreshold - goalAtMs);
  if (goalAtMs > plannedEnd) return floorMinutesFromMs(goalAtMs - plannedEnd);
  return 0;
}

export function pickCandidateSpotWithinRadius(spots: Spot[], loc: LatLng): { spot: Spot; dist: number } | null {
  const candidates = spots.map(s => {
    const d = haversineMeters(loc, {lat:s.Latitude, lng:s.Longitude});
    return { s, d };
  }).filter(x => x.d <= CHECKIN_RADIUS_M);

  if (!candidates.length) return null;

  // Plan A: nearest -> tie: higher score -> tie: ID asc
  candidates.sort((a,b) => {
    if (a.d !== b.d) return a.d - b.d;
    if (a.s.Score !== b.s.Score) return b.s.Score - a.s.Score;
    return a.s.ID.localeCompare(b.s.ID);
  });
  const top = candidates[0];
  return { spot: top.s, dist: top.d };
}

export function startNewGame(resolvedConfig: GameConfig & { start: LatLng; goal: LatLng }, cpSpotIds: string[]): GameProgress {
  const t = nowMs();
  return {
    startedAtMs: t,
    config: resolvedConfig,
    cpSpotIds,
    reachedCpIds: [],
    visitedSpotIds: [],
    visitedStationEvents: [],
    usedStationIds: [], // legacy (kept)
    scoredStationIds: [],
    score: 0,
    penalty: 0,
  };
}

export function selectCpSpotsMVP(allJudgeSpots: Spot[], config: GameConfig & { start: LatLng; goal: LatLng }): string[] {
  const n = Math.max(0, Math.min(5, config.cpCount));
  if (n === 0) return [];

  const pool = allJudgeSpots.slice();
  // Exclude duplicates by ID naturally
  if (n <= 2) {
    // Prefer spots "between" start and goal.
    // MVP: use detour ratio by straight-line approximation (later can switch to graph distance).
    const scored = pool.map(s => ({ id: s.ID, r: detourRatioMVP(allJudgeSpots, config.start, config.goal, s) }))
      .sort((a,b)=>a.r-b.r);
    const K = Math.min(30, scored.length);
    const top = scored.slice(0, K).map(x=>x.id);
    const picked: string[] = [];
    while (picked.length < n && top.length) {
      const idx = Math.floor(Math.random() * top.length);
      picked.push(top.splice(idx,1)[0]);
    }
    return picked;
  }

  // n >= 3: random without replacement
  const picked: string[] = [];
  const ids = pool.map(s=>s.ID);
  while (picked.length < n && ids.length) {
    const idx = Math.floor(Math.random() * ids.length);
    picked.push(ids.splice(idx,1)[0]);
  }
  return picked;
}

export function checkInSpotOrCp(progress: GameProgress, loc: LatLng, accuracy: number, judgeSpots: Spot[]): CheckInResult {
  if (progress.endedAtMs) return { ok:false, code:'GAME_ENDED', message:'ゲームは終了しています。' };
  if (accuracy > MAX_ACCURACY_M) return { ok:false, code:'ACCURACY_TOO_BAD', message:`accuracyが大きすぎます（${Math.round(accuracy)}m）。100m以内になるまで待ってください。` };

  const cand = pickCandidateSpotWithinRadius(judgeSpots, loc);
  if (!cand) return { ok:false, code:'NO_SPOT', message:`50m以内にスポットが見つかりません。` };

  const spot = cand.spot;
  // Score only once per spot ID
  const visited = new Set(progress.visitedSpotIds);
  const reachedCp = new Set(progress.reachedCpIds);

  const isCp = progress.cpSpotIds.includes(spot.ID);

  let add = 0;
  if (!visited.has(spot.ID)) add += spot.Score;

  visited.add(spot.ID);
  if (isCp) reachedCp.add(spot.ID);

  const next: GameProgress = {
    ...progress,
    visitedSpotIds: Array.from(visited),
    reachedCpIds: Array.from(reachedCp),
    score: progress.score + add,
    lastLocation: { lat: loc.lat, lng: loc.lng, accuracy, atMs: nowMs() }
  };

  return {
    ok: true,
    kind: isCp ? 'CP' : 'SPOT',
    message: isCp
      ? `CP達成：${spot.Name}（+${add}）`
      : `スポット達成：${spot.Name}（+${add}）`,
    progress: next
  };
}

function pickStationWithinRadius(stations: Station[], loc: LatLng): { st: Station; d: number } | null {
  const cs = stations.map(st => ({ st, d: haversineMeters(loc, {lat: st.lat, lng: st.lng}) }))
    .filter(x => x.d <= CHECKIN_RADIUS_M);
  if (!cs.length) return null;
  cs.sort((a,b)=>{
    if (a.d !== b.d) return a.d - b.d;
    return a.st.stationId.localeCompare(b.st.stationId);
  });
  return cs[0];
}

export function jrBoard(progress: GameProgress, loc: LatLng, accuracy: number, stations: Station[]): CheckInResult {
  const t = nowMs();
  if (progress.endedAtMs) return { ok:false, code:'GAME_ENDED', message:'ゲームは終了しています。' };
  if (accuracy > MAX_ACCURACY_M) return { ok:false, code:'ACCURACY_TOO_BAD', message:`accuracyが大きすぎます（${Math.round(accuracy)}m）。100m以内になるまで待ってください。` };
  if (!progress.config.jrEnabled) return { ok:false, code:'JR_DISABLED', message:'JRはOFFです。' };
  if (progress.cooldownUntilMs && t < progress.cooldownUntilMs) {
    const left = Math.ceil((progress.cooldownUntilMs - t)/1000);
    return { ok:false, code:'COOLDOWN', message:`クールダウン中（残り${left}秒）` };
  }
  if (progress.boardedStationId) return { ok:false, code:'ALREADY_BOARDED', message:'すでに乗車中です。降車チェックインをしてください。' };

  const cand = pickStationWithinRadius(stations, loc);
  if (!cand) return { ok:false, code:'NO_STATION', message:'50m以内に駅が見つかりません。' };

  const stationId = cand.st.stationId;
  const next: GameProgress = {
    ...progress,
    boardedStationId: stationId,
    visitedStationEvents: [...progress.visitedStationEvents, { type:'BOARD', stationId, atMs: t }],
    cooldownUntilMs: t + JR_COOLDOWN_SEC * 1000,
    lastLocation: { lat: loc.lat, lng: loc.lng, accuracy, atMs: t }
  };

  return { ok:true, kind:'JR_BOARD', message:`乗車チェックイン：${cand.st.name}`, progress: next };
}

function stationsBetween(board: Station, alight: Station, byOrder: Map<number, Station>): Station[] {
  const a = board.orderIndex;
  const b = alight.orderIndex;
  const step = a < b ? 1 : -1;
  const list: Station[] = [];
  for (let i = a + step; step > 0 ? i < b : i > b; i += step) {
    const st = byOrder.get(i);
    if (st) list.push(st);
  }
  return list;
}

export function jrAlight(progress: GameProgress, loc: LatLng, accuracy: number, stations: Station[]): CheckInResult {
  const t = nowMs();
  if (progress.endedAtMs) return { ok:false, code:'GAME_ENDED', message:'ゲームは終了しています。' };
  if (accuracy > MAX_ACCURACY_M) return { ok:false, code:'ACCURACY_TOO_BAD', message:`accuracyが大きすぎます（${Math.round(accuracy)}m）。100m以内になるまで待ってください。` };
  if (!progress.config.jrEnabled) return { ok:false, code:'JR_DISABLED', message:'JRはOFFです。' };
  if (progress.cooldownUntilMs && t < progress.cooldownUntilMs) {
    const left = Math.ceil((progress.cooldownUntilMs - t)/1000);
    return { ok:false, code:'COOLDOWN', message:`クールダウン中（残り${left}秒）` };
  }
  const boardedId = progress.boardedStationId;
  if (!boardedId) return { ok:false, code:'NOT_BOARDED', message:'乗車チェックインが先です。' };

  const cand = pickStationWithinRadius(stations, loc);
  if (!cand) return { ok:false, code:'NO_STATION', message:'50m以内に駅が見つかりません。' };

  const alightId = cand.st.stationId;
  if (alightId === boardedId) return { ok:false, code:'SAME_STATION', message:'同一駅での乗車・降車はできません。' };

  const byId = new Map(stations.map(s=>[s.stationId,s] as const));
  const byOrder = new Map(stations.map(s=>[s.orderIndex,s] as const));
  const board = byId.get(boardedId);
  if (!board) return { ok:false, code:'BOARD_STATION_UNKNOWN', message:'乗車駅が駅マスタに見つかりません。' };

  // scoring: board + alight + pass stations
  const pass = stationsBetween(board, cand.st, byOrder);
  const scoreOf = (st: Station) => (isFinite(st.score ?? 0) ? (st.score ?? 0) : 0);

  // station points are added at most once per stationId per game
  const scored = new Set(progress.scoredStationIds ?? []);
  const rideStations: Station[] = [board, ...pass, cand.st];
  let jrScore = 0;
  for (const st of rideStations) {
    if (scored.has(st.stationId)) continue;
    jrScore += scoreOf(st);
    scored.add(st.stationId);
  }

  const next: GameProgress = {
    ...progress,
    score: progress.score + jrScore,
    boardedStationId: undefined,
    // keep legacy usedStationIds as-is for backward compatibility
    scoredStationIds: Array.from(scored),
    visitedStationEvents: [...progress.visitedStationEvents, { type:'ALIGHT', stationId: alightId, atMs: t }],
    cooldownUntilMs: t + JR_COOLDOWN_SEC * 1000,
    lastLocation: { lat: loc.lat, lng: loc.lng, accuracy, atMs: t }
  };

  const passNames = pass.map(s=>s.name).join('、');
  const msg = pass.length
    ? `降車チェックイン：${cand.st.name}（通過：${passNames}、+${jrScore}）`
    : `降車チェックイン：${cand.st.name}（+${jrScore}）`;

  return { ok:true, kind:'JR_ALIGHT', message: msg, progress: next };
}

export function goalCheckIn(progress: GameProgress, loc: LatLng, accuracy: number): CheckInResult {
  const t = nowMs();
  if (progress.endedAtMs) return { ok:false, code:'GAME_ENDED', message:'ゲームは終了しています。' };
  if (accuracy > MAX_ACCURACY_M) return { ok:false, code:'ACCURACY_TOO_BAD', message:`accuracyが大きすぎます（${Math.round(accuracy)}m）。100m以内になるまで待ってください。` };
  // check radius to goal
  const d = haversineMeters(loc, progress.config.goal);
  if (d > CHECKIN_RADIUS_M) return { ok:false, code:'NOT_AT_GOAL', message:'ゴール地点の50m以内でチェックインしてください。' };

  const timePenalty = calcPenalty(progress.startedAtMs, progress.config.durationMin, t);
  const reachedCp = new Set(progress.reachedCpIds);
  const cpPenalty = Math.max(0, progress.cpSpotIds.length - reachedCp.size) * 100;
  const penalty = timePenalty + cpPenalty;

  const next: GameProgress = {
    ...progress,
    endedAtMs: t,
    endReason: 'GOAL',
    penalty,
    score: progress.score - penalty,
    lastLocation: { lat: loc.lat, lng: loc.lng, accuracy, atMs: t }
  };

  const cpMsg = cpPenalty > 0 ? `（CP未達-${cpPenalty}点）` : '';
  return { ok:true, kind:'GOAL', message:`ゴール！ペナルティ${penalty}点${cpMsg}`, progress: next };
}
