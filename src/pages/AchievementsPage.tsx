import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getJudgeTargetSpots } from '../db/repo';
import type { Spot } from '../types';
import {
  achievementDisplayMeta,
  ensureRecordsForCumulative,
  isInactiveNow,
  loadAchievementRecords,
} from '../logic/achievements';

export default function AchievementsPage() {
  const nav = useNavigate();
  const [loaded, setLoaded] = useState(false);
  const [judgeSpots, setJudgeSpots] = useState<Spot[]>([]);
  const [records, setRecords] = useState(() => loadAchievementRecords());

  // Load ever visited spot ids
  const everVisited = useMemo(() => {
    const key = 'ibumaku_everVisitedSpotIds_v1';
    try {
      const raw = localStorage.getItem(key);
      const arr = raw ? JSON.parse(raw) : [];
      if (Array.isArray(arr)) return new Set(arr.filter((x) => typeof x === 'string'));
      return new Set<string>();
    } catch {
      return new Set<string>();
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const spots = await getJudgeTargetSpots();
        setJudgeSpots(spots);
        // Ensure cumulative achievements are recorded (record only, no scoring)
        ensureRecordsForCumulative(everVisited, spots, Date.now());
        setRecords(loadAchievementRecords());
      } catch {
        // ignore
      } finally {
        setLoaded(true);
      }
    })();
  }, [everVisited]);

  const viewRows = useMemo(() => {
    const out = records
      .slice()
      .sort((a, b) => (b.lastUnlockedAtMs - a.lastUnlockedAtMs) || (b.firstUnlockedAtMs - a.firstUnlockedAtMs))
      .map((r) => {
        const meta = achievementDisplayMeta(r.id, judgeSpots);
        const inactive = isInactiveNow(r.id, everVisited, judgeSpots);
        return { ...r, name: meta.name, pointsHint: meta.pointsHint, inactive };
      });
    return out;
  }, [records, judgeSpots, everVisited]);

  if (!loaded) return <div className="card">読込中...</div>;

  return (
    <div className="card">
      <h3>実績確認</h3>

      <div className="hint">
        ・解除済みの実績のみ表示します（未解除は表示しません）。<br />
        ・スポット台帳（CSV）変更により、現在の条件を満たさなくなった実績は薄い文字で表示します。<br />
        ・加点は「1ゲーム内で達成した実績」のみ対象です（累積達成は記録のみ）。
      </div>

      <hr />

      {viewRows.length === 0 ? (
        <div>解除済みの実績はありません。</div>
      ) : (
        <ul>
          {viewRows.map((r) => (
            <li key={r.id} style={{ color: r.inactive ? '#999' : undefined, marginBottom: 8 }}>
              <div><b>{r.name}</b></div>
              <div className="hint">
                {r.pointsHint ? `${r.pointsHint} / ` : ''}
                解除回数：{r.unlockCount} / 初回：{new Date(r.firstUnlockedAtMs).toLocaleString()} / 最終：{new Date(r.lastUnlockedAtMs).toLocaleString()}
              </div>
            </li>
          ))}
        </ul>
      )}

      <hr />

      <div className="actions">
        <button className="btn" onClick={() => nav(-1)}>戻る</button>
        <Link className="btn" to="/">ホーム</Link>
      </div>
    </div>
  );
}
