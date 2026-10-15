// Регламент матча. Очки хранятся целыми в условных единицах: 9 = 0,9 балла (docs/architecture.md, раздел 9).
// Формат задаётся явно (docs/decisions/2026-10-08-mechanics-revision.md, разделы 2–3):
// короткий отбор — фиксированное число треков, финал — до порога. После основной части идут
// дополнительные треки: в финале — до первого неравного счёта, в отборе — пока отрыв меньше
// minLead (docs/decisions/2026-10-15-qualifier-lead.md); без него — тоже до первого неравного.

export type MatchFormat =
  // Побеждает лидер, набравший порог после закрытия трека; после лимита — просто лидер.
  | { kind: 'first_to'; winThreshold: number; trackLimit: number }
  // Побеждает лидер после N треков, если оторвался хотя бы на minLead; иначе — ещё по треку.
  // Поля нет в регламентах до 15 октября 2026 — читать только через minLeadOf.
  | { kind: 'fixed'; tracks: number; minLead?: number };

export interface Ruleset {
  artistPoints: number;
  titlePoints: number;
  format: MatchFormat;
}

// N подбирается на пробных матчах; ориентир — 5 или 7. Очки 1 и 1,5 — с 14 октября 2026
// (docs/decisions/2026-10-14-points.md), отрыв 2,0 — с 15 октября 2026
// (docs/decisions/2026-10-15-qualifier-lead.md); турнир, начатый раньше, хранит свои.
export const QUALIFIER_RULESET: Ruleset = {
  artistPoints: 10,
  titlePoints: 15,
  format: { kind: 'fixed', tracks: 5, minLead: 20 },
};

// Регламент финала фиксируется до первого финального матча и одинаков для всех семи.
export const FINAL_RULESET: Ruleset = {
  artistPoints: 10,
  titlePoints: 15,
  format: { kind: 'first_to', winThreshold: 90, trackLimit: 20 },
};

export function formatPoints(units: number): string {
  return (units / 10).toFixed(1).replace('.', ',');
}

// Число треков основной части матча; после неё матч решают дополнительные треки — при ничьей,
// а в отборе с отрывом и при отрыве меньше нужного.
export function regularTracks(format: MatchFormat): number {
  return format.kind === 'fixed' ? format.tracks : format.trackLimit;
}

// Отрыв, с которым решается матч отбора после основной части; 0 — хватает любого неравного счёта.
// В регламентах до 15 октября 2026 поля нет: читается как 0, начатые турниры играют по-старому.
// У финала отрыва нет — там порог, а после лимита решает любой неравный счёт.
export function minLeadOf(format: MatchFormat): number {
  return format.kind === 'fixed' ? (format.minLead ?? 0) : 0;
}
