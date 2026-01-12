import type { GameProgress, Spot } from '../types';

export type KpiPayloadV1 = {
  schemaVersion: 1;
  sentAtMs: number;
  startedAtMs: number;
  endedAtMs: number;
  durationMin: number;
  jrEnabled: boolean;
  cpCountSetting: number;
  cityFilter: { ibusuki: boolean; minamikyushu: boolean; makurazaki: boolean };

  score: number;
  penalty: number;
  visitedSpotCount: number;
  visitedSpotIds: string[];
  reachedCpCount: number;
  reachedCpIds: string[];
  cpSpotIds: string[];

  jrEventCount: number;
  jrBoardCount: number;
  jrAlightCount: number;

  achievementBonus: number;
  achievementUnlockedIds: string[];

  /** user opt-in for sharing aggregated results */
  shareOk: boolean;

  /** optional, derived fields for easy aggregation */
  visitedCityCounts?: { ibusuki: number; minamikyushu: number; makurazaki: number; other: number };
};

export function buildKpiPayloadV1(
  progress: GameProgress,
  spots: Spot[] | undefined,
  shareOk: boolean,
): KpiPayloadV1 {
  const endedAtMs = progress.endedAtMs ?? Date.now();
  const cityFilter = progress.config.cityFilter ?? { ibusuki: true, minamikyushu: true, makurazaki: true };

  const payload: KpiPayloadV1 = {
    schemaVersion: 1,
    sentAtMs: Date.now(),
    startedAtMs: progress.startedAtMs,
    endedAtMs,
    durationMin: progress.config.durationMin,
    jrEnabled: progress.config.jrEnabled,
    cpCountSetting: progress.config.cpCount,
    cityFilter,
    score: progress.score,
    penalty: progress.penalty,
    visitedSpotCount: progress.visitedSpotIds.length,
    visitedSpotIds: [...progress.visitedSpotIds],
    reachedCpCount: progress.reachedCpIds.length,
    reachedCpIds: [...progress.reachedCpIds],
    cpSpotIds: [...progress.cpSpotIds],
    jrEventCount: progress.visitedStationEvents.length,
    jrBoardCount: progress.visitedStationEvents.filter(e => e.type === 'BOARD').length,
    jrAlightCount: progress.visitedStationEvents.filter(e => e.type === 'ALIGHT').length,
    achievementBonus: progress.achievementBonus ?? 0,
    achievementUnlockedIds: (progress.achievementUnlocked ?? []).map(a => a.id),
    shareOk,
  };

  if (spots && spots.length) {
    const spotById = new Map(spots.map(s => [s.ID, s] as const));
    const counts = { ibusuki: 0, minamikyushu: 0, makurazaki: 0, other: 0 };
    for (const id of progress.visitedSpotIds) {
      const s = spotById.get(id);
      const addr = s?.Address ?? '';
      if (addr.includes('指宿市')) counts.ibusuki++;
      else if (addr.includes('南九州市')) counts.minamikyushu++;
      else if (addr.includes('枕崎市')) counts.makurazaki++;
      else counts.other++;
    }
    payload.visitedCityCounts = counts;
  }

  return payload;
}

/**
 * Send KPI payload to endpoint (e.g., Google Apps Script Web App).
 * Uses `no-cors` mode so it can be used from GitHub Pages without special CORS handling.
 */
export async function sendKpiPayload(payload: KpiPayloadV1): Promise<void> {
  const enabled = import.meta.env.VITE_KPI_ENABLED;
  const endpoint = import.meta.env.VITE_KPI_ENDPOINT_URL;
  const token = import.meta.env.VITE_KPI_TOKEN;
  if (!endpoint || enabled !== '1') {
    throw new Error('KPI送信先が設定されていません。');
  }

  const body = new URLSearchParams();
  body.set('payload', JSON.stringify(payload));
  if (token && token.trim().length > 0) {
    body.set('token', token.trim());
  }

  // `no-cors` means we cannot read the response body/status;
  // if the request is successfully queued, fetch resolves.
  await fetch(endpoint, {
    method: 'POST',
    mode: 'no-cors',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body,
  });
}
