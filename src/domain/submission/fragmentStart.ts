import { hashText, seededRandom } from '../../shared/random.ts';
import type { Submission } from './intake.ts';

// Начало игрового фрагмента (docs/decisions/2026-10-11-fragment-start.md): фрагмент целиком
// умещается в песню, случайное начало не заходит в концовку.

// Случайное начало не заходит в концовку песни: там затухание или тишина.
export const OUTRO_SEC = 20;

// Позднее начало, при котором фрагмент целиком умещается в песню (и не заходит в последние tailSec):
// иначе в конце остаются секунды затухания или тишина. Длительность известна не всегда.
export function latestStart(submission: Submission, fragmentSec: number, tailSec = 0): number {
  const duration = submission.file.durationSec;
  return duration === undefined ? Number.POSITIVE_INFINITY : Math.max(0, duration - fragmentSec - tailSec);
}

// Сдвиг начала кнопками — в пределах песни.
export function shiftStart(submission: Submission, deltaSec: number, fragmentSec: number): number {
  return Math.min(Math.max(0, submission.startSec + deltaSec), latestStart(submission, fragmentSec));
}

// Бросок: фрагмент целиком в песне и не в концовке. Зависит от seed турнира и счётчика бросков
// участника, поэтому повтор журнала даёт то же начало. undefined — длина неизвестна или песня короткая.
export function rollStart(
  submission: Submission,
  fragmentSec: number,
  seed: number,
  rolls: number,
): { startSec: number; rolls: number } | undefined {
  if (submission.file.durationSec === undefined) return undefined;
  const latest = latestStart(submission, fragmentSec, OUTRO_SEC);
  if (latest === 0) return undefined;
  let startSec = submission.startSec;
  // Выпало то же место — бросаем ещё раз, иначе нажатие ничего не изменит.
  for (let tries = 0; startSec === submission.startSec && tries < 20; tries++) {
    rolls++;
    const random = seededRandom(seed ^ hashText(`${submission.id}:${rolls}`));
    startSec = Math.floor(random() * (latest + 1));
  }
  return { startSec, rolls };
}
