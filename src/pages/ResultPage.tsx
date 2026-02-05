import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getAllSpots, getStationsByOrder, loadGame } from '../db/repo';
import { calcPenalty } from '../logic/game';
import { buildKpiPayloadV1, sendKpiPayload } from '../logic/kpi';
import { useGameStore } from '../store/gameStore';
import type { Spot, Station } from '../types';

type KpiDecision = 'undecided' | 'sent' | 'skip';

function getKpiDecisionKey(startedAtMs: number): string {
  return `ibumaku:kpi:decision:v1:${startedAtMs}`;
}

export default function ResultPage() {
  const nav = useNavigate();
  const progress = useGameStore(s=>s.progress);
  const setProgress = useGameStore(s=>s.setProgress);
  const [loaded, setLoaded] = useState(false);
  const [spots, setSpots] = useState<Spot[]>([]);
  const [stations, setStations] = useState<Station[]>([]);
  const [kpiConsent, setKpiConsent] = useState(true);
  const [kpiDecision, setKpiDecision] = useState<KpiDecision>('undecided');
  const [kpiSending, setKpiSending] = useState(false);

  const kpiUiEnabled = useMemo(() => {
    return (import.meta.env.VITE_KPI_ENABLED === '1') && !!import.meta.env.VITE_KPI_ENDPOINT_URL;
  }, []);

  useEffect(() => {
    (async () => {
      const g = progress ?? await loadGame();
      if (!g || !g.endedAtMs) { nav('/'); return; }
      if ((g as any).endReason === 'ABANDONED' || (g as any).endReason === 'ARCHIVE') { nav('/'); return; }
      setProgress(g);
      try {
        const [allSpots, sts] = await Promise.all([getAllSpots(), getStationsByOrder()]);
        setSpots(allSpots);
        setStations(sts);
      } catch {
        // If master is not available, show IDs as-is.
      }
      setLoaded(true);
    })();
  }, [nav, progress, setProgress]);

  // Load decision for this game (once progress is ready)
  useEffect(() => {
    if (!kpiUiEnabled) return;
    if (!progress) return;
    const key = getKpiDecisionKey(progress.startedAtMs);
    const v = (localStorage.getItem(key) ?? '').trim();
    if (v === 'sent' || v === 'skip') {
      setKpiDecision(v);
      if (v === 'skip') setKpiConsent(false);
    } else {
      setKpiDecision('undecided');
      setKpiConsent(true);
    }
  }, [kpiUiEnabled, progress]);

  const finalizeDecision = useCallback((decision: Exclude<KpiDecision, 'undecided'>) => {
    if (!progress) return;
    const key = getKpiDecisionKey(progress.startedAtMs);
    localStorage.setItem(key, decision);
    setKpiDecision(decision);
  }, [progress]);

  const trySendKpiOnce = useCallback(async () => {
    if (!kpiUiEnabled) return;
    if (!progress) return;
    if (kpiDecision !== 'undecided') return;
    if (!kpiConsent) {
      finalizeDecision('skip');
      return;
    }

    // best-effort send: no noisy UI on failure
    if (!navigator.onLine) return;
    if (kpiSending) return;

    try {
      setKpiSending(true);
      const payload = buildKpiPayloadV1(progress, spots, true /* shareOk: ON */);
      await sendKpiPayload(payload);
      finalizeDecision('sent');
    } catch {
      // swallow (no-cors / network). Do NOT finalize, so user can retry next time.
    } finally {
      setKpiSending(false);
    }
  }, [finalizeDecision, kpiConsent, kpiDecision, kpiSending, kpiUiEnabled, progress, spots]);

  const leaveTo = useCallback(async (to: string) => {
    await trySendKpiOnce();
    nav(to);
  }, [nav, trySendKpiOnce]);

  // Allow App header to request guarded navigation while on /result
  useEffect(() => {
    (window as any).__ibumaku_leave_result = leaveTo;
    return () => {
      try { delete (window as any).__ibumaku_leave_result; } catch { /* ignore */ }
    };
  }, [leaveTo]);

  if (!loaded || !progress) return <div className="card">読込中...</div>;

  const reachedCpSet = new Set(progress.reachedCpIds);
  const missingCpCount = progress.cpSpotIds.filter(id => !reachedCpSet.has(id)).length;
  const cpPenalty = missingCpCount * 100;
  const timePenalty = progress.endedAtMs
    ? calcPenalty(progress.startedAtMs, progress.config.durationMin, progress.endedAtMs)
    : 0;


  const spotNameById = new Map(spots.map(s => [s.ID, s.Name] as const));
  const stationById = new Map(stations.map(s => [s.stationId, s] as const));
  const stationByOrder = new Map(stations.map(s => [s.orderIndex, s] as const));

  const visitedSpotNames = progress.visitedSpotIds.map(id => spotNameById.get(id) ?? id);

  // CP: show only achieved CP names (do not list missing ones)
  const reachedCpNames = progress.cpSpotIds
    .filter(id => reachedCpSet.has(id))
    .map(id => spotNameById.get(id) ?? id);

  // JR event lists
  const boardIds = progress.visitedStationEvents.filter(e => e.type === 'BOARD').map(e => e.stationId);
  const alightIds = progress.visitedStationEvents.filter(e => e.type === 'ALIGHT').map(e => e.stationId);

  const stationsBetween = (boardId: string, alightId: string): string[] => {
    const a = stationById.get(boardId);
    const b = stationById.get(alightId);
    if (!a || !b) return [];
    const step = a.orderIndex < b.orderIndex ? 1 : -1;
    const ids: string[] = [];
    for (let i = a.orderIndex + step; step > 0 ? i < b.orderIndex : i > b.orderIndex; i += step) {
      const st = stationByOrder.get(i);
      if (st) ids.push(st.stationId);
    }
    return ids;
  };

  const passIds: string[] = [];
  let currentBoard: string | undefined;
  for (const ev of progress.visitedStationEvents) {
    if (ev.type === 'BOARD') {
      currentBoard = ev.stationId;
      continue;
    }
    if (ev.type === 'ALIGHT') {
      if (!currentBoard) continue;
      passIds.push(...stationsBetween(currentBoard, ev.stationId));
      currentBoard = undefined;
    }
  }

  const stationName = (id: string) => stationById.get(id)?.name ?? id;

  // Deduplicate while preserving order
  const uniq = <T,>(arr: T[]): T[] => {
    const seen = new Set<T>();
    const out: T[] = [];
    for (const x of arr) {
      if (seen.has(x)) continue;
      seen.add(x);
      out.push(x);
    }
    return out;
  };

  const boardIdsU = uniq(boardIds);
  const alightIdsU = uniq(alightIds);
  const exclude = new Set<string>([...boardIdsU, ...alightIdsU]);
  const passIdsU = uniq(passIds.filter(id => !exclude.has(id)));

  const boardNames = boardIdsU.map(stationName);
  const alightNames = alightIdsU.map(stationName);
  const passNames = passIdsU.map(stationName);

  const penaltyDisplay = progress.penalty === 0 ? '0' : `-${Math.abs(progress.penalty)}`;

  return (
    <div className="card">
      <h3>リザルト</h3>

      <div>総合スコア：<b>{progress.score}</b></div>

      <hr />

      <div>ペナルティ：<b>{penaltyDisplay}</b></div>
      <div className="hint">内訳：時間{timePenalty}点{cpPenalty>0 ? ` / CP未達${cpPenalty}点（未達${missingCpCount}）` : ''}</div>
      <div className="hint">※ペナルティ：早着（終了15分以上前）/遅刻は、秒を切り捨てて分換算し、1分=1点で減点。</div>

      <hr />

      <div>訪問スポット数：{progress.visitedSpotIds.length}</div>
      {visitedSpotNames.length > 0 && (
        <ul>
          {visitedSpotNames.map((name, idx) => (
            <li key={`${idx}-${name}`}>{name}</li>
          ))}
        </ul>
      )}

      <div>CP達成数：{reachedCpNames.length}</div>
      {reachedCpNames.length > 0 && (
        <ul>
          {reachedCpNames.map((name, idx) => (
            <li key={`${idx}-${name}`}>{name}</li>
          ))}
        </ul>
      )}

      <div>JRイベント数：{progress.visitedStationEvents.length}</div>
      {progress.visitedStationEvents.length > 0 && (
        <div className="hint" style={{ marginTop: 6 }}>
          <div>乗車駅：{boardNames.length ? boardNames.join('、') : 'なし'}</div>
          <div>降車駅：{alightNames.length ? alightNames.join('、') : 'なし'}</div>
          <div>通過駅：{passNames.length ? passNames.join('、') : 'なし'}</div>
        </div>
      )}

      <hr />

      <div>実績解除ボーナス：<b>+{progress.achievementBonus ?? 0}</b></div>
      {(progress.achievementUnlocked && progress.achievementUnlocked.length > 0) ? (
        <ul>
          {progress.achievementUnlocked.map((a, idx) => (
            <li key={`${idx}-${a.id}`}>{a.name}（+{a.points}）</li>
          ))}
        </ul>
      ) : (
        <div className="hint">このゲームで解除された実績はありません。</div>
      )}

      {kpiUiEnabled && kpiDecision === 'undecided' && (
        <div className="hint" style={{ marginTop: 10 }}>
          <div>
            画面を移動する際、チェックがONならリザルトを送信します（個人が特定される情報は送信しません）。
          </div>
          <label style={{ display: 'block', marginTop: 6 }}>
            <input
              type="checkbox"
              checked={kpiConsent}
              onChange={(e) => setKpiConsent(e.target.checked)}
              disabled={kpiSending}
            />{' '}
            同意する
          </label>
        </div>
      )}

      <div className="actions">
        <button className="btn" onClick={() => void leaveTo('/')}>ホーム</button>
        <button className="btn primary" onClick={() => void leaveTo('/setup')}>新規（設定へ）</button>
      </div>
    </div>
  );
}
