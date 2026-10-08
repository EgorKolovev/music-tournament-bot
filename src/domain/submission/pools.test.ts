import { describe, expect, it } from 'vitest';
import type { LibrarySongRef } from './intake.ts';
import { DEFAULT_FINAL_TARGET, finalPoolSize, splitPools } from './pools.ts';

function library(players: number, perPlayer: number, shared: [number, number][] = []): LibrarySongRef[] {
  const songs: LibrarySongRef[] = [];
  for (let p = 0; p < players; p++) {
    for (let i = 0; i < perPlayer; i++) {
      songs.push({
        key: `p${p}-s${i}`,
        meta: { artist: `A${p}`, title: `T${i}`, variants: [] },
        submissionIds: [],
        knownBy: [`p${p}`],
      });
    }
  }
  // Склеенные дубли: песню знают двое.
  for (const [a, b] of shared) songs.find((s) => s.key === `p${a}-s0`)!.knownBy.push(`p${b}`);
  return songs;
}

describe('деление на пулы', () => {
  it('финалу по умолчанию нужно около 120 песен', () => {
    expect(finalPoolSize(DEFAULT_FINAL_TARGET)).toBe(120);
  });

  it.each([
    [16, 120],
    [20, 120],
    [32, 120],
  ])('%i игроков по 10 песен: финал около %i', (players, target) => {
    const split = splitPools(library(players, 10), target, 7);
    expect(Math.abs(split.final.length - target)).toBeLessThanOrEqual(players / 2);
    expect(split.final.length + split.main.length).toBe(players * 10);
  });

  it('песня не попадает в оба пула, у каждого игрока доля близка к общей', () => {
    const songs = library(20, 10, [
      [0, 1],
      [2, 3],
    ]);
    const split = splitPools(songs, 120, 42);
    expect(new Set([...split.final, ...split.main]).size).toBe(songs.length);
    for (let p = 0; p < 20; p++) {
      const own = songs.filter((s) => s.knownBy.includes(`p${p}`)).map((s) => s.key);
      const inFinal = own.filter((k) => split.final.includes(k)).length;
      expect(Math.abs(inFinal - own.length * 0.6)).toBeLessThanOrEqual(1.5);
    }
  });

  it('один и тот же seed даёт то же деление', () => {
    const songs = library(20, 10);
    expect(splitPools(songs, 120, 5)).toEqual(splitPools(songs, 120, 5));
    expect(splitPools(songs, 120, 5).final).not.toEqual(splitPools(songs, 120, 6).final);
  });

  it('если песен меньше, чем нужно финалу, все идут в финал', () => {
    const split = splitPools(library(8, 10), 120, 1);
    expect(split.main).toEqual([]);
    expect(split.final).toHaveLength(80);
  });
});
