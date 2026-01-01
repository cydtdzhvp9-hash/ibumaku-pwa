import { Loader } from '@googlemaps/js-api-loader';

let _promise: Promise<typeof google> | null = null;

export function loadGoogleMaps(): Promise<typeof google> {
  if (_promise) return _promise;
  const key = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;
  if (!key) {
    _promise = Promise.reject(new Error('VITE_GOOGLE_MAPS_API_KEY が未設定です（.env を作成してください）'));
    return _promise;
  }
  const loader = new Loader({
    apiKey: key,
    version: 'weekly',
    libraries: ['marker'],
    language: 'ja',
  });
  _promise = loader.load();
  return _promise;
}
