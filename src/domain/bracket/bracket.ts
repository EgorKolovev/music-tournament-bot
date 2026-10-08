import { seededRandom, shuffled } from '../../shared/random.ts';

// Сетка на выбывание с зафиксированной жеребьёвкой (docs/architecture.md, раздел 4).
// Размер полной сетки — ближайшая степень двойки; пустые места дают проходы без игры
// и распределяются по первому кругу так, чтобы не было пар из двух пустых мест.

export type Slot = { kind: 'player'; id: string } | { kind: 'bye' } | { kind: 'winnerOf'; matchId: string };

export interface BracketMatch {
  id: string;
  round: number;
  slots: [Slot, Slot];
  // Проход без игры: матча нет, игрок проходит дальше без очков и статистики.
  isBye: boolean;
}

export interface Bracket {
  seed: number;
  size: number;
  rounds: BracketMatch[][];
}

export function nextPowerOfTwo(n: number): number {
  let size = 1;
  while (size < n) size *= 2;
  return size;
}

// Отбор до `finalists` мест: каждая ветка размера size/finalists даёт одного финалиста.
export function buildQualifierBracket(playerIds: readonly string[], finalists: number, seed: number): Bracket {
  if (playerIds.length <= finalists) return { seed, size: playerIds.length, rounds: [] };
  const size = Math.max(nextPowerOfTwo(playerIds.length), finalists * 2);
  const pairs = size / 2;
  const byes = size - playerIds.length;

  // Проходы равномерно по парам первого круга, а значит и по веткам.
  const byePairs = new Set(Array.from({ length: byes }, (_, i) => Math.floor((i * pairs) / byes)));
  const order = shuffled(playerIds, seededRandom(seed));
  const firstRound: BracketMatch[] = [];
  let next = 0;
  for (let i = 0; i < pairs; i++) {
    const first: Slot = { kind: 'player', id: order[next++]! };
    const second: Slot = byePairs.has(i) ? { kind: 'bye' } : { kind: 'player', id: order[next++]! };
    firstRound.push({ id: `r1-${i + 1}`, round: 1, slots: [first, second], isBye: second.kind === 'bye' });
  }

  const rounds = [firstRound];
  while (rounds.at(-1)!.length > finalists) {
    const previous = rounds.at(-1)!;
    const round = rounds.length + 1;
    const matches: BracketMatch[] = [];
    for (let i = 0; i < previous.length; i += 2) {
      matches.push({
        id: `r${round}-${i / 2 + 1}`,
        round,
        slots: [
          { kind: 'winnerOf', matchId: previous[i]!.id },
          { kind: 'winnerOf', matchId: previous[i + 1]!.id },
        ],
        isBye: false,
      });
    }
    rounds.push(matches);
  }
  return { seed, size, rounds };
}

// Финал 8 → 4 → 2 → 1 в заданном порядке посева.
export function buildFinalBracket(finalistIds: readonly string[]): Bracket {
  const first: BracketMatch[] = [];
  for (let i = 0; i < finalistIds.length; i += 2) {
    first.push({
      id: `f1-${i / 2 + 1}`,
      round: 1,
      slots: [
        { kind: 'player', id: finalistIds[i]! },
        { kind: 'player', id: finalistIds[i + 1]! },
      ],
      isBye: false,
    });
  }
  const rounds = [first];
  while (rounds.at(-1)!.length > 1) {
    const previous = rounds.at(-1)!;
    const round = rounds.length + 1;
    rounds.push(
      Array.from({ length: previous.length / 2 }, (_, i) => ({
        id: `f${round}-${i + 1}`,
        round,
        slots: [
          { kind: 'winnerOf', matchId: previous[2 * i]!.id },
          { kind: 'winnerOf', matchId: previous[2 * i + 1]!.id },
        ] as [Slot, Slot],
        isBye: false,
      })),
    );
  }
  return { seed: 0, size: finalistIds.length, rounds };
}

export function playedMatches(bracket: Bracket): BracketMatch[] {
  return bracket.rounds.flat().filter((m) => !m.isBye);
}

export function findMatch(bracket: Bracket, matchId: string): BracketMatch | undefined {
  return bracket.rounds.flat().find((m) => m.id === matchId);
}

// Результаты: matchId → id победителя. Проход без игры побеждает сам.
export type Results = Record<string, string>;

export function winnerOf(bracket: Bracket, results: Results, matchId: string): string | undefined {
  const match = findMatch(bracket, matchId);
  if (!match) return undefined;
  if (match.isBye) return resolveSlot(bracket, results, match.slots[0]);
  return results[matchId];
}

export function resolveSlot(bracket: Bracket, results: Results, slot: Slot): string | undefined {
  if (slot.kind === 'player') return slot.id;
  if (slot.kind === 'bye') return undefined;
  return winnerOf(bracket, results, slot.matchId);
}

// Пара матча, если обе стороны уже определены.
export function playersOf(bracket: Bracket, results: Results, matchId: string): [string, string] | undefined {
  const match = findMatch(bracket, matchId);
  if (!match || match.isBye) return undefined;
  const a = resolveSlot(bracket, results, match.slots[0]);
  const b = resolveSlot(bracket, results, match.slots[1]);
  return a && b ? [a, b] : undefined;
}

// Матч можно открыть, когда обе стороны подтверждены, не дожидаясь всего круга.
export function openMatches(bracket: Bracket, results: Results): BracketMatch[] {
  return playedMatches(bracket).filter((m) => !results[m.id] && playersOf(bracket, results, m.id));
}

export function qualified(bracket: Bracket, results: Results): string[] {
  const last = bracket.rounds.at(-1) ?? [];
  return last.map((m) => winnerOf(bracket, results, m.id)).filter((id): id is string => id !== undefined);
}
