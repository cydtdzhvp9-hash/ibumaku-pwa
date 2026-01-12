import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getAllSpots, getStationsByOrder, loadGame } from '../db/repo';
import { calcPenalty } from '../logic/game';
import { buildKpiPayloadV1, sendKpiPayload } from '../logic/kpi';
import { useGameStore } from '../store/gameStore';
import type { Spot, Station } from '../types';

export default function ResultPage() {
  const nav = useNavigate();
  const progress = useGameStore(s=>s.progress);
  const setProgress = useGameStore(s=>s.setProgress);
  const [loaded, setLoaded] = useState(false);
  const [spots, setSpots] = useState<Spot[]>([]);
  const [stations, setStations] = useState<Station[]>([]);
  const [shareOk, setShareOk] = useState(false);
  const [kpiStatus, setKpiStatus] = useState<'idle'|'sending'|'sent'|'error'>('idle');
  const [kpiError, setKpiError] = useState<string>('');

  useEffect(() => {
    (async () => {
      const g = progress ?? await loadGame();
      if (!g || !g.endedAtMs) { nav('/'); return; }
      if ((g as any).endReason === 'ABANDONED') { nav('/'); return; }
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

  if (!loaded || !progress) return <div className="card">読込中...</div>;

  const kpiUiEnabled = (import.meta.env.VITE_KPI_ENABLED === '1') && !!import.meta.env.VITE_KPI_ENDPOINT_URL;

  const onSendKpi = async () => {
    if (!kpiUiEnabled) return;
    if (!navigator.onLine) {
      setKpiStatus('error');
      setKpiError('オフラインのため送信できません。通信状況を確認して再度お試しください。');
      return;
    }
    try {
      setKpiError('');
      setKpiStatus('sending');
      const payload = buildKpiPayloadV1(progress, spots, shareOk);
      await sendKpiPayload(payload);
      setKpiStatus('sent');
    } catch (e: any) {
      setKpiStatus('error');
      setKpiError(e?.message ?? String(e));
    }
  };

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

      {kpiUiEnabled && (
        <>
          <hr />
          <h4 style={{ margin: '10px 0 6px' }}>リザルト送信（KPI集計）</h4>
          <div className="hint">
            送信する内容：スコア／ペナルティ／訪問数／CP達成／JRイベント数／実績解除（ID）など（個人が特定される情報は送信しません）。
            共有OKを選択した場合のみ、共有用の集計表に反映されます。
          </div>
          <label style={{ display: 'block', marginTop: 6 }}>
            <input
              type="checkbox"
              checked={shareOk}
              onChange={(e) => setShareOk(e.target.checked)}
              disabled={kpiStatus === 'sending'}
            />{' '}
            集計結果の共有に同意する（共有OK）
          </label>
          <div className="actions" style={{ marginTop: 8 }}>
            <button
              className="btn"
              onClick={onSendKpi}
              disabled={kpiStatus === 'sending' || kpiStatus === 'sent'}
            >
              {kpiStatus === 'sent' ? '送信済み' : (kpiStatus === 'sending' ? '送信中...' : '送信')}
            </button>
          </div>
          {kpiStatus === 'sent' && <div className="hint">送信しました。ご協力ありがとうございます。</div>}
          {kpiStatus === 'error' && <div className="hint" style={{ color: '#b00' }}>送信失敗：{kpiError}</div>}
        </>
      )}
      <hr />
      <div className="actions">
        <Link className="btn" to="/">ホーム</Link>
        <Link className="btn primary" to="/setup">新規（設定へ）</Link>
      </div>
    </div>
  );
}
