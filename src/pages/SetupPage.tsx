import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { loadGoogleMaps } from '../map/loadGoogleMaps';
import type { GameConfig, LatLng, Spot } from '../types';
import { getJudgeTargetSpots, saveGame } from '../db/repo';
import { useToast } from '../hooks/useToast';
import { useOnline } from '../hooks/useOnline';
import { getCurrentFix } from '../logic/location';
import { resolveStartGoal, useGameStore } from '../store/gameStore';
import { selectCpSpotsMVP, startNewGame } from '../logic/game';

const durationOptions = Array.from({length: 48}, (_,i)=>(i+1)*15); // 15..720

export default function SetupPage() {
  const nav = useNavigate();
  const online = useOnline();
  const { show, Toast } = useToast();
  const setProgress = useGameStore(s => s.setProgress);

  const [config, setConfig] = useState<GameConfig>({
    durationMin: 180,
    jrEnabled: false,
    cpCount: 0,
    start: undefined,
    goal: undefined,
  });

  const mapEl = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const startMarkerRef = useRef<any>(null);
  const goalMarkerRef = useRef<any>(null);

  const [judgeSpots, setJudgeSpots] = useState<Spot[]>([]);

  useEffect(() => {
    (async () => {
      const spots = await getJudgeTargetSpots();
      setJudgeSpots(spots);
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await loadGoogleMaps();
        if (!mapEl.current) return;
        const center = { lat: 31.2, lng: 130.5 };
        const map = new google.maps.Map(mapEl.current, {
          center,
          zoom: 11,
          mapId: 'DEMO_MAP_ID',
        });
        mapRef.current = map;

        // click to set start then goal (toggle by state)
        map.addListener('click', (e: google.maps.MapMouseEvent) => {
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
  }, [show]);

  useEffect(() => {
    // update markers
    const map = mapRef.current;
    if (!map) return;
    // AdvancedMarker might be available under google.maps.marker.AdvancedMarkerElement
    const AdvancedMarker = (google.maps as any).marker?.AdvancedMarkerElement;

    const up = (kind: 'start'|'goal', pos?: LatLng) => {
      const ref = kind === 'start' ? startMarkerRef : goalMarkerRef;
      if (!pos) {
        if (ref.current) { ref.current.map = null; ref.current = null; }
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
        ref.current = new AdvancedMarker({ map, position: pos, content: el });
      } else {
        ref.current.position = pos;
        ref.current.map = map;
      }
    };
    up('start', config.start);
    up('goal', config.goal);
  }, [config.start, config.goal]);

  const onUseCurrentForStartGoal = async () => {
    try {
      const fix = await getCurrentFix();
      setConfig(c => ({ ...c, start: {lat:fix.lat, lng:fix.lng}, goal: {lat:fix.lat, lng:fix.lng} }));
      show('現在地をスタート/ゴールに設定しました。');
      mapRef.current?.setCenter({lat:fix.lat, lng:fix.lng});
      mapRef.current?.setZoom(14);
    } catch (e: any) {
      show(e?.message ?? '位置情報を取得できません。', 4500);
    }
  };

  const canStart = online;

  const onStart = async () => {
    if (!online) return show('オフライン/圏外では開始できません。オンラインにして再試行してください。', 4500);
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
    const cpIds = selectCpSpotsMVP(judgeSpots, resolved);
    const progress = startNewGame(resolved, cpIds);
    await saveGame(progress);
    setProgress(progress);
    nav('/play');
  };

  return (
    <>
      <div className="card">
        <h3>開始設定</h3>
        {!online && <div className="banner">オフライン/圏外のため開始できません。オンラインにしてください。</div>}
        <div className="row">
          <div className="col">
            <label className="hint">制限時間（15分刻み）</label>
            <select className="input" value={config.durationMin} onChange={e=>setConfig(c=>({ ...c, durationMin: Number(e.target.value) }))}>
              {durationOptions.map(m => <option key={m} value={m}>{m}分</option>)}
            </select>
          </div>
          <div className="col">
            <label className="hint">CP数（0〜5）</label>
            <select className="input" value={config.cpCount} onChange={e=>setConfig(c=>({ ...c, cpCount: Number(e.target.value) }))}>
              {[0,1,2,3,4,5].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
            <div className="hint">CP=1〜2は「なるべくスタート〜ゴール間」。CP≥3は完全ランダム。</div>
          </div>
          <div className="col">
            <label className="hint">JR使用</label>
            <select className="input" value={config.jrEnabled ? 'on' : 'off'} onChange={e=>setConfig(c=>({ ...c, jrEnabled: e.target.value==='on' }))}>
              <option value="off">OFF</option>
              <option value="on">ON</option>
            </select>
            <div className="hint">JR=ONのとき、駅チェックインが有効になります。</div>
          </div>
        </div>

        <div style={{height:10}} />
        <div className="actions">
          <button className="btn" onClick={onUseCurrentForStartGoal}>現在地をスタート/ゴールにする</button>
          <button className="btn primary" onClick={onStart} disabled={!canStart}>開始</button>
        </div>
        <div className="hint" style={{marginTop:10}}>
          ・地図をタップして START / GOAL を設定（未指定なら開始時に現在地が採用されます）
        </div>
      </div>

      <div style={{height:12}} />
      <div className="card">
        <h3>スタート/ゴール指定（地図）</h3>
        <div className="mapWrap" ref={mapEl} />
      </div>
      {Toast}
    </>
  );
}
