import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { loadGame } from '../db/repo';
import { useGameStore } from '../store/gameStore';

export default function ResultPage() {
  const nav = useNavigate();
  const progress = useGameStore(s=>s.progress);
  const setProgress = useGameStore(s=>s.setProgress);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      const g = progress ?? await loadGame();
      if (!g || !g.endedAtMs) { nav('/'); return; }
      setProgress(g);
      setLoaded(true);
    })();
  }, [nav, progress, setProgress]);

  if (!loaded || !progress) return <div className="card">読込中...</div>;

  return (
    <div className="card">
      <h3>リザルト</h3>
      <div>スコア：<b>{progress.score}</b></div>
      <div>ペナルティ：{progress.penalty}</div>
      <div className="hint">※ペナルティ：早着（終了15分以上前）/遅刻は、秒を切り捨てて分換算し、1分=1点で減点。</div>
      <hr />
      <div>訪問スポット数：{progress.visitedSpotIds.length}</div>
      <div>CP達成：{progress.reachedCpIds.length}/{progress.cpSpotIds.length}</div>
      <div>JRイベント：{progress.visitedStationEvents.length}</div>
      <hr />
      <div className="actions">
        <Link className="btn" to="/">ホーム</Link>
        <Link className="btn primary" to="/setup">新規（設定へ）</Link>
      </div>
    </div>
  );
}
