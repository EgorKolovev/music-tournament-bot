// Регламент матча. Очки хранятся целыми в условных единицах: 9 = 0,9 балла (docs/architecture.md, раздел 9).
// Формат задаётся явно (docs/decisions/2026-10-08-mechanics-revision.md, разделы 2–3):
// короткий отбор — фиксированное число треков, финал — до порога. При равенстве в обоих
// случаях идут дополнительные треки до первого неравного счёта.

export type MatchFormat =
  // Побеждает лидер, набравший порог после закрытия трека; после лимита — просто лидер.
  | { kind: 'first_to'; winThreshold: number; trackLimit: number }
  // Побеждает лидер после N треков.
  | { kind: 'fixed'; tracks: number };

export interface Ruleset {
  artistPoints: number;
  titlePoints: number;
  format: MatchFormat;
}

// N подбирается на пробных матчах; ориентир — 5 или 7.
export const QUALIFIER_RULESET: Ruleset = {
  artistPoints: 9,
  titlePoints: 12,
  format: { kind: 'fixed', tracks: 5 },
};

// Регламент финала фиксируется до первого финального матча и одинаков для всех семи.
export const FINAL_RULESET: Ruleset = {
  artistPoints: 9,
  titlePoints: 12,
  format: { kind: 'first_to', winThreshold: 90, trackLimit: 20 },
};

export function formatPoints(units: number): string {
  return (units / 10).toFixed(1).replace('.', ',');
}

// Число треков основной части матча, после которого равенство решается дополнительными.
export function regularTracks(format: MatchFormat): number {
  return format.kind === 'fixed' ? format.tracks : format.trackLimit;
}
