import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { attachMap, parkMap, getMap } from '../map/mapSingleton';
import { getJudgeTargetSpots, getStationsByOrder, loadGame, saveGame } from '../db/repo';
import type { Spot, Station } from '../types';
import { haversineMeters } from '../utils/geo';
import { useGameStore } from '../store/gameStore';
import { useOnline } from '../hooks/useOnline';
import { getCurrentFix } from '../logic/location';
import {
  CHECKIN_RADIUS_M,
  JR_COOLDOWN_SEC,
  MAX_ACCURACY_M,
  checkInSpotOrCp,
  goalCheckIn,
  jrAlight,
  jrBoard,
} from '../logic/game';
import { MarkerClusterer } from '@googlemaps/markerclusterer';

// もし環境により `google` 型が解決されない場合の保険（あっても害は少ない）
declare const google: any;

export default function PlayPage() {
  const nav = useNavigate();
  const online = useOnline();

  const progress = useGameStore((s) => s.progress);
  const setProgress = useGameStore((s) => s.setProgress);
  const remainingSec = useGameStore((s) => s.remainingSec);

  // Keep latest progress accessible from effects without re-running map init
  const progressRef = useRef(progress);
  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  const startCenterAppliedRef = useRef(false);

  const [spots, setSpots] = useState<Spot[]>([]);
  const [stations, setStations] = useState<Station[]>([]);
  const [checkInBusy, setCheckInBusy] = useState(false);

  // Map attach 完了をフックして marker 描画を再実行するためのトリガ。
  // 再開時に progress/spots が先に復元され、mapRef が後から作られると
  // marker 描画 useEffect が 1 回も走らず、START/GOAL/CP/スポットが表示されないことがある。
  const [mapReadyNonce, setMapReadyNonce] = useState(0);

  // ===== Debug Tools gate =====
  const DEBUG_TOOLS = useMemo(() => {
    const q = new URLSearchParams(window.location.search);
    const enabledByQuery = q.get('debug') === '1';
    const gate = (import.meta.env.VITE_DEBUG_TOOLS as string | undefined) ?? '1';
    return gate !== '0' && ((import.meta as any).env?.DEV || enabledByQuery);
  }, []);

  // ===== Debug UI state =====
  const [useVirtualLoc, setUseVirtualLoc] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const useVirtualRef = useRef(false); // 「関数内で最新値を参照」用

  useEffect(() => {
    useVirtualRef.current = useVirtualLoc;
  }, [useVirtualLoc]);

  // ===== Event Log =====
  type LogEntry = { atMs: number; type: string; message: string; data?: any };
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const pushLog = (type: string, message: string, data?: any) => {
    if (!DEBUG_TOOLS) return;
    const entry: LogEntry = { atMs: Date.now(), type, message, data };
    setLogs((prev) => [entry, ...prev].slice(0, 400));
    // eslint-disable-next-line no-console
    console.log('[DBG]', type, message, data ?? '');
  };


// ===== User Notice Toast (本番用) =====
type NoticeKind = 'success' | 'info' | 'warning' | 'error';
type NoticeEntry = { id: string; atMs: number; kind: NoticeKind; message: string };

const [notices, setNotices] = useState<NoticeEntry[]>([]);
const [toastVisible, setToastVisible] = useState(false);
const [noticeOpen, setNoticeOpen] = useState(false);
const noticeOpenRef = useRef(false);
useEffect(() => {
  noticeOpenRef.current = noticeOpen;
}, [noticeOpen]);

const toastTimerRef = useRef<number | null>(null);
const closeNotice = () => {
  if (toastTimerRef.current != null) {
    window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = null;
  }
  setToastVisible(false);
  setNoticeOpen(false);
};

const pushNotice = (kind: NoticeKind, message: string, durationMs?: number) => {
  const entry: NoticeEntry = { id: `${Date.now()}_${Math.random().toString(16).slice(2)}`, atMs: Date.now(), kind, message };
  setNotices((prev) => [entry, ...prev].slice(0, 200));
  setToastVisible(true);

  // auto close
  if (toastTimerRef.current != null) {
    window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = null;
  }
  const ms = durationMs ?? (kind === 'error' ? 4000 : kind === 'success' ? 2800 : 3500);
  if (ms > 0) {
    toastTimerRef.current = window.setTimeout(() => {
      // 履歴を開いている間は消さない
      if (noticeOpenRef.current) return;
      setToastVisible(false);
    }, ms);
  }
};

const fmtDelta = (d: number) => (d >= 0 ? `+${d}` : `${d}`);
const findSpotById = (id: string) => spots.find((s) => s.ID === id);

const findNearestStation = (loc: { lat: number; lng: number }) => {
  let best: { st: Station; d: number } | null = null;
  for (const st of stations) {
    const d = haversineMeters(loc, { lat: st.lat, lng: st.lng });
    if (d > CHECKIN_RADIUS_M) continue;
    if (!best || d < best.d || (d === best.d && st.stationId < best.st.stationId)) {
      best = { st, d };
    }
  }
  return best?.st;
};

  // ===== Persistent visited marker (⭐️) =====
  const EVER_VISITED_SPOT_KEY = 'ibumaku_everVisitedSpotIds_v1';
  const everVisitedSpotIdsRef = useRef<Set<string>>(new Set());

  const loadEverVisitedSpots = () => {
    try {
      const raw = localStorage.getItem(EVER_VISITED_SPOT_KEY);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        everVisitedSpotIdsRef.current = new Set(arr.filter((x) => typeof x === 'string'));
      }
    } catch {
      // ignore
    }
  };

  const saveEverVisitedSpots = () => {
    try {
      const arr = Array.from(everVisitedSpotIdsRef.current);
      localStorage.setItem(EVER_VISITED_SPOT_KEY, JSON.stringify(arr));
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    loadEverVisitedSpots();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ===== Refs =====
  const mapEl = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const clustererRef = useRef<MarkerClusterer | null>(null);
  const markersRef = useRef<any[]>([]);
  const cpDragListenersRef = useRef<any[]>([]);
  const infoWindowRef = useRef<any>(null);

  // Current location (display + recenter)
  const lastGeoRef = useRef<{ lat: number; lng: number } | null>(null);
  const lastFixRef = useRef<{ lat: number; lng: number; accuracy: number; ts: number } | null>(null);
  const userMarkerRef = useRef<any>(null);
  const geoWatchIdRef = useRef<number | null>(null);

  // Virtual location
  const virtualFixRef = useRef<{ lat: number; lng: number; accuracy: number } | null>(null);
  const virtualMarkerRef = useRef<any>(null);
  const mapClickListenerRef = useRef<any>(null);

  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  // ===== helpers =====
  const normPos = (pos: any): { lat: number; lng: number } | null => {
    if (!pos) return null;
    if (typeof pos.lat === 'function' && typeof pos.lng === 'function') return { lat: pos.lat(), lng: pos.lng() };
    if (typeof pos.lat === 'number' && typeof pos.lng === 'number') return { lat: pos.lat, lng: pos.lng };
    if (pos.latLng && typeof pos.latLng.lat === 'function') return { lat: pos.latLng.lat(), lng: pos.latLng.lng() };
    return null;
  };

const applyProgressUpdate = (p: any, msg: string, logType?: string, logData?: any) => {
  setProgress(p);
  if (logType) pushLog(logType, msg, logData);
  void saveGame(p).catch(() => {
    // eslint-disable-next-line no-console
    console.warn('saveGame failed');
  });
};

  const abandonGameNow = async () => {
    if (!progress) return;
    const now = Date.now();
    const abandoned = { ...progress, endedAtMs: now, endReason: 'ABANDONED' as const };
    setProgress(abandoned);
    await saveGame(abandoned);
    pushLog('ABANDONED', '途中離脱扱いでゲーム終了', { now });
    pushNotice('error', 'タイムアップから1時間を超えたため、途中離脱扱いでゲーム終了しました。', 6000);
    nav('/');
  };

  const upsertUserMarker = (map: any, pos: { lat: number; lng: number }) => {
    if (!userMarkerRef.current) {
      userMarkerRef.current = new google.maps.Marker({
        map,
        position: pos,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 7,
          fillColor: '#2b7bff',
          fillOpacity: 1,
          strokeColor: '#fff',
          strokeWeight: 2,
        },
        clickable: false,
      });
      return;
    }
    userMarkerRef.current.setMap(map);
    userMarkerRef.current.setPosition(pos);
  };

  const startGeoWatch = (map: any) => {
    if (geoWatchIdRef.current != null && navigator.geolocation) {
      try {
        navigator.geolocation.clearWatch(geoWatchIdRef.current);
      } catch {
        /* noop */
      }
      geoWatchIdRef.current = null;
    }
    if (!navigator.geolocation) return;

    geoWatchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        if (useVirtualRef.current) return;
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        lastGeoRef.current = p;
        lastFixRef.current = { ...p, accuracy: pos.coords.accuracy ?? 9999, ts: Date.now() };
        upsertUserMarker(map, p);
      },
      () => {
        // noop
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 12000 }
    );
  };

  const setVirtualFix = (lat: number, lng: number, accuracy = 5, reason = 'manual') => {
    virtualFixRef.current = { lat, lng, accuracy };
    lastGeoRef.current = { lat, lng };
    lastFixRef.current = { lat, lng, accuracy, ts: Date.now() };

    const map = mapRef.current;
    if (map) upsertUserMarker(map, { lat, lng });

    const m = virtualMarkerRef.current;
    try {
      if (m) m.position = { lat, lng };
    } catch {
      try {
        m?.setPosition?.({ lat, lng });
      } catch {
        /* noop */
      }
    }
    pushLog('VLOC_SET', `virtual location set (${reason})`, { lat, lng, accuracy });
  };

  const ensureVirtualMarker = (map: any) => {
    if (!DEBUG_TOOLS || !useVirtualRef.current) return;

    const AdvancedMarker = google.maps?.marker?.AdvancedMarkerElement;

    if (!virtualFixRef.current) {
      const c = map.getCenter();
      const lat = c?.lat?.() ?? lastFixRef.current?.lat ?? 31.2;
      const lng = c?.lng?.() ?? lastFixRef.current?.lng ?? 130.5;
      virtualFixRef.current = { lat, lng, accuracy: 5 };
    }

    const v = virtualFixRef.current!;
    if (!virtualMarkerRef.current) {
      if (AdvancedMarker) {
        const el = document.createElement('div');
        el.style.padding = '4px 6px';
        el.style.borderRadius = '8px';
        el.style.border = '2px solid #ff2d55';
        el.style.background = 'rgba(255,255,255,.95)';
        el.style.fontWeight = '900';
        el.style.fontSize = '12px';
        el.textContent = 'VLOC';

        const m = new AdvancedMarker({ map, position: { lat: v.lat, lng: v.lng }, content: el });
        try {
          m.gmpDraggable = true;
        } catch {
          /* noop */
        }

        const onEnd = () => {
          const p = normPos(m.position);
          if (!p) return;
          setVirtualFix(p.lat, p.lng, virtualFixRef.current?.accuracy ?? 5, 'drag');
        };
        try {
          m.addListener?.('gmp-dragend', onEnd);
        } catch {
          /* noop */
        }
        try {
          m.addListener?.('dragend', onEnd);
        } catch {
          /* noop */
        }

        virtualMarkerRef.current = m;
      } else {
        const m = new google.maps.Marker({ map, position: { lat: v.lat, lng: v.lng }, draggable: true, label: 'V' });
        m.addListener('dragend', () => {
          const p = m.getPosition();
          if (!p) return;
          setVirtualFix(p.lat(), p.lng(), virtualFixRef.current?.accuracy ?? 5, 'drag');
        });
        virtualMarkerRef.current = m;
      }
    } else {
      try {
        virtualMarkerRef.current.map = map;
      } catch {
        /* noop */
      }
      try {
        virtualMarkerRef.current.setMap?.(map);
      } catch {
        /* noop */
      }
      try {
        virtualMarkerRef.current.position = { lat: v.lat, lng: v.lng };
      } catch {
        /* noop */
      }
      try {
        virtualMarkerRef.current.setPosition?.({ lat: v.lat, lng: v.lng });
      } catch {
        /* noop */
      }
    }

    if (!mapClickListenerRef.current) {
      mapClickListenerRef.current = map.addListener('click', (e: any) => {
        if (!useVirtualRef.current) return;
        const ll = e?.latLng;
        if (!ll) return;
        setVirtualFix(ll.lat(), ll.lng(), virtualFixRef.current?.accuracy ?? 5, 'map-click');
      });
    }
  };

  const disableVirtualMarker = () => {
    try {
      mapClickListenerRef.current?.remove?.();
    } catch {
      /* noop */
    }
    mapClickListenerRef.current = null;

    const m = virtualMarkerRef.current;
    try {
      m.map = null;
    } catch {
      /* noop */
    }
    try {
      m.setMap?.(null);
    } catch {
      /* noop */
    }
  };

  // 変更：useVirtualLoc 切り替え時にマーカーを出し入れ
  useEffect(() => {
    const map = mapRef.current;
    if (!DEBUG_TOOLS || !map) return;
    if (useVirtualLoc) ensureVirtualMarker(map);
    else disableVirtualMarker();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [DEBUG_TOOLS, useVirtualLoc]);

  const doFix = async () => {
    // Prefer cached fix from watchPosition for snappy UI.
    const cached = lastFixRef.current;
    if (cached && Date.now() - cached.ts <= 10_000) {
      return { lat: cached.lat, lng: cached.lng, accuracy: cached.accuracy };
    }

    if (useVirtualRef.current && virtualFixRef.current) {
      const v = virtualFixRef.current;
      lastGeoRef.current = { lat: v.lat, lng: v.lng };
      lastFixRef.current = { lat: v.lat, lng: v.lng, accuracy: v.accuracy, ts: Date.now() };
      return { lat: v.lat, lng: v.lng, accuracy: v.accuracy };
    }

    try {
      const fix = await getCurrentFix(12000);
      lastGeoRef.current = { lat: fix.lat, lng: fix.lng };
      lastFixRef.current = { lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, ts: Date.now() };
      return fix;
    } catch {
      pushNotice('error', '位置情報を取得できません。再試行してください。', 4000);
      return null;
    }
  };

  const onPanToCurrent = async () => {
    const map = mapRef.current;
    if (!map) return;

    let pos = lastGeoRef.current;
    if (!pos) {
      try {
        const fix = await getCurrentFix(8000);
        pos = { lat: fix.lat, lng: fix.lng };
        lastGeoRef.current = pos;
        upsertUserMarker(map, pos);
      } catch {
        pushNotice('error', '現在地が取得できません。位置情報の許可/通信状態を確認してください。', 4000);
        return;
      }
    }

    map.panTo(pos);
    const z = map.getZoom?.() ?? 13;
    if (z < 15) map.setZoom?.(15);
  };

  // ===== debug helpers (timer etc) =====
  const debugSetVirtualFromCurrent = async () => {
    const map = mapRef.current;
    if (!map) return;

    try {
      const fix = await getCurrentFix(6000);
      setVirtualFix(fix.lat, fix.lng, Math.max(5, Math.round(fix.accuracy || 5)), 'from-current');
      pushLog('DBG', '仮想現在地を現在地に設定しました');
    } catch {
      const c = map.getCenter?.();
      if (!c) return;
      setVirtualFix(c.lat(), c.lng(), 5, 'from-center');
      pushLog('DBG', '仮想現在地を地図中心に設定しました');
    }
  };

  const debugShiftTimerMin = (deltaMin: number) => {
    if (!progress) return;
    const now = Date.now();
    let newStart = progress.startedAtMs + deltaMin * 60_000;
    if (newStart > now) newStart = now;
    const newP = { ...progress, startedAtMs: newStart };
    applyProgressUpdate(newP, `DBG: タイマー調整 ${deltaMin >= 0 ? '+' : ''}${deltaMin}分`, 'TIMER_SHIFT', {
      deltaMin,
    });
  };

  const debugSetRemainingMin = (remainMin: number) => {
    if (!progress) return;
    const now = Date.now();
    const durationSec = Math.max(0, Math.round((progress.config?.durationMin ?? 0) * 60));
    const remainSec = Math.max(0, Math.min(durationSec, Math.round(remainMin * 60)));
    const elapsedTargetSec = Math.max(0, durationSec - remainSec);
    let newStart = now - elapsedTargetSec * 1000;

    const minStart = now - durationSec * 1000;
    if (newStart < minStart) newStart = minStart;
    if (newStart > now) newStart = now;

    const newP = { ...progress, startedAtMs: newStart };
    applyProgressUpdate(newP, `DBG: 残り時間を${remainMin}分に設定`, 'TIMER_SET', { remainMin });
  };

  // ===== load game =====
  useEffect(() => {
    (async () => {
      const g = progress ?? (await loadGame());
      if (!g) {
        pushNotice('error', 'ゲームデータがありません。ホームから新規開始してください。', 4000);
        nav('/');
        return;
      }

      // If game already ended, route away from Play.
      if (g.endedAtMs) {
        if ((g as any).endReason === 'ABANDONED') {
          pushNotice('error', 'ゲームは途中離脱扱いで終了しています。', 4000);
          nav('/');
          return;
        }
        // GOAL (or legacy ended game): show result
        setProgress(g);
        nav('/result');
        return;
      }

      // If overtime grace has expired, treat as abandoned (no result / no resume)
      const plannedEnd = g.startedAtMs + (g.config?.durationMin ?? 0) * 60_000;
      const graceEnd = plannedEnd + 60 * 60_000;
      const now = Date.now();
      if (now > graceEnd) {
        const abandoned = { ...g, endedAtMs: now, endReason: 'ABANDONED' as const };
        setProgress(abandoned);
        await saveGame(abandoned);
        pushNotice('error', 'タイムアップから1時間を超えたため、途中離脱扱いでゲーム終了しました。', 6000);
        nav('/');
        return;
      }
      setProgress(g);
      const s = await getJudgeTargetSpots();
      setSpots(s);
      const st = await getStationsByOrder();
      setStations(st);
    })();
  }, [nav, progress, setProgress]);

  const cooldownLeft = useMemo(() => {
    if (!progress?.cooldownUntilMs) return 0;
    return Math.max(0, Math.ceil((progress.cooldownUntilMs - nowMs) / 1000));
  }, [progress?.cooldownUntilMs, nowMs]);

  const plannedEndMs = useMemo(() => {
    if (!progress) return undefined;
    return progress.startedAtMs + (progress.config?.durationMin ?? 0) * 60_000;
  }, [progress?.startedAtMs, progress?.config?.durationMin]);

  const graceEndMs = useMemo(() => {
    if (!plannedEndMs) return undefined;
    return plannedEndMs + 60 * 60_000;
  }, [plannedEndMs]);

  // While on PlayPage, if grace time expires without GOAL check-in, end the game as ABANDONED (no result, no resume).
  useEffect(() => {
    if (!progress || progress.endedAtMs || !graceEndMs) return;
    if (nowMs <= graceEndMs) return;

    void abandonGameNow();
  }, [graceEndMs, nowMs, nav, progress, setProgress]);

  // ===== Map init / cleanup =====
  useEffect(() => {
    (async () => {
      try {
        if (!mapEl.current) return;

        // Avoid resetting zoom on every progress update: create/attach map only once per page mount.
        if (mapRef.current) return;

        const p = progressRef.current;
        const center = p?.config.start ?? { lat: 31.2, lng: 130.5 };
        const mapId = (import.meta.env.VITE_GOOGLE_MAP_ID as string) || undefined;

        const hasExisting = !!getMap();
        const map = await attachMap(mapEl.current, {
          center,
          ...(hasExisting ? {} : { zoom: 13 }),
          ...(mapId ? { mapId } : {}),
          gestureHandling: 'greedy', // 1本指で移動
          streetViewControl: false, // ペグマン非表示
          fullscreenControl: false, // 全画面ボタン無効
          mapTypeControl: false, // 地図/航空写真ボタン無効
        });

        mapRef.current = map;
        // map が用意できたタイミングで marker 描画 effect を再実行させる
        setMapReadyNonce((n) => n + 1);
        if (!infoWindowRef.current) infoWindowRef.current = new google.maps.InfoWindow();

        startGeoWatch(map);
        if (DEBUG_TOOLS && useVirtualRef.current) ensureVirtualMarker(map);
      } catch (e: any) {
        pushNotice('error', e?.message ?? String(e), 6000);
      }
    })();

    return () => {
      if (geoWatchIdRef.current != null && navigator.geolocation) {
        try {
          navigator.geolocation.clearWatch(geoWatchIdRef.current);
        } catch {
          /* noop */
        }
        geoWatchIdRef.current = null;
      }

      try {
        userMarkerRef.current?.setMap?.(null);
      } catch {
        /* noop */
      }
      userMarkerRef.current = null;

      try {
        clustererRef.current?.clearMarkers();
      } catch {
        /* noop */
      }
      clustererRef.current = null;

      for (const m of markersRef.current) {
        try {
          m.map = null;
        } catch {
          /* noop */
        }
      }
      markersRef.current = [];

      try {
        infoWindowRef.current?.close?.();
      } catch {
        /* noop */
      }

      disableVirtualMarker();
      parkMap();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [DEBUG_TOOLS]);

  // Apply the game start center once (does not touch zoom), e.g. after reload when progress is loaded asynchronously.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || startCenterAppliedRef.current) return;
    const start = progress?.config?.start;
    if (!start) return;

    try {
      map.setCenter(start);
      startCenterAppliedRef.current = true;
    } catch {
      /* noop */
    }
  }, [progress?.config?.start?.lat, progress?.config?.start?.lng]);

  // ===== Render markers =====
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !progress) return;

    const AdvancedMarker = google.maps?.marker?.AdvancedMarkerElement;
    if (!AdvancedMarker) return;

    const iw = infoWindowRef.current ?? new google.maps.InfoWindow();
    infoWindowRef.current = iw;

    const esc = (s: string) =>
      s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');

    const openInfo = (anchor: any, html: string) => {
      iw.setContent(html);
      try {
        iw.open({ map, anchor } as any);
      } catch {
        iw.open(map as any);
      }
    };

    // cleanup old
    for (const l of cpDragListenersRef.current) {
      try {
        l?.remove?.();
      } catch {
        /* noop */
      }
    }
    cpDragListenersRef.current = [];

    for (const m of markersRef.current) {
      try {
        m.map = null;
      } catch {
        /* noop */
      }
    }
    markersRef.current = [];

    try {
      clustererRef.current?.clearMarkers();
    } catch {
      /* noop */
    }
    clustererRef.current = null;

    const cpSet = new Set(progress.cpSpotIds);
    const reachedCp = new Set(progress.reachedCpIds);
    const visitedThisGame = new Set(progress.visitedSpotIds);

    // marker UI helpers
    const sizeFill = (sizeClass?: string) => {
      switch ((sizeClass ?? '').toUpperCase()) {
        case 'S':
          return '#ffffff';
        case 'M':
          return '#bfe6ff';
        case 'L':
          return '#bff2a8';
        case 'XL':
          return '#fff3a6';
        default:
          return '#ffffff';
      }
    };

    const badgePxByScore = (score: number) => {
      if (score >= 200) return 36;
      if (score >= 120) return 32;
      if (score >= 60) return 28;
      if (score >= 30) return 26;
      return 24;
    };

    const mkCpBadge = (cpIndex: number, reached: boolean) => {
      const el = document.createElement('div');
      el.className = `cpBadge${reached ? ' reached' : ''}`;
      el.textContent = `★CP${cpIndex}`;
      return el;
    };

    const mkSpotBadge = (sp: Spot) => {
      const px = badgePxByScore(sp.Score);
      const isVisitedNow = visitedThisGame.has(sp.ID);
      const everVisited = everVisitedSpotIdsRef.current;

      const wrap = document.createElement('div');
      wrap.style.position = 'relative';
      wrap.style.width = `${px}px`;
      wrap.style.height = `${px}px`;

      if (isVisitedNow) {
        const el = document.createElement('div');
        el.className = 'spotFlag';
        el.style.width = `${px}px`;
        el.style.height = `${px}px`;
        el.style.borderRadius = `${Math.round(px / 2)}px`;
        el.style.background = sizeFill(sp.size_class);
        el.style.border = '2px solid #ff2d55';
        el.style.display = 'flex';
        el.style.alignItems = 'center';
        el.style.justifyContent = 'center';
        el.style.fontSize = `${Math.max(14, Math.round(px * 0.6))}px`;
        el.textContent = '🚩';
        el.title = `${sp.Name} / ${sp.Score}`;
        wrap.appendChild(el);
        return wrap;
      }

      const el = document.createElement('div');
      el.className = 'spotBadge';
      el.style.width = `${px}px`;
      el.style.height = `${px}px`;
      el.style.borderRadius = `${Math.round(px / 2)}px`;
      el.style.background = sizeFill(sp.size_class);
      el.textContent = String(sp.Score);
      el.title = `${sp.Name} / ${sp.Score}`;
      wrap.appendChild(el);

      if (everVisited.has(sp.ID)) {
        const star = document.createElement('div');
        star.textContent = '⭐️';
        star.style.position = 'absolute';
        star.style.right = '-8px';
        star.style.top = '-10px';
        star.style.fontSize = '12px';
        star.style.lineHeight = '12px';
        star.style.pointerEvents = 'none';
        wrap.appendChild(star);
      }

      return wrap;
    };

    const mkLabel = (label: string) => {
      const el = document.createElement('div');
      el.style.padding = '6px 8px';
      el.style.borderRadius = '10px';
      el.style.border = '1px solid rgba(0,0,0,.2)';
      el.style.background = 'rgba(255,255,255,.96)';
      el.style.fontSize = '12px';
      el.textContent = label;
      return el;
    };

    // START/GOAL
    const startM = new AdvancedMarker({ map, position: progress.config.start, content: mkLabel('START') });
    const goalM = new AdvancedMarker({ map, position: progress.config.goal, content: mkLabel('GOAL') });
    markersRef.current.push(startM, goalM);

    // CP markers
    const cpMarkers: any[] = [];
    for (let i = 0; i < progress.cpSpotIds.length; i++) {
      const id = progress.cpSpotIds[i];
      const sp = spots.find((s) => s.ID === id);
      if (!sp) continue;

      const reached = reachedCp.has(id);
      const el = mkCpBadge(i + 1, reached);

      const m = new AdvancedMarker({
        map,
        position: { lat: sp.Latitude, lng: sp.Longitude },
        content: el,
      });

      const html =
        `<div style="font-size:13px;line-height:1.4">` +
        `<div style="font-weight:800;margin-bottom:4px">★CP${i + 1}</div>` +
        `<div>${esc(sp.Name)}</div>` +
        `<div style="margin-top:4px">Score: <b>${sp.Score}</b></div>` +
        (sp.Category ? `<div>Category: ${esc(sp.Category)}</div>` : '') +
        (sp.Description ? `<div style="margin-top:6px;opacity:.9">${esc(sp.Description)}</div>` : '') +
        `</div>`;

      const onClick = () => openInfo(m, html);
      try {
        m.addListener('gmp-click', onClick);
      } catch {
        /* noop */
      }
      try {
        m.addListener('click', onClick);
      } catch {
        /* noop */
      }

      // Debug: CP drag & snap
      if (DEBUG_TOOLS) {
        try {
          m.gmpDraggable = true;
        } catch {
          /* noop */
        }

        const prevId = id;
        const prevPos = { lat: sp.Latitude, lng: sp.Longitude };

        const onDragEnd = () => {
          const p2 = normPos(m.position);
          if (!p2) return;

          let best: { sp: Spot; d: number } | null = null;
          for (const s of spots) {
            const d = haversineMeters(p2, { lat: s.Latitude, lng: s.Longitude });
            if (!best || d < best.d) best = { sp: s, d };
          }

          if (!best || best.d > 300) {
            try {
              m.position = prevPos;
            } catch {
              /* noop */
            }
            pushLog('CP_DRAG_REVERT', `★CP${i + 1} drag too far -> revert`, {
              lat: p2.lat,
              lng: p2.lng,
              nearestM: best ? Math.round(best.d) : null,
            });
            pushNotice('error', '近くにスポットがないためCPを移動できません（300m以内が必要）', 4000);
            return;
          }

          if (progress.cpSpotIds.some((x, idx) => idx !== i && x === best!.sp.ID)) {
            try {
              m.position = prevPos;
            } catch {
              /* noop */
            }
            pushLog('CP_DRAG_DUP', `★CP${i + 1} duplicate -> revert`, { targetId: best!.sp.ID, name: best!.sp.Name });
            pushNotice('error', 'そのスポットは既に別のCPに設定されています', 4000);
            return;
          }

          const newIds = [...progress.cpSpotIds];
          newIds[i] = best!.sp.ID;
          const newP = { ...progress, cpSpotIds: newIds };

          try {
            m.position = { lat: best!.sp.Latitude, lng: best!.sp.Longitude };
          } catch {
            /* noop */
          }

          applyProgressUpdate(newP, `★CP${i + 1} を移動しました`, 'CP_DRAG', {
            fromId: prevId,
            toId: best!.sp.ID,
            toName: best!.sp.Name,
            movedToDistM: Math.round(best!.d),
          });
        };

        try {
          const l1 = m.addListener?.('gmp-dragend', onDragEnd);
          if (l1) cpDragListenersRef.current.push(l1);
        } catch {
          /* noop */
        }
        try {
          const l2 = m.addListener?.('dragend', onDragEnd);
          if (l2) cpDragListenersRef.current.push(l2);
        } catch {
          /* noop */
        }
      }

      cpMarkers.push(m);
    }
    markersRef.current.push(...cpMarkers);

    // Spot markers (cluster)
    const spotMarkers: any[] = spots
      .filter((sp) => !cpSet.has(sp.ID))
      .map((sp) => {
        const m = new AdvancedMarker({
          position: { lat: sp.Latitude, lng: sp.Longitude },
          content: mkSpotBadge(sp),
        });

        const html =
          `<div style="font-size:13px;line-height:1.4">` +
          `<div style="font-weight:800;margin-bottom:4px">${esc(sp.Name)}</div>` +
          `<div>Score: <b>${sp.Score}</b></div>` +
          (sp.Category ? `<div>Category: ${esc(sp.Category)}</div>` : '') +
          (sp.Description ? `<div style="margin-top:6px;opacity:.9">${esc(sp.Description)}</div>` : '') +
          `</div>`;

        const onClick = () => openInfo(m, html);
        try {
          m.addListener('gmp-click', onClick);
        } catch {
          /* noop */
        }
        try {
          m.addListener('click', onClick);
        } catch {
          /* noop */
        }

        return m;
      });

    clustererRef.current = new MarkerClusterer({
      map,
      markers: spotMarkers,
      renderer: {
        render: ({ position }: any) => {
          return new google.maps.Marker({
            position,
            icon: {
              path: google.maps.SymbolPath.CIRCLE,
              scale: 10,
              fillColor: '#333',
              fillOpacity: 0.85,
              strokeColor: '#fff',
              strokeWeight: 2,
            },
            label: undefined,
            zIndex: Number(google.maps.Marker.MAX_ZINDEX) + 1,
          });
        },
      } as any,
    });
  }, [spots, progress, DEBUG_TOOLS, mapReadyNonce]);

  // ===== Check-in actions =====
  const onCheckIn = async () => {
    if (checkInBusy) return;
    if (!online) return pushNotice('error', 'オフライン/圏外のためチェックインできません。オンラインで再試行してください。', 4000);
    if (!progress) return;
    if (progress.endedAtMs) return pushNotice('error', 'ゲームは終了しています。', 4000);
    if (graceEndMs && Date.now() > graceEndMs) {
      await abandonGameNow();
      return;
    }

    setCheckInBusy(true);
    await new Promise<void>((r) => requestAnimationFrame(() => r()));

    try {
      const fix = await doFix();
      if (!fix) return;

      const loc = { lat: fix.lat, lng: fix.lng };

      let candidateTop: any[] | undefined;
      let chosenCandidate: any | undefined;

      if (DEBUG_TOOLS) {
        const cands = spots
          .map((s) => ({ s, d: haversineMeters(loc, { lat: s.Latitude, lng: s.Longitude }) }))
          .filter((x) => x.d <= CHECKIN_RADIUS_M)
          .sort((a, b) => (a.d - b.d) || (b.s.Score - a.s.Score) || a.s.ID.localeCompare(b.s.ID));

        candidateTop = cands.slice(0, 3).map((x) => ({
          id: x.s.ID,
          name: x.s.Name,
          score: x.s.Score,
          distM: Math.round(x.d),
        }));

        if (cands[0]) {
          chosenCandidate = {
            id: cands[0].s.ID,
            name: cands[0].s.Name,
            score: cands[0].s.Score,
            distM: Math.round(cands[0].d),
            isCp: progress.cpSpotIds.includes(cands[0].s.ID),
          };
        }

        pushLog('CHECKIN_ATTEMPT', 'spot/cp check-in', { loc, accuracy: fix.accuracy, radiusM: CHECKIN_RADIUS_M, candidateTop });
      }

      const before = progress;
      const r = checkInSpotOrCp(progress, loc, fix.accuracy, spots);

      if (!r.ok) {
        const cdLeft = before.cooldownUntilMs ? Math.max(0, Math.ceil((before.cooldownUntilMs - Date.now()) / 1000)) : 0;
        pushLog('CHECKIN_FAIL', r.message, {
          code: r.code,
          loc,
          accuracy: fix.accuracy,
          radiusM: CHECKIN_RADIUS_M,
          maxAccuracyM: MAX_ACCURACY_M,
          candidateTop,
          chosenCandidate,
          cooldownLeftSec: cdLeft,
        });
        pushNotice('error', r.message, 4000);
        return;
      }

      const after = r.progress as any;
      pushLog('CHECKIN_OK', r.message, {
        kind: (r as any).kind,
        loc,
        accuracy: fix.accuracy,
        radiusM: CHECKIN_RADIUS_M,
        chosenCandidate,
        scoreDelta: (after.score ?? 0) - (before.score ?? 0),
        penaltyDelta: (after.penalty ?? 0) - (before.penalty ?? 0),
        newScore: after.score,
        newPenalty: after.penalty,
        cooldownLeftSec: after.cooldownUntilMs ? Math.max(0, Math.ceil((after.cooldownUntilMs - Date.now()) / 1000)) : 0,
      });

      // 永続 ⭐️ 更新
      try {
        const beforeSet = new Set((before as any).visitedSpotIds ?? []);
        const afterIds: string[] = ((after as any).visitedSpotIds ?? []) as any;
        const added = afterIds.filter((id) => !beforeSet.has(id));
        if (added.length) {
          const ever = everVisitedSpotIdsRef.current;
          for (const id of added) ever.add(id);
          saveEverVisitedSpots();
        }
      } catch {
        // ignore
      }

      applyProgressUpdate(r.progress, r.message);


// ===== user notices =====
try {
  const afterP: any = after;
  const scoreDelta = (afterP.score ?? 0) - ((before as any).score ?? 0);

  const beforeVisited = new Set<string>(((before as any).visitedSpotIds ?? []) as any);
  const afterVisited: string[] = ((afterP.visitedSpotIds ?? []) as any) as string[];
  const addedSpotIds = afterVisited.filter((id) => !beforeVisited.has(id));
  if (addedSpotIds[0]) {
    const sp = findSpotById(addedSpotIds[0]);
    const name = sp?.Name ?? addedSpotIds[0];
    pushNotice('success', `スポット達成：${name}（${fmtDelta(scoreDelta)}）`, 2800);
  } else {
    // 既に達成済み等で追加が無いケース（通常は起きにくい）
    pushNotice('success', r.message, 2800);
  }

  const beforeCp = new Set<string>(((before as any).reachedCpIds ?? []) as any);
  const afterCp: string[] = ((afterP.reachedCpIds ?? []) as any) as string[];
  const addedCpIds = afterCp.filter((id) => !beforeCp.has(id));
  for (const id of addedCpIds.slice(0, 3)) {
    const sp = findSpotById(id);
    const name = sp?.Name ?? id;
    pushNotice('success', `CP達成：${name}`, 2800);
  }
} catch {
  // noop
}
    } finally {
      setCheckInBusy(false);
    }
  };

  const onJrBoard = async () => {
    if (checkInBusy) return;
    if (!online) return pushNotice('error', 'オフライン/圏外のためチェックインできません。', 4000);
    if (!progress) return;
    if (progress.endedAtMs) return pushNotice('error', 'ゲームは終了しています。', 4000);
    if (graceEndMs && Date.now() > graceEndMs) {
      await abandonGameNow();
      return;
    }

    setCheckInBusy(true);
    await new Promise<void>((r) => requestAnimationFrame(() => r()));

    try {
      const fix = await doFix();
      if (!fix) return;

      const loc = { lat: fix.lat, lng: fix.lng };

      let candTop: any[] | undefined;
      if (DEBUG_TOOLS) {
        const cands = stations
          .map((st) => ({ st, d: haversineMeters(loc, { lat: st.lat, lng: st.lng }) }))
          .filter((x) => x.d <= CHECKIN_RADIUS_M)
          .sort((a, b) => (a.d - b.d) || a.st.stationId.localeCompare(b.st.stationId));

        candTop = cands.slice(0, 3).map((x) => ({ stationId: x.st.stationId, name: x.st.name, distM: Math.round(x.d) }));
        pushLog('JR_BOARD_ATTEMPT', 'JR 乗車チェックイン', {
          loc,
          accuracy: fix.accuracy,
          radiusM: CHECKIN_RADIUS_M,
          candidateTop: candTop,
          cooldownSec: JR_COOLDOWN_SEC,
        });
      }

      const before = progress;
      const r = jrBoard(progress, loc, fix.accuracy, stations);

      if (!r.ok) {
        const cdLeft = before.cooldownUntilMs ? Math.max(0, Math.ceil((before.cooldownUntilMs - Date.now()) / 1000)) : 0;
        pushLog('JR_BOARD_FAIL', r.message, { code: r.code, candidateTop: candTop, cooldownLeftSec: cdLeft });
        pushNotice('error', r.message, 4000);
        return;
      }

      const after = r.progress as any;
      pushLog('JR_BOARD_OK', r.message, {
        scoreDelta: (after.score ?? 0) - (before.score ?? 0),
        penaltyDelta: (after.penalty ?? 0) - (before.penalty ?? 0),
        cooldownLeftSec: after.cooldownUntilMs ? Math.max(0, Math.ceil((after.cooldownUntilMs - Date.now()) / 1000)) : 0,
      });

      applyProgressUpdate(r.progress, r.message);


try {
  const afterP: any = after;
  const scoreDelta = (afterP.score ?? 0) - ((before as any).score ?? 0);
  const st = findNearestStation(loc);
  const name = st?.name ?? (st?.stationId ?? '駅');
  const pts = scoreDelta !== 0 ? `（${fmtDelta(scoreDelta)}）` : '';
  pushNotice('success', `JR乗車：${name}${pts}`, 2800);
} catch {
  pushNotice('success', r.message, 2800);
}


// ===== user notices =====
try {
  const afterP: any = after;
  const scoreDelta = (afterP.score ?? 0) - ((before as any).score ?? 0);

  const beforeVisited = new Set<string>(((before as any).visitedSpotIds ?? []) as any);
  const afterVisited: string[] = ((afterP.visitedSpotIds ?? []) as any) as string[];
  const addedSpotIds = afterVisited.filter((id) => !beforeVisited.has(id));
  if (addedSpotIds[0]) {
    const sp = findSpotById(addedSpotIds[0]);
    const name = sp?.Name ?? addedSpotIds[0];
    pushNotice('success', `スポット達成：${name}（${fmtDelta(scoreDelta)}）`, 2800);
  } else {
    // 既に達成済み等で追加が無いケース（通常は起きにくい）
    pushNotice('success', r.message, 2800);
  }

  const beforeCp = new Set<string>(((before as any).reachedCpIds ?? []) as any);
  const afterCp: string[] = ((afterP.reachedCpIds ?? []) as any) as string[];
  const addedCpIds = afterCp.filter((id) => !beforeCp.has(id));
  for (const id of addedCpIds.slice(0, 3)) {
    const sp = findSpotById(id);
    const name = sp?.Name ?? id;
    pushNotice('success', `CP達成：${name}`, 2800);
  }
} catch {
  // noop
}
    } finally {
      setCheckInBusy(false);
    }
  };

  const onJrAlight = async () => {
    if (checkInBusy) return;
    if (!online) return pushNotice('error', 'オフライン/圏外のためチェックインできません。', 4000);
    if (!progress) return;
    if (progress.endedAtMs) return pushNotice('error', 'ゲームは終了しています。', 4000);
    if (graceEndMs && Date.now() > graceEndMs) {
      await abandonGameNow();
      return;
    }
    if (progress.endedAtMs) return pushNotice('error', 'ゲームは終了しています。', 4000);
    if (graceEndMs && Date.now() > graceEndMs) {
      await abandonGameNow();
      return;
    }

    setCheckInBusy(true);
    await new Promise<void>((r) => requestAnimationFrame(() => r()));

    try {
      const fix = await doFix();
      if (!fix) return;

      const loc = { lat: fix.lat, lng: fix.lng };

      let candTop: any[] | undefined;
      if (DEBUG_TOOLS) {
        const cands = stations
          .map((st) => ({ st, d: haversineMeters(loc, { lat: st.lat, lng: st.lng }) }))
          .filter((x) => x.d <= CHECKIN_RADIUS_M)
          .sort((a, b) => (a.d - b.d) || a.st.stationId.localeCompare(b.st.stationId));

        candTop = cands.slice(0, 3).map((x) => ({ stationId: x.st.stationId, name: x.st.name, distM: Math.round(x.d) }));
        pushLog('JR_ALIGHT_ATTEMPT', 'JR 降車チェックイン', {
          loc,
          accuracy: fix.accuracy,
          radiusM: CHECKIN_RADIUS_M,
          candidateTop: candTop,
          cooldownSec: JR_COOLDOWN_SEC,
        });
      }

      const before = progress;
      const r = jrAlight(progress, loc, fix.accuracy, stations);

      if (!r.ok) {
        const cdLeft = before.cooldownUntilMs ? Math.max(0, Math.ceil((before.cooldownUntilMs - Date.now()) / 1000)) : 0;
        pushLog('JR_ALIGHT_FAIL', r.message, { code: r.code, candidateTop: candTop, cooldownLeftSec: cdLeft });
        pushNotice('error', r.message, 4000);
        return;
      }

      const after = r.progress as any;
      pushLog('JR_ALIGHT_OK', r.message, {
        scoreDelta: (after.score ?? 0) - (before.score ?? 0),
        penaltyDelta: (after.penalty ?? 0) - (before.penalty ?? 0),
        cooldownLeftSec: after.cooldownUntilMs ? Math.max(0, Math.ceil((after.cooldownUntilMs - Date.now()) / 1000)) : 0,
      });

      applyProgressUpdate(r.progress, r.message);


try {
  const afterP: any = after;
  const scoreDelta = (afterP.score ?? 0) - ((before as any).score ?? 0);
  const st = findNearestStation(loc);
  const name = st?.name ?? (st?.stationId ?? '駅');
  const pts = scoreDelta !== 0 ? `（${fmtDelta(scoreDelta)}）` : '';
  pushNotice('success', `JR降車：${name}${pts}`, 2800);
} catch {
  pushNotice('success', r.message, 2800);
}


// ===== user notices =====
try {
  const afterP: any = after;
  const scoreDelta = (afterP.score ?? 0) - ((before as any).score ?? 0);

  const beforeVisited = new Set<string>(((before as any).visitedSpotIds ?? []) as any);
  const afterVisited: string[] = ((afterP.visitedSpotIds ?? []) as any) as string[];
  const addedSpotIds = afterVisited.filter((id) => !beforeVisited.has(id));
  if (addedSpotIds[0]) {
    const sp = findSpotById(addedSpotIds[0]);
    const name = sp?.Name ?? addedSpotIds[0];
    pushNotice('success', `スポット達成：${name}（${fmtDelta(scoreDelta)}）`, 2800);
  } else {
    // 既に達成済み等で追加が無いケース（通常は起きにくい）
    pushNotice('success', r.message, 2800);
  }

  const beforeCp = new Set<string>(((before as any).reachedCpIds ?? []) as any);
  const afterCp: string[] = ((afterP.reachedCpIds ?? []) as any) as string[];
  const addedCpIds = afterCp.filter((id) => !beforeCp.has(id));
  for (const id of addedCpIds.slice(0, 3)) {
    const sp = findSpotById(id);
    const name = sp?.Name ?? id;
    pushNotice('success', `CP達成：${name}`, 2800);
  }
} catch {
  // noop
}
    } finally {
      setCheckInBusy(false);
    }
  };

  const onGoal = async () => {
    if (checkInBusy) return;
    if (!online) return pushNotice('error', 'オフライン/圏外のためチェックインできません。', 4000);
    if (!progress) return;
    if (progress.endedAtMs) return pushNotice('error', 'ゲームは終了しています。', 4000);
    if (graceEndMs && Date.now() > graceEndMs) {
      await abandonGameNow();
      return;
    }
    if (progress.endedAtMs) return pushNotice('error', 'ゲームは終了しています。', 4000);
    if (graceEndMs && Date.now() > graceEndMs) {
      await abandonGameNow();
      return;
    }

    setCheckInBusy(true);
    await new Promise<void>((r) => requestAnimationFrame(() => r()));

    try {
      const fix = await doFix();
      if (!fix) return;

      const loc = { lat: fix.lat, lng: fix.lng };
      const before = progress;
      const r = goalCheckIn(progress, loc, fix.accuracy);

      if (!r.ok) {
        pushLog('GOAL_FAIL', r.message, { code: r.code, loc, accuracy: fix.accuracy, radiusM: CHECKIN_RADIUS_M });
        pushNotice('error', r.message, 4000);
        return;
      }

      const after = r.progress as any;
      pushLog('GOAL_OK', r.message, {
        loc,
        accuracy: fix.accuracy,
        radiusM: CHECKIN_RADIUS_M,
        scoreDelta: (after.score ?? 0) - (before.score ?? 0),
        penaltyDelta: (after.penalty ?? 0) - (before.penalty ?? 0),
        finalScore: after.score,
        finalPenalty: after.penalty,
      });


setProgress(r.progress);
await saveGame(r.progress);

try {
  const afterP: any = after;
  pushNotice('info', `ゴール完了：リザルトへ（最終得点 ${afterP.score ?? ''}）`, 6000);
} catch {
  pushNotice('info', 'ゴール完了：リザルトへ', 6000);
}

// 通知が一瞬でも見えるように少しだけ待ってから遷移
window.setTimeout(() => nav('/result'), 250);

    } finally {
      setCheckInBusy(false);
    }
  };

  // ===== UI =====
  const rem = progress ? remainingSec(nowMs) : 0;
  const mm = Math.floor(rem / 60);
  const ss = rem % 60;

  return (
    <>
      <div className="card">
        <h3>プレイ</h3>
        {!online && <div className="banner">オフライン/圏外のためチェックインできません。</div>}
        <div className="hint">
          CP達成：{progress ? progress.reachedCpIds.length : 0}/{progress ? progress.cpSpotIds.length : 0}
        </div>
        {progress?.config.jrEnabled && <div className="hint">JRクールダウン：{cooldownLeft > 0 ? `${cooldownLeft}秒` : 'なし'}</div>}
      </div>

      <div style={{ height: 12 }} />
      <div className="card" style={{ position: 'relative' }}>
        <div className="mapWrap" ref={mapEl} />

        {/* 上段中央：残り時間（左）＋得点（右） */}
        <div
          className="overlay"
          style={{
            position: 'absolute',
            top: 10,
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'flex',
            gap: 10,
            zIndex: 6,
            pointerEvents: 'none',
          }}
        >
          <div className="pill">残り {mm}:{String(ss).padStart(2, '0')}</div>
          <div className="pill">得点 {progress?.score ?? 0}</div>
        </div>

        {/* 下段中央：現在地 */}
        <button
          className="btn"
          onClick={onPanToCurrent}
          style={{
            position: 'absolute',
            left: '50%',
            bottom: 12,
            transform: 'translateX(-50%)',
            zIndex: 6,
          }}
        >
          現在地
        </button>

        {/* DBGボタン（左下） */}
        {DEBUG_TOOLS && (
          <button
            className="btn"
            onClick={() => setDebugOpen((v) => !v)}
            style={{
              position: 'absolute',
              left: 10,
              bottom: 12,
              zIndex: 7,
              opacity: 0.9,
            }}
          >
            DBG
          </button>
        )}

        {/* Debug panel */}
        {DEBUG_TOOLS && debugOpen && (
          <div
            style={{
              position: 'absolute',
              left: 10,
              right: 10,
              bottom: 56,
              zIndex: 8,
              background: 'rgba(255,255,255,.95)',
              border: '1px solid rgba(0,0,0,.2)',
              borderRadius: 10,
              padding: 10,
              maxHeight: '45vh',
              overflow: 'auto',
            }}
          >
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <button className="btn" onClick={() => setUseVirtualLoc((v) => !v)}>
                {useVirtualLoc ? '仮想現在地: ON' : '仮想現在地: OFF'}
              </button>
              <button className="btn" onClick={debugSetVirtualFromCurrent} disabled={!useVirtualLoc}>
                仮想を現在地へ
              </button>
              <button className="btn" onClick={() => debugShiftTimerMin(-5)}>タイマー -5分</button>
              <button className="btn" onClick={() => debugShiftTimerMin(+5)}>タイマー +5分</button>
              <button className="btn" onClick={() => debugSetRemainingMin(5)}>残り5分</button>
              <button className="btn" onClick={() => debugSetRemainingMin(30)}>残り30分</button>
              <button className="btn" onClick={() => setLogs([])}>ログ消去</button>
            </div>

            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.9 }}>
              ・仮想現在地ON時：マップをタップで仮想位置を配置／VLOCをドラッグで移動  
              <br />
              ・CPは（DBG時のみ）ドラッグ可：近くのスポットに吸着（300m以内）、重複CPは禁止
            </div>

            <hr style={{ margin: '10px 0' }} />
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>イベントログ（最新が上）</div>
            <div style={{ fontSize: 11, lineHeight: 1.4, whiteSpace: 'pre-wrap' }}>
              {logs.length === 0 ? (
                <div style={{ opacity: 0.7 }}>（ログなし）</div>
              ) : (
                logs.map((l, idx) => (
                  <div key={idx} style={{ marginBottom: 6 }}>
                    <b>{new Date(l.atMs).toLocaleTimeString()}</b> [{l.type}] {l.message}
                    {l.data ? <div style={{ opacity: 0.85 }}>{JSON.stringify(l.data)}</div> : null}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      <div style={{ height: 12 }} />
      <div className="card">
        <h3>チェックイン</h3>
        <div className="actions">
          <button className="btn primary" onClick={onCheckIn} disabled={checkInBusy}>
            {checkInBusy ? 'チェックイン中…' : 'スポット/CP チェックイン'}
          </button>
          {progress?.config.jrEnabled && (
            <>
              <button className="btn" onClick={onJrBoard} disabled={checkInBusy || cooldownLeft > 0}>
                乗車チェックイン
              </button>
              <button className="btn" onClick={onJrAlight} disabled={checkInBusy || cooldownLeft > 0}>
                降車チェックイン
              </button>
            </>
          )}
          <button className="btn" onClick={onGoal} disabled={checkInBusy}>
            ゴールチェックイン
          </button>
        </div>

        <div className="hint" style={{ marginTop: 8 }}>
          ・到着判定：50m以内／accuracy≦100m／複数候補時（案A）：最近傍→同率ならScore高→それでも同率ならID昇順
        </div>
        {progress?.config.jrEnabled && (
          <div className="hint">
            ・JR：成功後60秒は無反応（ボタンはグレーダウン）／同一駅での乗車・降車は禁止／駅ポイントは同じ駅を1ゲーム1回まで
          </div>
        )}
      </div>

      {/* User Notice Toast (1行＋タップで履歴) */}
      {toastVisible && notices[0] && (
        <div
          onClick={() => setNoticeOpen((v) => !v)}
          style={{
            position: 'fixed',
            left: 12,
            right: 12,
            bottom: 72,
            zIndex: 9999,
            background: 'rgba(0,0,0,.86)',
            color: '#fff',
            borderRadius: 10,
            padding: '10px 12px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            cursor: 'pointer',
            userSelect: 'none',
          }}
        >
          <div style={{ flex: 1, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {notices[0].message}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: 0.9, fontSize: 12 }}>
            <span>{noticeOpen ? '▲' : '▼'}</span>
            <button
              className="btn"
              onClick={(e) => {
                e.stopPropagation();
                closeNotice();
              }}
              style={{
                padding: '4px 8px',
                fontSize: 12,
                opacity: 0.95,
              }}
            >
              ×
            </button>
          </div>
        </div>
      )}

      {toastVisible && noticeOpen && notices.length > 0 && (
        <div
          style={{
            position: 'fixed',
            left: 12,
            right: 12,
            bottom: 130,
            zIndex: 9999,
            background: 'rgba(255,255,255,.97)',
            border: '1px solid rgba(0,0,0,.2)',
            borderRadius: 10,
            padding: 10,
            maxHeight: '35vh',
            overflow: 'auto',
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 6 }}>通知履歴（最新が上）</div>
          <div style={{ fontSize: 12, lineHeight: 1.4 }}>
            {notices.slice(0, 5).map((n) => (
              <div key={n.id} style={{ marginBottom: 6 }}>
                <b>{new Date(n.atMs).toLocaleTimeString()}</b> {n.message}
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
            <button className="btn" onClick={() => setNoticeOpen(false)}>閉じる</button>
          </div>
        </div>
      )}
    </>
  );
}
