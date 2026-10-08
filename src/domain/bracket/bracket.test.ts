import { describe, expect, it } from 'vitest';
import {
  buildFinalBracket,
  buildQualifierBracket,
  openMatches,
  playedMatches,
  playersOf,
  qualified,
  type Bracket,
  type Results,
} from './bracket.ts';

const players = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`);

// Играет все открытые матчи, побеждает первый слот.
function playOut(bracket: Bracket): Results {
  const results: Results = {};
  for (let open = openMatches(bracket, results); open.length > 0; open = openMatches(bracket, results)) {
    for (const match of open) results[match.id] = playersOf(bracket, results, match.id)![0];
  }
  return results;
}

describe('отборочная сетка до 8 финалистов', () => {
  it.each([
    [9, 16, 1],
    [16, 16, 8],
    [19, 32, 11],
    [24, 32, 16],
    [32, 32, 24],
  ])('%i игроков: сетка %i, матчей %i — ровно N − 8', (n, size, matches) => {
    const bracket = buildQualifierBracket(players(n), 8, 1);
    expect(bracket.size).toBe(size);
    expect(playedMatches(bracket)).toHaveLength(matches);
  });

  it.each([9, 16, 19, 24, 32])('%i игроков: нет пар из двух пустых мест, каждый игрок ровно один раз', (n) => {
    const bracket = buildQualifierBracket(players(n), 8, 3);
    const placed = bracket.rounds[0]!.flatMap((m) => m.slots.filter((s) => s.kind === 'player'));
    expect(placed).toHaveLength(n);
    expect(new Set(placed.map((s) => (s.kind === 'player' ? s.id : ''))).size).toBe(n);
    for (const match of bracket.rounds[0]!) expect(match.slots[0].kind).toBe('player');
  });

  it.each([9, 16, 19, 24, 32])('%i игроков: после всех матчей ровно 8 финалистов без повторов', (n) => {
    const bracket = buildQualifierBracket(players(n), 8, 5);
    const finalists = qualified(bracket, playOut(bracket));
    expect(finalists).toHaveLength(8);
    expect(new Set(finalists).size).toBe(8);
  });

  it('матч второго круга открывается, как только определились оба соперника', () => {
    const bracket = buildQualifierBracket(players(19), 8, 2);
    const results: Results = {};
    const firstOpen = openMatches(bracket, results);
    // В первом круге 3 матча, а пары второго круга из двух проходов без игры доступны сразу.
    expect(firstOpen.filter((m) => m.round === 1)).toHaveLength(3);
    expect(firstOpen.filter((m) => m.round === 2).length).toBeGreaterThan(0);
  });

  it('один seed — одна сетка', () => {
    expect(buildQualifierBracket(players(19), 8, 7)).toEqual(buildQualifierBracket(players(19), 8, 7));
  });

  it('при N ≤ 8 отбор не нужен', () => {
    expect(playedMatches(buildQualifierBracket(players(8), 8, 1))).toEqual([]);
  });
});

describe('финал 8 → 4 → 2 → 1', () => {
  it('семь матчей и один победитель', () => {
    const bracket = buildFinalBracket(players(8));
    expect(playedMatches(bracket)).toHaveLength(7);
    const results = playOut(bracket);
    expect(qualified(bracket, results)).toEqual(['p1']);
  });
});
