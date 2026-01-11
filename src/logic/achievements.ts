import type { GameProgress, Spot } from '../types';

export type AchievementUnlock = { id: string; name: string; points: number };

export type AchievementRecord = {
  id: string;
  firstUnlockedAtMs: number;
  lastUnlockedAtMs: number;
  unlockCount: number;
};

const ACHIEVEMENT_RECORDS_KEY = 'ibumaku_achievementRecords_v1';

export const ACH_ID_ALL_SPOTS = 'ACH_ALL_SPOTS';
export const ACH_ID_CITY_IBUSUKI = 'ACH_CITY_IBUSUKI';
export const ACH_ID_CITY_MINAMIKYUSHU = 'ACH_CITY_MINAMIKYUSHU';
export const ACH_ID_CITY_MAKURAZAKI = 'ACH_CITY_MAKURAZAKI';

export const makePostalId = (postalCode: string) => `ACH_POSTAL_${postalCode}`;
export const makeCategoryId = (category: string) => `ACH_CAT_${encodeURIComponent(category)}`;

export function loadAchievementRecords(): AchievementRecord[] {
  try {
    const raw = localStorage.getItem(ACHIEVEMENT_RECORDS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x: any) => x && typeof x.id === 'string')
      .map((x: any) => ({
        id: String(x.id),
        firstUnlockedAtMs: Number(x.firstUnlockedAtMs) || 0,
        lastUnlockedAtMs: Number(x.lastUnlockedAtMs) || 0,
        unlockCount: Math.max(1, Number(x.unlockCount) || 1),
      }));
  } catch {
    return [];
  }
}

export function saveAchievementRecords(records: AchievementRecord[]) {
  try {
    localStorage.setItem(ACHIEVEMENT_RECORDS_KEY, JSON.stringify(records));
  } catch {
    // ignore
  }
}

function upsertRecord(records: AchievementRecord[], id: string, nowMs: number, increment: boolean): AchievementRecord[] {
  const idx = records.findIndex(r => r.id === id);
  if (idx < 0) {
    return records.concat([{ id, firstUnlockedAtMs: nowMs, lastUnlockedAtMs: nowMs, unlockCount: 1 }]);
  }
  const r = records[idx];
  const next: AchievementRecord = {
    ...r,
    lastUnlockedAtMs: nowMs,
    unlockCount: increment ? (r.unlockCount + 1) : r.unlockCount,
  };
  const out = records.slice();
  out[idx] = next;
  return out;
}

export function updateRecordsForGameUnlocks(unlocks: AchievementUnlock[], nowMs: number) {
  if (!unlocks.length) return;
  let records = loadAchievementRecords();
  for (const u of unlocks) {
    records = upsertRecord(records, u.id, nowMs, true);
  }
  saveAchievementRecords(records);
}

/**
 * Ensure achievements that are satisfied cumulatively (ever visited) are recorded as unlocked.
 * NOTE: This does NOT increment unlockCount (it is "record only", no scoring).
 */
export function ensureRecordsForCumulative(everVisitedSpotIds: Set<string>, judgeSpots: Spot[], nowMs: number) {
  const unlockedIds = computeCumulativeUnlockedIds(everVisitedSpotIds, judgeSpots);
  if (!unlockedIds.length) return;
  let records = loadAchievementRecords();
  const recordIds = new Set(records.map(r => r.id));
  for (const id of unlockedIds) {
    if (recordIds.has(id)) continue;
    records = upsertRecord(records, id, nowMs, false);
    recordIds.add(id);
  }
  saveAchievementRecords(records);
}

export function computeGameUnlocks(progress: GameProgress, judgeSpots: Spot[]): AchievementUnlock[] {
  const visited = new Set(progress.visitedSpotIds);
  const targets = judgeSpots.filter(s => s.JudgeTarget === 1);

  const unlocks: AchievementUnlock[] = [];
  const push = (u: AchievementUnlock) => {
    if (unlocks.some(x => x.id === u.id)) return;
    unlocks.push(u);
  };

  // All spots (judgeTarget=1)
  if (targets.length > 0 && targets.every(s => visited.has(s.ID))) {
    push({ id: ACH_ID_ALL_SPOTS, name: '全スポット巡回達成', points: 6000 });
  }

  // City groups (based on Address includes 市名)
  const cityGroups: { id: string; city: string; name: string; points: number }[] = [
    { id: ACH_ID_CITY_IBUSUKI, city: '指宿市', name: '地域（指宿市）全スポット巡回達成', points: 2000 },
    { id: ACH_ID_CITY_MINAMIKYUSHU, city: '南九州市', name: '地域（南九州市）全スポット巡回達成', points: 2000 },
    { id: ACH_ID_CITY_MAKURAZAKI, city: '枕崎市', name: '地域（枕崎市）全スポット巡回達成', points: 2000 },
  ];

  for (const g of cityGroups) {
    const group = targets.filter(s => (s.Address ?? '').includes(g.city));
    if (group.length === 0) continue;
    if (group.every(s => visited.has(s.ID))) {
      push({ id: g.id, name: g.name, points: g.points });
    }
  }

  // Postal groups
  const byPostal = new Map<string, Spot[]>();
  for (const s of targets) {
    const p = (s.PostalCode ?? '').trim();
    if (!p) continue;
    if (!byPostal.has(p)) byPostal.set(p, []);
    byPostal.get(p)!.push(s);
  }

  const postalPoints = (n: number) => {
    if (n <= 1) return 30;
    if (n <= 3) return 50;
    if (n <= 6) return 60;
    if (n <= 10) return 100;
    if (n <= 20) return 200;
    return 400;
  };

  for (const [postal, group] of byPostal.entries()) {
    if (group.length === 0) continue;
    if (group.every(s => visited.has(s.ID))) {
      push({
        id: makePostalId(postal),
        name: `地域（郵便番号：${postal}）全スポット巡回達成`,
        points: postalPoints(group.length),
      });
    }
  }

  // Category groups
  const byCat = new Map<string, Spot[]>();
  for (const s of targets) {
    const c = (s.Category ?? '').trim();
    if (!c) continue;
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c)!.push(s);
  }
  for (const [cat, group] of byCat.entries()) {
    if (group.length === 0) continue;
    if (group.every(s => visited.has(s.ID))) {
      push({
        id: makeCategoryId(cat),
        name: `カテゴリ（${cat}）全スポット巡回達成`,
        points: 500,
      });
    }
  }

  return unlocks;
}

export function computeBonus(unlocks: AchievementUnlock[]): number {
  return unlocks.reduce((sum, u) => sum + (u.points || 0), 0);
}

/**
 * Cumulative unlock condition uses ever visited spot ids (★).
 * This unlock list is used only for recording, not scoring.
 */
export function computeCumulativeUnlockedIds(everVisitedSpotIds: Set<string>, judgeSpots: Spot[]): string[] {
  const visited = everVisitedSpotIds;
  const targets = judgeSpots.filter(s => s.JudgeTarget === 1);

  const unlocked: string[] = [];

  const push = (id: string) => {
    if (unlocked.includes(id)) return;
    unlocked.push(id);
  };

  if (targets.length > 0 && targets.every(s => visited.has(s.ID))) push(ACH_ID_ALL_SPOTS);

  const cityGroups: { id: string; city: string }[] = [
    { id: ACH_ID_CITY_IBUSUKI, city: '指宿市' },
    { id: ACH_ID_CITY_MINAMIKYUSHU, city: '南九州市' },
    { id: ACH_ID_CITY_MAKURAZAKI, city: '枕崎市' },
  ];
  for (const g of cityGroups) {
    const group = targets.filter(s => (s.Address ?? '').includes(g.city));
    if (group.length === 0) continue;
    if (group.every(s => visited.has(s.ID))) push(g.id);
  }

  const byPostal = new Map<string, Spot[]>();
  for (const s of targets) {
    const p = (s.PostalCode ?? '').trim();
    if (!p) continue;
    if (!byPostal.has(p)) byPostal.set(p, []);
    byPostal.get(p)!.push(s);
  }
  for (const [postal, group] of byPostal.entries()) {
    if (group.length === 0) continue;
    if (group.every(s => visited.has(s.ID))) push(makePostalId(postal));
  }

  const byCat = new Map<string, Spot[]>();
  for (const s of targets) {
    const c = (s.Category ?? '').trim();
    if (!c) continue;
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c)!.push(s);
  }
  for (const [cat, group] of byCat.entries()) {
    if (group.length === 0) continue;
    if (group.every(s => visited.has(s.ID))) push(makeCategoryId(cat));
  }

  return unlocked;
}

export function achievementDisplayMeta(id: string, judgeSpots: Spot[]): { name: string; pointsHint?: string } {
  if (id === ACH_ID_ALL_SPOTS) return { name: '全スポット巡回達成', pointsHint: '6000点（ゲーム内達成時）' };
  if (id === ACH_ID_CITY_IBUSUKI) return { name: '地域（指宿市）全スポット巡回達成', pointsHint: '2000点（ゲーム内達成時）' };
  if (id === ACH_ID_CITY_MINAMIKYUSHU) return { name: '地域（南九州市）全スポット巡回達成', pointsHint: '2000点（ゲーム内達成時）' };
  if (id === ACH_ID_CITY_MAKURAZAKI) return { name: '地域（枕崎市）全スポット巡回達成', pointsHint: '2000点（ゲーム内達成時）' };

  if (id.startsWith('ACH_POSTAL_')) {
    const postal = id.slice('ACH_POSTAL_'.length);
    // points hint depends on current group size
    const targets = judgeSpots.filter(s => s.JudgeTarget === 1 && (s.PostalCode ?? '').trim() === postal);
    const n = targets.length;
    const pts = n <= 1 ? 30 : n <= 3 ? 50 : n <= 6 ? 60 : n <= 10 ? 100 : n <= 20 ? 200 : 400;
    return { name: `地域（郵便番号：${postal}）全スポット巡回達成`, pointsHint: `${pts}点（ゲーム内達成時）` };
  }
  if (id.startsWith('ACH_CAT_')) {
    const encoded = id.slice('ACH_CAT_'.length);
    const cat = decodeURIComponent(encoded);
    return { name: `カテゴリ（${cat}）全スポット巡回達成`, pointsHint: '500点（ゲーム内達成時）' };
  }
  return { name: id };
}

export function isInactiveNow(id: string, everVisitedSpotIds: Set<string>, judgeSpots: Spot[]): boolean {
  // If it can be satisfied cumulatively now, it's active; otherwise inactive.
  const unlockedNow = new Set(computeCumulativeUnlockedIds(everVisitedSpotIds, judgeSpots));
  return !unlockedNow.has(id);
}
