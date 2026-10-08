import type { Participant } from '../bot/matchSession.ts';
import type { Incoming, Outgoing } from '../bot/protocol.ts';
import type { AudioFile } from '../domain/submission/intake.ts';

// Общий интерфейс для симулятора и тестов: что за бот, кто в нём участвует и как он реагирует.

export type Role = 'judge' | 'p0' | 'p1' | 'org';

export interface Column {
  role: Role;
  user: Participant;
  caption: string;
}

// Файл из фейкового каталога: что Telegram сообщит о нём и что потом решит worker.
export interface CatalogFile {
  file: AudioFile;
  note: string;
  corrupt?: boolean;
}

export interface Engine<S> {
  id: 'match' | 'intake';
  title: string;
  columns: Column[];
  // Можно ли участникам писать текст и пересылать файлы.
  composer: boolean;
  catalog: Record<string, CatalogFile>;
  open(): { session: S; out: Outgoing[] };
  handle(session: S, input: Incoming): { session: S; out: Outgoing[] };
  // Событие фейкового worker для файлов в очереди; null — очередь пуста.
  workerEvent(session: S): Incoming | null;
}

export type ScenarioStep =
  | { as: Role; press: string }
  | { as: Role; send: string }
  | { as: Role; forward: string[] }
  | { worker: true };

export interface Scenario {
  id: string;
  engine: Engine<unknown>['id'];
  title: string;
  description: string;
  steps: ScenarioStep[];
}
