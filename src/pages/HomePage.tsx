import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { clearGame, loadGame, saveGame } from '../db/repo';
import { useGameStore } from '../store/gameStore';
import { useToast } from '../hooks/useToast';

export default function HomePage() {
  const nav = useNavigate();
  const { show, Toast } = useToast();
  const setProgress = useGameStore(s => s.setProgress);
  const [hasGame, setHasGame] = useState(false);

  useEffect(() => {
    (async () => {
      const g = await loadGame();
      if (!g) {
        setHasGame(false);
        return;
      }

      // If overtime grace has expired, treat as abandoned (no result / no resume)
      if (!g.endedAtMs) {
        const plannedEnd = g.startedAtMs + g.config.durationMin * 60_000;
        const graceEnd = plannedEnd + 60 * 60_000;
        const now = Date.now();
        if (now > graceEnd) {
          const abandoned = { ...g, endedAtMs: now, endReason: 'ABANDONED' as const };
          await saveGame(abandoned);
          setProgress(abandoned);
          setHasGame(false);
          show('タイムアップから1時間を超えたため、途中離脱扱いでゲーム終了しました。');
          return;
        }
      }

      // Resume is allowed only when the game is not ended.
      setHasGame(!g.endedAtMs);
      setProgress(g);
    })();
  }, [setProgress, show]);

  const onResume = async () => {
    const g = await loadGame();
    if (!g) return show('途中データがありません。');
    if (g.endedAtMs) return show('ゲームは終了しています。新規で開始してください。');
    setProgress(g);
    nav('/play');
  };

  const onNew = async () => {
    const g = await loadGame();
    if (g) {
      if (!g.endedAtMs) {
        const ok = window.confirm('ゲーム途中のデータがあります。新規を開始すると途中データは消えます。よろしいですか？');
        if (!ok) return;
      }
      await clearGame();
      setProgress(undefined);
      show('途中データを削除しました。');
    }
    nav('/setup');
  };

  return (
    <>
      <div className="card">
        <h3>ホーム</h3>
        <p className="hint">MVP：新規開始（または再開） → プレイ → リザルト</p>
        <div className="actions">
          <button className="btn primary" onClick={onNew}>新規</button>
          <button className="btn" onClick={onResume} disabled={!hasGame}>再開</button>
          <Link className="btn" to="/result">結果表示</Link>
          <Link className="btn" to="/achievements">実績確認</Link>
        </div>
        <hr />
        <div className="hint">
          <div>・開始時はオンライン必須（オフライン/圏外では開始できません）</div>
          <div>・チェックインは「50m以内」かつ「accuracy≦100m」</div>
        </div>
      </div>
      {Toast}
    </>
  );
}
