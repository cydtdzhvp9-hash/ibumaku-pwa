import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { loadGoogleMaps } from '../map/loadGoogleMaps';
import { getJudgeTargetSpots, getStationsByOrder, loadGame, saveGame } from '../db/repo';
import type { Spot, Station } from '../types';
import { useGameStore } from '../store/gameStore';
import { useToast } from '../hooks/useToast';
import { useOnline } from '../hooks/useOnline';
import { getCurrentFix } from '../logic/location';
import { checkInSpotOrCp, goalCheckIn, jrAlight, jrBoard } from '../logic/game';
import { MarkerClusterer } from '@googlemaps/markerclusterer';

export default function PlayPage() {
  const nav = useNavigate();
  const online = useOnline();
  const { show, Toast } = useToast();

  const progress = useGameStore(s => s.progress);
  const setProgress = useGameStore(s => s.setProgress);
  const remainingSec = useGameStore(s => s.remainingSec);

  const [spots, setSpots] = useState<Spot[]>([]);
  const [stations, setStations] = useState<Station[]>([]);

  const mapEl = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const clustererRef = useRef<MarkerClusterer | null>(null);
  const markersRef = useRef<any[]>([]);

  const [nowMs, setNowMs] = useState(Date.now());

  useEffect(() => {
    const t = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    (async () => {
      const g = progress ?? await loadGame();
      if (!g) {
        show('ゲームデータがありません。ホームから新規開始してください。', 4500);
        nav('/');
        return;
      }
      setProgress(g);
      const s = await getJudgeTargetSpots();
      setSpots(s);
      const st = await getStationsByOrder();
      setStations(st);
    })();
  }, [nav, progress, setProgress, show]);

  const cooldownLeft = useMemo(() => {
    if (!progress?.cooldownUntilMs) return 0;
    return Math.max(0, Math.ceil((progress.cooldownUntilMs - nowMs)/1000));
  }, [progress?.cooldownUntilMs, nowMs]);

  useEffect(() => {
    (async () => {
      try {
        await loadGoogleMaps();
        if (!mapEl.current) return;
        const p = progress;
        const center = p?.config.start ?? { lat: 31.2, lng: 130.5 };
        const map = new google.maps.Map(mapEl.current, {
          center,
          zoom: 13,
          mapId: 'DEMO_MAP_ID',
        });
        mapRef.current = map;
      } catch (e: any) {
        show(e?.message ?? String(e), 6000);
      }
    })();
  }, [show, progress]);

  // render markers when map/spots/progress ready
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !progress) return;
    const AdvancedMarker = (google.maps as any).marker?.AdvancedMarkerElement;
    if (!AdvancedMarker) return;

    // clear previous
    for (const m of markersRef.current) { m.map = null; }
    markersRef.current = [];
    clustererRef.current?.clearMarkers();
    clustererRef.current = null;

    const cpSet = new Set(progress.cpSpotIds);
    const reachedCp = new Set(progress.reachedCpIds);
    const visited = new Set(progress.visitedSpotIds);

    const mk = (label: string) => {
      const el = document.createElement('div');
      el.style.padding = '6px 8px';
      el.style.borderRadius = '10px';
      el.style.border = '1px solid rgba(0,0,0,.2)';
      el.style.background = 'rgba(255,255,255,.96)';
      el.style.fontSize = '12px';
      el.textContent = label;
      return el;
    };

    // Start/Goal markers
    const startM = new AdvancedMarker({ map, position: progress.config.start, content: mk('START') });
    const goalM  = new AdvancedMarker({ map, position: progress.config.goal,  content: mk('GOAL') });
    markersRef.current.push(startM, goalM);

    // CP markers (spot positions)
    const cpMarkers: any[] = [];
    for (const id of progress.cpSpotIds) {
      const sp = spots.find(s=>s.ID===id);
      if (!sp) continue;
      const el = mk(reachedCp.has(id) ? `CP✓` : `CP`);
      el.style.borderRadius = '999px';
      cpMarkers.push(new AdvancedMarker({ map, position: {lat:sp.Latitude,lng:sp.Longitude}, content: el }));
    }
    markersRef.current.push(...cpMarkers);

    // Spot markers (cluster)
    const spotMarkers: any[] = spots.map(sp => {
      const el = document.createElement('div');
      el.style.width = '18px';
      el.style.height = '18px';
      el.style.borderRadius = '9px';
      el.style.border = '1px solid rgba(0,0,0,.25)';
      el.style.background = visited.has(sp.ID) ? 'rgba(0,0,0,.75)' : 'rgba(255,255,255,.95)';
      el.title = sp.Name;
      return new AdvancedMarker({ position: {lat:sp.Latitude,lng:sp.Longitude}, content: el });
    });
    clustererRef.current = new MarkerClusterer({ map, markers: spotMarkers });
    markersRef.current.push(...spotMarkers);

  }, [spots, progress]);

  const doFix = async () => {
    try {
      const fix = await getCurrentFix();
      return fix;
    } catch (e: any) {
      show('位置情報を取得できません。再試行してください。', 3500);
      return null;
    }
  };

  const doUpdateProgress = async (p: any, msg: string) => {
    setProgress(p);
    await saveGame(p);
    show(msg, 3500);
  };

  const onCheckIn = async () => {
    if (!online) return show('オフライン/圏外のためチェックインできません。オンラインで再試行してください。', 4500);
    if (!progress) return;
    const fix = await doFix();
    if (!fix) return;
    const r = checkInSpotOrCp(progress, {lat:fix.lat, lng:fix.lng}, fix.accuracy, spots);
    if (!r.ok) return show(r.message, 4500);
    await doUpdateProgress(r.progress, r.message);
  };

  const onJrBoard = async () => {
    if (!online) return show('オフライン/圏外のためチェックインできません。', 4500);
    if (!progress) return;
    const fix = await doFix();
    if (!fix) return;
    const r = jrBoard(progress, {lat:fix.lat, lng:fix.lng}, fix.accuracy, stations);
    if (!r.ok) return show(r.message, 4500);
    await doUpdateProgress(r.progress, r.message);
  };

  const onJrAlight = async () => {
    if (!online) return show('オフライン/圏外のためチェックインできません。', 4500);
    if (!progress) return;
    const fix = await doFix();
    if (!fix) return;
    const r = jrAlight(progress, {lat:fix.lat, lng:fix.lng}, fix.accuracy, stations);
    if (!r.ok) return show(r.message, 4500);
    await doUpdateProgress(r.progress, r.message);
  };

  const onGoal = async () => {
    if (!online) return show('オフライン/圏外のためチェックインできません。', 4500);
    if (!progress) return;
    const fix = await doFix();
    if (!fix) return;
    const r = goalCheckIn(progress, {lat:fix.lat, lng:fix.lng}, fix.accuracy);
    if (!r.ok) return show(r.message, 4500);
    await saveGame(r.progress);
    setProgress(r.progress);
    show(r.message, 2000);
    nav('/result');
  };

  const rem = progress ? remainingSec(nowMs) : 0;
  const mm = Math.floor(rem/60);
  const ss = rem%60;

  return (
    <>
      <div className="card">
        <h3>プレイ</h3>
        {!online && <div className="banner">オフライン/圏外のためチェックインできません。</div>}
        <div className="hint">残り時間：{mm}:{String(ss).padStart(2,'0')} / 得点：{progress?.score ?? 0} / CP達成：{progress ? progress.reachedCpIds.length : 0}/{progress ? progress.cpSpotIds.length : 0}</div>
        {progress?.config.jrEnabled && <div className="hint">JRクールダウン：{cooldownLeft>0 ? `${cooldownLeft}秒` : 'なし'}</div>}
      </div>

      <div style={{height:12}} />
      <div className="card" style={{position:'relative'}}>
        <div className="mapWrap" ref={mapEl} />
        <div className="overlay">
          <div className="pill">残り {mm}:{String(ss).padStart(2,'0')}</div>
          <div className="pill">得点 {progress?.score ?? 0}</div>
        </div>
      </div>

      <div style={{height:12}} />
      <div className="card">
        <h3>チェックイン</h3>
        <div className="actions">
          <button className="btn primary" onClick={onCheckIn}>スポット/CP チェックイン</button>
          {progress?.config.jrEnabled && (
            <>
              <button className="btn" onClick={onJrBoard} disabled={cooldownLeft>0}>乗車チェックイン</button>
              <button className="btn" onClick={onJrAlight} disabled={cooldownLeft>0}>降車チェックイン</button>
            </>
          )}
          <button className="btn" onClick={onGoal}>ゴールチェックイン</button>
        </div>
        <div className="hint" style={{marginTop:8}}>
          ・到着判定：50m以内／accuracy≦100m／複数候補時（案A）：最近傍→同率ならScore高→それでも同率ならID昇順
        </div>
        {progress?.config.jrEnabled && (
          <div className="hint">
            ・JR：成功後60秒は無反応（ボタンはグレーダウン）／同一駅での乗車・降車は禁止（ゲーム全体で同一駅の乗降再利用も不可）
          </div>
        )}
      </div>
      {Toast}
    </>
  );
}
