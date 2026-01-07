import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { attachMap, parkMap } from '../map/mapSingleton';
import type { GameConfig, LatLng, Spot } from '../types';
import { getJudgeTargetSpots, saveGame } from '../db/repo';
import { useToast } from '../hooks/useToast';
import { useOnline } from '../hooks/useOnline';
import { getCurrentFix } from '../logic/location';
import { resolveStartGoal, useGameStore } from '../store/gameStore';
import { filterCpPoolByCity, selectCpSpotsMVP, startNewGame } from '../logic/game';
import { syncMasterDataIfNeeded } from '../logic/dataSync';

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function findNearestSpotName(lat: number, lng: number, spots: Spot[]): string | null {
  let best: Spot | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const s of spots) {
    const d = haversineM(lat, lng, s.lat, s.lng);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best?.name ?? null;
}

function formatDuration(min: number) {
  if (!Number.isFinite(min)) return '';
  if (min % 60 === 0) return `${min / 60}時間`;
  return `${min}分`;
}

const durationOptions = Array.from({ length: 48 }, (_, i) => (i + 1) * 15); // 15..720

export default function SetupPage() {
  const nav = useNavigate();
  const online = useOnline();
  const { show, Toast } = useToast();
  const setProgress = useGameStore((s) => s.setProgress);

  const [config, setConfig] = useState<GameConfig>({
    durationMin: 180,
    jrEnabled: false,
    cpCount: 0,
    cityFilter: { ibusuki: true, minamikyushu: true, makurazaki: true },
    start: undefined,
    goal: undefined,
  });

  const [isConfirming, setIsConfirming] = useState(false);

  const mapEl = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const clickListenerRef = useRef<google.maps.MapsEventListener | null>(null);
  const startMarkerRef = useRef<any>(null);
  const goalMarkerRef = useRef<any>(null);

  const [judgeSpots, setJudgeSpots] = useState<Spot[]>([]);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    (async () => {
      const spots = await getJudgeTargetSpots();
      setJudgeSpots(spots);
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        if (!mapEl.current) return;

        const center = { lat: 31.2, lng: 130.5 };
        const mapId = (import.meta.env.VITE_GOOGLE_MAP_ID as string) || undefined;

        const map = await attachMap(mapEl.current, {
          center,
          zoom: 11,
          ...(mapId ? { mapId } : {}),
          fullscreenControl: false, // 全画面ボタン非表示
          mapTypeControl: false, // 地図/航空写真ボタン非表示
        });
        mapRef.current = map;

        // click to set start then goal (toggle by state)
        if (clickListenerRef.current) {
          try {
            clickListenerRef.current.remove();
          } catch {
            /* noop */
          }
          clickListenerRef.current = null;
        }
        clickListenerRef.current = map.addListener('click', (e: google.maps.MapMouseEvent) => {
          if (!e.latLng) return;
          const ll = { lat: e.latLng.lat(), lng: e.latLng.lng() };
          setConfig((c) => {
            // if start not set or both set, set start; else set goal
            const next = { ...c };
            if (!c.start || (c.start && c.goal)) {
              next.start = ll;
              next.goal = c.goal; // keep
            } else {
              next.goal = ll;
            }
            return next;
          });
        });
      } catch (e: any) {
        show(e?.message ?? String(e), 6000);
      }
    })();

    const cityLabels: string[] = [];
  if (config.cityFilter?.ibusuki) cityLabels.push('指宿市');
  if (config.cityFilter?.minamikyushu) cityLabels.push('南九州市');
  if (config.cityFilter?.makurazaki) cityLabels.push('枕崎市');
  const cpRegionLabel = cityLabels.length ? cityLabels.join('、') : '指定なし';

  const startLabel = (() => {
    if (!config.start) return '現在地';
    const nm = judgeSpots.length ? findNearestSpotName(config.start.lat, config.start.lng, judgeSpots) : null;
    return nm ? `${nm}付近` : '地図指定';
  })();

  const goalLabel = (() => {
    if (!config.goal) return '現在地';
    const nm = judgeSpots.length ? findNearestSpotName(config.goal.lat, config.goal.lng, judgeSpots) : null;
    return nm ? `${nm}付近` : '地図指定';
  })();

  return () => {
      if (clickListenerRef.current) {
        try {
          clickListenerRef.current.remove();
        } catch {
          /* noop */
        }
        clickListenerRef.current = null;
      }
      // Keep the single map instance alive across routes.
      parkMap();
    };
  }, [show]);

  useEffect(() => {
    // update markers
    const map = mapRef.current;
    if (!map) return;
    // AdvancedMarker might be available under google.maps.marker.AdvancedMarkerElement
    const AdvancedMarker = (google.maps as any).marker?.AdvancedMarkerElement;

    const up = (kind: 'start' | 'goal', pos?: LatLng) => {
      const ref = kind === 'start' ? startMarkerRef : goalMarkerRef;
      if (!pos) {
        if (ref.current) {
          ref.current.map = null;
          ref.current = null;
        }
        return;
      }
      if (!AdvancedMarker) return;
      if (!ref.current) {
        const el = document.createElement('div');
        el.style.padding = '6px 8px';
        el.style.borderRadius = '999px';
        el.style.border = '1px solid rgba(0,0,0,.2)';
        el.style.background = 'rgba(255,255,255,.95)';
        el.style.fontSize = '12px';
        el.textContent = kind === 'start' ? 'START' : 'GOAL';
        el.style.cursor = 'grab';
        ref.current = new AdvancedMarker({ map, position: pos, content: el, gmpDraggable: true });
        // drag & drop to fine-tune start/goal position
        ref.current.addListener('dragend', (ev: any) => {
          const latLng = ev?.latLng;
          const lat = typeof latLng?.lat === 'function' ? latLng.lat() : latLng?.lat;
          const lng = typeof latLng?.lng === 'function' ? latLng.lng() : latLng?.lng;
          if (typeof lat !== 'number' || typeof lng !== 'number') return;
          const ll: LatLng = { lat, lng };
          if (kind === 'start') setConfig((c) => ({ ...c, start: ll }));
          else setConfig((c) => ({ ...c, goal: ll }));
        });
      } else {
        ref.current.position = pos;
        ref.current.map = map;
      }
    };
    up('start', config.start);
    up('goal', config.goal);
  }, [config.start, config.goal]);

  // cleanup start/goal markers on unmount (map is shared across routes)
  useEffect(() => {
    return () => {
      if (startMarkerRef.current) {
        try {
          startMarkerRef.current.map = null;
        } catch {
          /* noop */
        }
        startMarkerRef.current = null;
      }
      if (goalMarkerRef.current) {
        try {
          goalMarkerRef.current.map = null;
        } catch {
          /* noop */
        }
        goalMarkerRef.current = null;
      }
    };
  }, []);

  const onUseCurrentForStartGoal = async () => {
    try {
      const fix = await getCurrentFix();
      setConfig((c) => ({ ...c, start: { lat: fix.lat, lng: fix.lng }, goal: { lat: fix.lat, lng: fix.lng } }));
      show('現在地をスタート/ゴールに設定しました。');
      mapRef.current?.setCenter({ lat: fix.lat, lng: fix.lng });
      mapRef.current?.setZoom(14);
    } catch (e: any) {
      show(e?.message ?? '位置情報を取得できません。', 4500);
    }
  };

  const canStart = online && !syncing;

  const onStartGame = async () => {
    if (!online) return show('オフライン/圏外では開始できません。オンラインにして再試行してください。', 4500);

    // 方式C: ゲーム開始時にマップデータを自動更新（差分があれば全件上書き）
    setSyncing(true);
    try {
      const sync = await syncMasterDataIfNeeded();
      if (sync.status === 'failed' && !sync.canProceed) {
        show(sync.message ?? 'マップデータの取得に失敗しました。オンライン接続を確認して再試行してください。', 6000);
        return;
      }
      if (sync.message) show(sync.message, 3500);

      // Pull latest judge-target spots (in case sync overwrote DB)
      const spotsForCp = await getJudgeTargetSpots();
      setJudgeSpots(spotsForCp);
      if (spotsForCp.length === 0) {
        show('スポットデータがありません。CSVが正しく配置されているか確認してください。', 6000);
        return;
      }

      // resolve start/goal
      let current: LatLng = { lat: 31.2, lng: 130.5 };
      try {
        const fix = await getCurrentFix();
        current = { lat: fix.lat, lng: fix.lng };
      } catch {
        // ok: if not available, keep fallback center
      }
      const resolved = resolveStartGoal(config, current);

      // CP selection (MVP)
      const cpPool = filterCpPoolByCity(spotsForCp, resolved);
      if (resolved.cpCount > 0 && cpPool.length === 0) {
        show('選択した地域にCP候補スポットがありません（住所に市名が含まれないスポットは除外されます）。地域選択またはスポットデータを確認してください。', 6000);
        return;
      }
      const cpIds = selectCpSpotsMVP(cpPool, resolved);
      const progress = startNewGame(resolved, cpIds);
      await saveGame(progress);
      setProgress(progress);
      nav('/play');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <>
      <div className="card">
        <h3>開始設定</h3>
        {!online && <div className="banner">オフライン/圏外のため開始できません。オンラインにしてください。</div>}
        <div className="row">
          <div className="col">
            <label className="hint">制限時間（15分刻み）</label>
            <select
              className="input"
              value={config.durationMin}
              onChange={(e) => setConfig((c) => ({ ...c, durationMin: Number(e.target.value) }))}
            >
              {durationOptions.map((m) => (
                <option key={m} value={m}>
                  {m}分
                </option>
              ))}
            </select>
          </div>
          <div className="col">
            <label className="hint">CP数（0〜5）</label>
            <select
              className="input"
              value={config.cpCount}
              onChange={(e) => setConfig((c) => ({ ...c, cpCount: Number(e.target.value) }))}
            >
              {[0, 1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <div className="hint">CP=1〜2は「なるべくスタート〜ゴール間」。CP≥3は完全ランダム。</div>
          </div>
          <div className="col">
            <label className="hint">CP地域（チェックした地域から選定）</label>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 4 }}>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={config.cityFilter?.ibusuki ?? true}
                  onChange={(e) =>
                    setConfig((c) => ({
                      ...c,
                      cityFilter: {
                        ibusuki: e.target.checked,
                        minamikyushu: c.cityFilter?.minamikyushu ?? true,
                        makurazaki: c.cityFilter?.makurazaki ?? true,
                      },
                    }))
                  }
                />
                指宿市
              </label>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={config.cityFilter?.minamikyushu ?? true}
                  onChange={(e) =>
                    setConfig((c) => ({
                      ...c,
                      cityFilter: {
                        ibusuki: c.cityFilter?.ibusuki ?? true,
                        minamikyushu: e.target.checked,
                        makurazaki: c.cityFilter?.makurazaki ?? true,
                      },
                    }))
                  }
                />
                南九州市
              </label>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={config.cityFilter?.makurazaki ?? true}
                  onChange={(e) =>
                    setConfig((c) => ({
                      ...c,
                      cityFilter: {
                        ibusuki: c.cityFilter?.ibusuki ?? true,
                        minamikyushu: c.cityFilter?.minamikyushu ?? true,
                        makurazaki: e.target.checked,
                      },
                    }))
                  }
                />
                枕崎市
              </label>
            
        {isConfirming && (
          <>
            <div style={{ height: 12 }} />
            <div className="card">
              <h3>設定内容の確認</h3>
              <div className="row" style={{ flexDirection: 'column', gap: 6 }}>
                <div>制限時間：{formatDuration(config.durationMin)}</div>
                <div>CP数：{config.cpCount}</div>
                <div>CP地域：{cpRegionLabel}</div>
                <div>JR使用：{config.jrEnabled ? 'ON' : 'OFF'}</div>
                <div>スタート：{startLabel}</div>
                <div>ゴール：{goalLabel}</div>
              </div>
              <div style={{ height: 10 }} />
              <div className="actions">
                <button
                  className="btn primary"
                  onClick={async () => {
                    setIsConfirming(false);
                    await onStartGame();
                  }}
                  disabled={!canStart}
                >
                  開始
                </button>
                <button className="btn" onClick={() => setIsConfirming(false)}>
                  修正
                </button>
              </div>
            </div>
          </>
        )}

        </div>
            <div className="hint">※スポット住所に市名が含まれない場合は除外されます</div>
          </div>
          <div className="col">
            <label className="hint">JR使用</label>
            <select
              className="input"
              value={config.jrEnabled ? 'on' : 'off'}
              onChange={(e) => setConfig((c) => ({ ...c, jrEnabled: e.target.value === 'on' }))}
            >
              <option value="off">OFF</option>
              <option value="on">ON</option>
            </select>
            <div className="hint">JR=ONのとき、駅チェックインが有効になります。</div>
          </div>
        </div>

        <div style={{ height: 10 }} />
        <div className="actions">
          <button className="btn" onClick={onUseCurrentForStartGoal} disabled={syncing}>
            現在地をスタート/ゴールにする
          </button>
          <button className="btn primary" onClick={() => setIsConfirming(true)} disabled={!canStart}>
            {syncing ? 'データ確認中...' : '開始'}
          </button>
        </div>
        <div className="hint" style={{ marginTop: 10 }}>
          ・地図をタップして START / GOAL を設定（未指定なら開始時に現在地が採用されます）
        </div>
      </div>

      <div style={{ height: 12 }} />
      <div className="card">
        <h3>スタート/ゴール指定（地図）</h3>
        <div className="mapWrap" ref={mapEl} />
      </div>
      {Toast}
    </>
  );
}
