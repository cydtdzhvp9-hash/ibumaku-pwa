import React, { useState } from 'react';
import { parseSpotCsv, parseStationCsv } from '../utils/csv';
import { putSpots, putStations } from '../db/repo';
import { useToast } from '../hooks/useToast';

export default function ImportPage() {
  const { show, Toast } = useToast();
  const [spotFile, setSpotFile] = useState<File | null>(null);
  const [stationFile, setStationFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const doImportSpots = async () => {
    if (!spotFile) return show('スポット台帳CSVを選択してください。');
    setBusy(true);
    try {
      const spot = await parseSpotCsv(spotFile);
      if (spot.errors) return show(spot.errors.map(e=>e.message).join('\n'), 5000);
      await putSpots(spot.spots!);
      show('スポットの取り込み完了');
    } finally {
      setBusy(false);
    }
  };

  const doImportStations = async () => {
    if (!stationFile) return show('駅マスタCSVを選択してください。');
    setBusy(true);
    try {
      const st = await parseStationCsv(stationFile);
      if (st.errors) return show(st.errors.map(e=>e.message).join('\n'), 5000);
      await putStations(st.stations!);
      show('駅マスタの取り込み完了');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="card">
        <h3>CSV取込（方式B）</h3>
        <p className="hint">必須列（スポット）：ID / Name / Latitude / Longitude / Score / JudgeTarget（欠けていると取り込み中止）</p>

        <div className="row">
          <div className="col">
            <label className="hint">スポット台帳CSV</label>
            <input className="input" type="file" accept=".csv,text/csv" onChange={e=>setSpotFile(e.target.files?.[0] ?? null)} />
          </div>
          <div className="col">
            <label className="hint">駅マスタCSV</label>
            <input className="input" type="file" accept=".csv,text/csv" onChange={e=>setStationFile(e.target.files?.[0] ?? null)} />
            <div className="hint">最低限：stationId, name, orderIndex, lat, lng（任意：prevRoute_m, nextRoute_m, score）</div>
          </div>
        </div>

        <div style={{height:10}} />
        <div className="actions">
          <button className="btn primary" onClick={doImportSpots} disabled={busy}>{busy ? '処理中...' : 'スポットを取り込む'}</button>
          <button className="btn" onClick={doImportStations} disabled={busy}>{busy ? '処理中...' : '駅を取り込む'}</button>
        </div>

        <hr />
        <div className="banner">
          <div><b>注意</b>：JudgeTarget=0 のスポットは、アプリでは地図に表示しません（データとしては保持）。</div>
        </div>
      </div>
      {Toast}
    </>
  );
}
