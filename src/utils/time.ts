export function floorMinutesFromMs(deltaMs: number): number {
  return Math.floor((deltaMs / 1000) / 60);
}
