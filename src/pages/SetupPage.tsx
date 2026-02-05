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
    const d = haversineM(lat, lng, s.Latitude, s.Longitude);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best?.Name ?? null;
}

function formatDuration(min: number) {
  if (!Number.isFinite(min)) return '';
  if (min % 60 === 0) return `${min / 60}時間`;
  return `${min}分`;
}

function ConfirmModal(props: {
  open: boolean;
  title?: string;
  children: React.ReactNode;
  primaryLabel: string;
  primaryDisabled?: boolean;
  onPrimary: () => void | Promise<void>;
  secondaryLabel: string;
  onSecondary: () => void;
}) {
  if (!props.open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={props.title ?? '確認'}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        zIndex: 9999,
      }}
      // 背景のクリック/操作を遮断する（閉じる操作はボタンのみ）
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
      }}
      onMouseDown={(e) => {
        e.stopPropagation();
        e.preventDefault();
      }}
    >
      <div
        className="card"
        style={{
          width: 'min(520px, 100%)',
          maxHeight: 'min(80vh, 640px)',
          overflow: 'auto',
        }}
      >
        <h3>{props.title ?? '確認'}</h3>
        {props.children}
        <div style={{ height: 10 }} />
        <div className="actions">
          <button
            className="btn primary"
            onClick={props.onPrimary}
            disabled={props.primaryDisabled}
          >
            {props.primaryLabel}
          </button>
          <button className="btn" onClick={props.onSecondary}>
            {props.secondaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
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

  const canStart = online && !syncing;

  
  // 初回: 位置情報が取得できたら現在地に START/GOAL を自動配置（GOALは最大5m以内で少しずらす）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // すでに指定済みなら何もしない
      if (config.start && config.goal) return;

      try {
        const fix = await getCurrentFix();
        if (cancelled) return;

        const start = config.start ?? { lat: fix.lat, lng: fix.lng };

        // 5m以内で東方向にずらす（掴みやすさのため）
        const meters = 4; // <= 5m
        const dLng = meters / (111320 * Math.cos((start.lat * Math.PI) / 180));
        const goal = config.goal ?? { lat: start.lat, lng: start.lng + dLng };

        setConfig((c) => {
          // 途中でユーザーが操作した可能性があるため再確認
          if (c.start && c.goal) return c;
          return { ...c, start: c.start ?? start, goal: c.goal ?? goal };
        });

        mapRef.current?.setCenter({ lat: start.lat, lng: start.lng });
        mapRef.current?.setZoom(14);
      } catch {
        // 位置情報が取得できない/許可されない場合は何もしない（既存の挙動に合わせる）
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [config.start, config.goal]);


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
        <fieldset disabled={isConfirming || syncing} style={{ border: 'none', padding: 0, margin: 0 }}>
          <div className="row">
            <div className="col">
              <label className="hint">制限時間（15分刻み）</label>
              <select
                className="input"
                value={config.durationMin}
                onChange={(e) => setConfig((c) => ({ ...c, durationMin: Number(e.target.value) }))}
              >
                <option key="unlimited" value={0}>無制限</option>
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
            <button className="btn primary" onClick={() => setIsConfirming(true)} disabled={!canStart}>
              {syncing ? 'データ確認中...' : '次へ'}
            </button>
          </div>
          <div className="hint" style={{ marginTop: 10 }}>
            ・開始設定画面で位置情報が取得できたら、現在地に START / GOAL が表示されます（ドラッグで調整できます）
          </div>
        </fieldset>
      </div>

      <div style={{ height: 12 }} />
      <div className="card">
        <h3>スタート/ゴール指定（地図）</h3>
        <div className="mapWrap" ref={mapEl} />
      </div>

      <ConfirmModal
        open={isConfirming}
        title="設定内容の確認"
        primaryLabel="ゲーム開始"
        primaryDisabled={!canStart}
        onPrimary={async () => {
          setIsConfirming(false);
          await onStartGame();
        }}
        secondaryLabel="戻る（修正）"
        onSecondary={() => setIsConfirming(false)}
      >
        <div className="row" style={{ flexDirection: 'column', gap: 6 }}>
          <div>制限時間：{formatDuration(config.durationMin)}</div>
          <div>CP数：{config.cpCount}</div>
          <div>CP地域：{cpRegionLabel}</div>
          <div>JR使用：{config.jrEnabled ? 'ON' : 'OFF'}</div>
          <div>スタート：{startLabel}</div>
          <div>ゴール：{goalLabel}</div>
        </div>
        <div className="hint" style={{ marginTop: 10 }}>
          ※確認中は設定を変更できません。修正する場合は「戻る（修正）」を選択してください。
        </div>
      </ConfirmModal>
      {Toast}
    </>
  );
}
