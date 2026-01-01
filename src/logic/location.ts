export type LocationFix = { lat: number; lng: number; accuracy: number };

export function getCurrentFix(timeoutMs=12_000): Promise<LocationFix> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('この端末は位置情報APIを利用できません。'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 }
    );
  });
}
