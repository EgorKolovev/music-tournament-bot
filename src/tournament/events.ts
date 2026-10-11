import type { UserId } from '../bot/protocol.ts';
import type { AudioFile } from '../domain/submission/intake.ts';

// События турнира. Каждое приходит с временем `at` (мс) от транспорта — повтор журнала
// событий даёт то же состояние, что и живая обработка.

export interface Sender {
  id: UserId;
  name: string;
  username?: string;
}

export type TournamentEvent =
  | { kind: 'button'; from: Sender; data: string }
  | { kind: 'text'; from: Sender; text: string }
  | { kind: 'command'; from: Sender; command: string; payload: string }
  | { kind: 'files'; from: Sender; files: AudioFile[] }
  | { kind: 'worker'; results: { submissionId: string; ok: boolean; gameFileId?: string }[] }
  // Периодическая проверка напоминаний и сроков.
  | { kind: 'tick' };

export interface StampedEvent {
  at: number;
  event: TournamentEvent;
}
