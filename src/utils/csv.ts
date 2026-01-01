import Papa from 'papaparse';
import type { Spot, Station } from '../types';

export type CsvError = { code: string; message: string };

const REQUIRED_SPOT_COLS = ['ID','Name','Latitude','Longitude','Score','JudgeTarget'] as const;

export function parseSpotCsv(file: File): Promise<{ spots?: Spot[]; errors?: CsvError[]; }> {
  return new Promise((resolve) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (r) => {
        const errors: CsvError[] = [];
        const cols = (r.meta.fields ?? []).map(String);
        const missing = REQUIRED_SPOT_COLS.filter(c => !cols.includes(c));
        if (missing.length) {
          errors.push({ code: 'MISSING_REQUIRED_COLUMNS', message: `必須列が不足しています: ${missing.join(', ')}`});
        }
        // Build spots
        const spots: Spot[] = [];
        const seen = new Set<string>();
        for (const row of (r.data as any[])) {
          const ID = String(row.ID ?? '').trim();
          if (!ID) continue;
          if (seen.has(ID)) {
            errors.push({ code: 'DUPLICATE_ID', message: `ID重複: ${ID}`});
            continue;
          }
          seen.add(ID);
          const lat = Number(row.Latitude);
          const lng = Number(row.Longitude);
          const score = Number(row.Score);
          const jt = String(row.JudgeTarget ?? '').trim();
          const JudgeTarget: 0|1 = (jt === '1' || jt.toLowerCase() === 'true') ? 1 : 0;
          const Location = String(row.Location ?? `${lat},${lng}`);
          spots.push({
            ID,
            Name: String(row.Name ?? ''),
            Location,
            Latitude: lat,
            Longitude: lng,
            Score: isFinite(score) ? score : 0,
            size_class: row.size_class ? String(row.size_class) : undefined,
            Category: row.Category ? String(row.Category) : undefined,
            PostalCode: row.PostalCode ? String(row.PostalCode) : undefined,
            Address: row.Address ? String(row.Address) : undefined,
            Elevation: row.Elevation !== undefined && row.Elevation !== '' ? Number(row.Elevation) : undefined,
            ElevationSource: row.ElevationSource ? String(row.ElevationSource) : undefined,
            NearestStation: row.NearestStation ? String(row.NearestStation) : undefined,
            StationRoute_m: row.StationRoute_m !== undefined && row.StationRoute_m !== '' ? Number(row.StationRoute_m) : undefined,
            NeighborRoute_m: row.NeighborRoute_m !== undefined && row.NeighborRoute_m !== '' ? Number(row.NeighborRoute_m) : undefined,
            PaidFree: row.PaidFree ? String(row.PaidFree) : undefined,
            Notes: row.Notes ? String(row.Notes) : undefined,
            JudgeTarget,
            Description: row.Description ? String(row.Description) : undefined,
          });
        }
        if (errors.length) return resolve({ errors });
        resolve({ spots });
      },
      error: (err) => resolve({ errors: [{ code:'PARSE_ERROR', message: err.message }] }),
    });
  });
}

/**
 * Station CSV is optional in MVP, but recommended for JR check-in & graph distance.
 * Expected header columns (minimum):
 * - stationId, name, orderIndex, lat, lng
 * Optional: prevRoute_m, nextRoute_m, score
 */
export function parseStationCsv(file: File): Promise<{ stations?: Station[]; errors?: CsvError[]; }> {
  return new Promise((resolve) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (r) => {
        const errors: CsvError[] = [];
        const cols = (r.meta.fields ?? []).map(String);
        const required = ['stationId','name','orderIndex','lat','lng'];
        const missing = required.filter(c => !cols.includes(c));
        if (missing.length) {
          errors.push({ code: 'MISSING_REQUIRED_COLUMNS', message: `駅マスタの必須列が不足しています: ${missing.join(', ')}`});
        }
        const stations: Station[] = [];
        const seen = new Set<string>();
        for (const row of (r.data as any[])) {
          const stationId = String(row.stationId ?? '').trim();
          if (!stationId) continue;
          if (seen.has(stationId)) {
            errors.push({ code: 'DUPLICATE_STATION_ID', message: `stationId重複: ${stationId}` });
            continue;
          }
          seen.add(stationId);
          stations.push({
            stationId,
            name: String(row.name ?? ''),
            orderIndex: Number(row.orderIndex),
            lat: Number(row.lat),
            lng: Number(row.lng),
            prevRoute_m: row.prevRoute_m !== undefined && row.prevRoute_m !== '' ? Number(row.prevRoute_m) : undefined,
            nextRoute_m: row.nextRoute_m !== undefined && row.nextRoute_m !== '' ? Number(row.nextRoute_m) : undefined,
            score: row.score !== undefined && row.score !== '' ? Number(row.score) : undefined,
          });
        }
        if (errors.length) return resolve({ errors });
        resolve({ stations });
      },
      error: (err) => resolve({ errors: [{ code:'PARSE_ERROR', message: err.message }] }),
    });
  });
}
