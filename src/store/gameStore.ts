import { create } from 'zustand';
import type { GameProgress, GameConfig, LatLng } from '../types';

type GameState = {
  progress?: GameProgress;
  setProgress: (p?: GameProgress) => void;

  // convenience getters
  remainingSec: (nowMs: number) => number;
  plannedEndMs: () => number | undefined;
};

export const useGameStore = create<GameState>((set, get) => ({
  progress: undefined,
  setProgress: (p) => set({ progress: p }),
  plannedEndMs: () => {
    const p = get().progress;
    if (!p) return undefined;
    return p.startedAtMs + p.config.durationMin * 60_000;
  },
  remainingSec: (nowMs) => {
    const end = get().plannedEndMs();
    if (!end) return 0;
    return Math.max(0, Math.floor((end - nowMs) / 1000));
  },
}));

export function resolveStartGoal(config: GameConfig, current: LatLng): GameConfig & { start: LatLng; goal: LatLng } {
  const start = config.start ?? current;
  const goal = config.goal ?? current;
  return { ...config, start, goal };
}
