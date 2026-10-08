// Очки хранятся целыми в условных единицах: 9 = 0,9 балла (docs/architecture.md, раздел 9).
export interface Ruleset {
  artistPoints: number;
  titlePoints: number;
  winThreshold: number;
  regularTrackLimit: number;
  tiebreakTrackLimit: number;
}

export const DEFAULT_RULESET: Ruleset = {
  artistPoints: 9,
  titlePoints: 12,
  winThreshold: 90,
  regularTrackLimit: 20,
  tiebreakTrackLimit: 5,
};

export function formatPoints(units: number): string {
  return (units / 10).toFixed(1).replace('.', ',');
}
