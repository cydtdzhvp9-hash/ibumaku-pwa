import { getAllSpots, putSpots, putStations } from '../db/repo';
import { parseSpotCsv, parseStationCsv } from '../utils/csv';

/**
 * Remote master-data descriptor placed on GitHub Pages.
 * Example: { version:"20260105", spotsPath:"20260105/Ibumakuspotlist_MyMaps.csv", stationsPath:"20260105/Ibumaku_station.csv" }
 */
export type RemoteVersion = {
  version: string; // yyyymmdd
  spotsPath: string;
  stationsPath?: string;
};

export type SyncStatus = 'up_to_date' | 'updated' | 'failed';

export type SyncResult = {
  status: SyncStatus;
  remoteVersion?: string;
  message?: string;
  /**
   * true if the app can proceed with existing local data even when sync failed
   */
  canProceed: boolean;
};

const LS_KEY_BASE = 'ibumaku.masterData.baseUrl';
const LS_KEY_VER = 'ibumaku.masterData.version';

function defaultBaseUrl(): string {
  // Fallback base URL (override with VITE_DATA_BASE_URL)
  return 'https://cydtdzhvp9-hash.github.io/ibumaku-pwa.github.io/data';
}

function getBaseUrl(): string {
  const env = (import.meta as any).env?.VITE_DATA_BASE_URL as string | undefined;
  const base = (env ?? localStorage.getItem(LS_KEY_BASE) ?? defaultBaseUrl()).trim();
  // strip trailing slash
  return base.endsWith('/') ? base.slice(0, -1) : base;
}

function withCacheBuster(url: string, version: string): string {
  // Append v=yyyymmdd to avoid SW/browser caches.
  const u = new URL(url);
  u.searchParams.set('v', version);
  return u.toString();
}

async function fetchJsonNoStore<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`データ取得に失敗しました: ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

async function fetchTextNoStore(url: string): Promise<string> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`CSV取得に失敗しました: ${res.status} ${res.statusText}`);
  return await res.text();
}

async function hasLocalSpots(): Promise<boolean> {
  try {
    const spots = await getAllSpots();
    return spots.length > 0;
  } catch {
    return false;
  }
}

/**
 * Sync spot/station master data from GitHub Pages when version has changed.
 * - Always checks ${baseUrl}/version.json (no-store)
 * - If remote version differs, downloads CSVs and overwrites local DB.
 */
export async function syncMasterDataIfNeeded(): Promise<SyncResult> {
  const baseUrl = getBaseUrl();
  localStorage.setItem(LS_KEY_BASE, baseUrl);

  const canProceed = await hasLocalSpots();
  try {
    const verUrl = `${baseUrl}/version.json`;
    const remote = await fetchJsonNoStore<RemoteVersion>(verUrl);
    const currentVer = localStorage.getItem(LS_KEY_VER) ?? '';
    if (remote.version && remote.version === currentVer) {
      return { status: 'up_to_date', remoteVersion: remote.version, canProceed: true };
    }

    // Fetch & import spots
    const spotsUrl = withCacheBuster(`${baseUrl}/${remote.spotsPath}`, remote.version);
    const spotText = await fetchTextNoStore(spotsUrl);
    const spotFile = new File([spotText], 'spots.csv', { type: 'text/csv' });
    const spot = await parseSpotCsv(spotFile);
    if (spot.errors) {
      return {
        status: 'failed',
        remoteVersion: remote.version,
        message: spot.errors.map(e => e.message).join('\n'),
        canProceed,
      };
    }
    await putSpots(spot.spots!);

    // Fetch & import stations (optional)
    if (remote.stationsPath) {
      const stUrl = withCacheBuster(`${baseUrl}/${remote.stationsPath}`, remote.version);
      const stText = await fetchTextNoStore(stUrl);
      const stFile = new File([stText], 'stations.csv', { type: 'text/csv' });
      const st = await parseStationCsv(stFile);
      if (st.errors) {
        return {
          status: 'failed',
          remoteVersion: remote.version,
          message: st.errors.map(e => e.message).join('\n'),
          canProceed,
        };
      }
      await putStations(st.stations!);
    }

    localStorage.setItem(LS_KEY_VER, remote.version);
    return {
      status: 'updated',
      remoteVersion: remote.version,
      message: `マップデータを更新しました（${remote.version}）`,
      canProceed: true,
    };
  } catch (e: any) {
    return {
      status: 'failed',
      message: e?.message ?? String(e),
      canProceed,
    };
  }
}
