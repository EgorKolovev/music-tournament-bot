import { describe, expect, it } from 'vitest';
import { latestStart, OUTRO_SEC, rollStart, shiftStart } from './fragmentStart.ts';
import type { Submission } from './intake.ts';

function song(durationSec: number | undefined, startSec = 0): Submission {
  return {
    id: 's1',
    owner: 'anya',
    file: { fileId: 'f1', fileUniqueId: 'u1', sizeBytes: 5_000_000, durationSec },
    meta: null,
    startSec,
    processing: 'ok',
    rejection: null,
  };
}

describe('начало фрагмента', () => {
  it('фрагмент целиком в песне; длина неизвестна — без ограничения', () => {
    expect(latestStart(song(180), 60)).toBe(120);
    expect(latestStart(song(180), 60, OUTRO_SEC)).toBe(100);
    expect(latestStart(song(45), 60)).toBe(0);
    expect(latestStart(song(undefined), 60)).toBe(Number.POSITIVE_INFINITY);
  });

  it('сдвиг кнопками не выходит за начало и конец', () => {
    expect(shiftStart(song(180, 5), -10, 60)).toBe(0);
    expect(shiftStart(song(180, 115), 10, 60)).toBe(120);
    expect(shiftStart(song(180, 30), 5, 60)).toBe(35);
  });

  it('случайное начало: не в концовке, не прежнее, воспроизводимо', () => {
    let rolls = 0;
    let current = song(180);
    for (let i = 0; i < 50; i++) {
      const roll = rollStart(current, 60, 2026, rolls)!;
      expect(roll.startSec).not.toBe(current.startSec);
      expect(roll.startSec).toBeGreaterThanOrEqual(0);
      expect(roll.startSec).toBeLessThanOrEqual(100);
      expect(roll.rolls).toBeGreaterThan(rolls);
      expect(rollStart(current, 60, 2026, rolls)).toEqual(roll);
      rolls = roll.rolls;
      current = song(180, roll.startSec);
    }
  });

  it('короткой песне и песне без длины случайное начало не выбрать', () => {
    expect(rollStart(song(70), 60, 2026, 0)).toBeUndefined();
    expect(rollStart(song(undefined), 60, 2026, 0)).toBeUndefined();
  });
});
