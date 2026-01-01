import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { clearGame, loadGame } from '../db/repo';
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
      setHasGame(!!g);
      if (g) setProgress(g);
    })();
  }, [setProgress]);

  const onResume = async () => {
    const g = await loadGame();
    if (!g) return show('途中データがありません。');
    setProgress(g);
    nav('/play');
  };

  const onNew = async () => {
    const g = await loadGame();
    if (g) {
      const ok = window.confirm('ゲーム途中のデータがあります。新規を開始すると途中データは消えます。よろしいですか？');
      if (!ok) return;
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
        <p className="hint">MVP：CSV取込 → 新規開始（または再開） → プレイ → リザルト</p>
        <div className="actions">
          <button className="btn primary" onClick={onNew}>新規</button>
          <button className="btn" onClick={onResume} disabled={!hasGame}>再開</button>
          <Link className="btn" to="/admin/import">CSV取込</Link>
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
