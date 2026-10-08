import { seededRandom, shuffled } from '../../shared/random.ts';
import type { LibrarySongRef } from './intake.ts';

// Деление библиотеки на пулы после закрытия сбора (docs/decisions/2026-10-08-mechanics-revision.md, раздел 4):
// финалу нужна доля, зависящая от числа участников; песни каждого игрока делятся в этой пропорции
// случайно, с зафиксированным seed. Одна песня никогда не попадает в оба пула.

export interface FinalPoolTarget {
  matches: number;
  tracksPerMatch: number;
  spare: number;
}

// 8 → 4 → 2 → 1: семь матчей, в среднем по 15 треков, плюс запас.
export const DEFAULT_FINAL_TARGET: FinalPoolTarget = { matches: 7, tracksPerMatch: 15, spare: 15 };

export function finalPoolSize(target: FinalPoolTarget): number {
  return target.matches * target.tracksPerMatch + target.spare;
}

export interface PoolSplit {
  seed: number;
  finalTarget: number;
  final: string[];
  main: string[];
}

export function splitPools(songs: readonly LibrarySongRef[], finalTarget: number, seed: number): PoolSplit {
  const random = seededRandom(seed);
  const ratio = songs.length === 0 ? 0 : Math.min(1, finalTarget / songs.length);
  const assigned = new Map<string, 'final' | 'main'>();
  const owners = shuffled([...new Set(songs.flatMap((s) => s.knownBy))].sort(), random);

  for (const owner of owners) {
    const own = songs.filter((s) => s.knownBy.includes(owner));
    const want = Math.round(own.length * ratio);
    let inFinal = own.filter((s) => assigned.get(s.key) === 'final').length;
    // Склеенные дубли уже могли попасть в пул по другому автору — добираем только недостающее.
    for (const song of shuffled(own.filter((s) => !assigned.has(s.key)), random)) {
      const pool = inFinal < want ? 'final' : 'main';
      if (pool === 'final') inFinal++;
      assigned.set(song.key, pool);
    }
  }

  const final = songs.filter((s) => assigned.get(s.key) === 'final').map((s) => s.key);
  const main = songs.filter((s) => assigned.get(s.key) !== 'final').map((s) => s.key);
  return { seed, finalTarget, final, main };
}
