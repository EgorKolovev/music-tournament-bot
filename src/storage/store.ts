import type { OutgoingMessage, UserId } from '../bot/protocol.ts';
import type { SlotRecord, SlotStore } from '../telegram/delivery.ts';
import { fromSnapshot, type BotState } from '../tournament/bot.ts';
import type { StampedEvent } from '../tournament/events.ts';
import type { TournamentState } from '../tournament/tournament.ts';
import type { AudioJob, AudioResult } from '../worker/audioProcessor.ts';
import type { JobSource } from '../worker/workerLoop.ts';
import type { Database, Queryable } from './database.ts';

// Хранение по «минимальному» варианту (docs/telegram-integration.md, раздел 3): журнал событий
// и периодический снимок состояния, плюс inbox, outbox, slot → message_id и очередь задач аудио —
// в PostgreSQL. JSON хранится текстом: jsonb переставил бы ключи, а порядок ключей в состоянии
// влияет на повтор журнала. Снимок — все турниры бота разом; снимки до нескольких турниров — один
// турнир без обёртки (fromSnapshot).

export interface OutboxItem {
  id: number;
  message: OutgoingMessage;
  attempts: number;
}

// Снимок в базе: состояние бота или, у снимков прошлых версий, один турнир.
export type StoredState = BotState | TournamentState;

export interface CommitInput {
  event: StampedEvent;
  state: BotState;
  out: OutgoingMessage[];
  updateIds: number[];
}

const SNAPSHOT_EVERY = 50;
const TABLES = ['events', 'snapshots', 'inbox', 'outbox', 'slots', 'jobs'];
const JOB_ATTEMPTS = 5;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    seq SERIAL PRIMARY KEY,
    at BIGINT NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS snapshots (
    seq INTEGER PRIMARY KEY,
    state TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS inbox (
    update_id BIGINT PRIMARY KEY
  );
  CREATE TABLE IF NOT EXISTS outbox (
    id SERIAL PRIMARY KEY,
    payload TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS outbox_pending ON outbox (status, id);
  CREATE TABLE IF NOT EXISTS slots (
    chat_id TEXT NOT NULL,
    slot TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    file_id TEXT,
    PRIMARY KEY (chat_id, slot)
  );
  CREATE TABLE IF NOT EXISTS jobs (
    seq SERIAL,
    submission_id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL,
    size_bytes BIGINT,
    start_sec INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    not_before BIGINT NOT NULL DEFAULT 0,
    result TEXT
  );
  ALTER TABLE jobs ADD COLUMN IF NOT EXISTS start_sec INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE jobs ADD COLUMN IF NOT EXISTS fragment_sec INTEGER;
`;

// Что лежит в базе — чтобы подтвердить удаление. undefined — турнира нет. title — названия всех
// турниров бота через запятую.
export async function tournamentSummary(db: Queryable): Promise<{ title: string; events: number } | undefined> {
  const { rows } = await db.query<{ exists: boolean }>(`SELECT to_regclass('snapshots') IS NOT NULL AS exists`);
  if (!rows[0]!.exists) return undefined;
  const snapshot = await db.query<{ state: string }>('SELECT state FROM snapshots ORDER BY seq DESC LIMIT 1');
  if (snapshot.rows.length === 0) return undefined;
  const { tournaments } = fromSnapshot(JSON.parse(snapshot.rows[0]!.state) as StoredState);
  const events = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM events');
  return { title: tournaments.map((t) => t.state.config.title).join('», «'), events: events.rows[0]!.n };
}

// Турнир целиком: следующий Store.open создаст таблицы пустыми, бот начнёт новый турнир.
export async function dropTournament(db: Database): Promise<void> {
  await db.exec(`DROP TABLE IF EXISTS ${TABLES.join(', ')}`);
}

// Копия турнира для локальной разработки: строки всех таблиц бота в JSON, без pg_dump.
export interface TournamentDump {
  format: 'music-tournament';
  version: 1;
  title: string;
  createdAt: string;
  tables: Record<string, Record<string, unknown>[]>;
}

// Счётчики, которые после восстановления должны продолжиться с последнего номера.
const SERIALS = [
  ['events', 'seq'],
  ['outbox', 'id'],
  ['jobs', 'seq'],
] as const;

// Все таблицы одним согласованным срезом: копию можно снимать, пока бот работает.
export async function exportTournament(db: Database, createdAt: Date): Promise<TournamentDump | undefined> {
  const summary = await tournamentSummary(db);
  if (!summary) return undefined;
  const tables = await db.transaction(async (tx) => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const result: TournamentDump['tables'] = {};
    for (const table of TABLES) {
      const { rows } = await tx.query<{ rows: Record<string, unknown>[] }>(
        `SELECT coalesce(json_agg(t), '[]'::json) AS rows FROM ${table} t`,
      );
      result[table] = rows[0]!.rows;
    }
    return result;
  });
  return { format: 'music-tournament', version: 1, title: summary.title, createdAt: createdAt.toISOString(), tables };
}

// Заменить турнир в базе копией. Колонки, которых в копии нет (она снята старой версией бота),
// получают значения по умолчанию.
export async function importTournament(db: Database, dump: TournamentDump): Promise<void> {
  if (dump?.format !== 'music-tournament' || dump.version !== 1) throw new Error('это не копия турнира');
  await dropTournament(db);
  await Store.open(db);
  await db.transaction(async (tx) => {
    for (const table of TABLES) {
      const rows = dump.tables[table] ?? [];
      if (rows.length === 0) continue;
      const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
      if (columns.some((c) => !/^[a-z_]+$/.test(c))) throw new Error(`непонятная колонка в таблице ${table}`);
      const list = columns.join(', ');
      await tx.query(`INSERT INTO ${table} (${list}) SELECT ${list} FROM json_populate_recordset(null::${table}, $1)`, [
        JSON.stringify(rows),
      ]);
    }
    for (const [table, column] of SERIALS) {
      await tx.query(
        `SELECT setval(pg_get_serial_sequence('${table}', '${column}'), coalesce(max(${column}), 0) + 1, false) FROM ${table}`,
      );
    }
  });
}

export class Store implements SlotStore, JobSource {
  private readonly db: Database;
  private sinceSnapshot = 0;

  private constructor(db: Database) {
    this.db = db;
  }

  static async open(db: Database): Promise<Store> {
    await db.exec(SCHEMA);
    // Задачи, взятые до падения процесса, возвращаются в очередь.
    await db.query(`UPDATE jobs SET status = 'pending' WHERE status = 'running'`);
    return new Store(db);
  }

  // Копия всей базы для организатора — то же, что сохраняет npm run db:backup.
  dump(createdAt: Date): Promise<TournamentDump | undefined> {
    return exportTournament(this.db, createdAt);
  }

  // --- Журнал и снимки ----------------------------------------------------------

  async latestSnapshot(): Promise<{ seq: number; state: StoredState } | undefined> {
    const { rows } = await this.db.query<{ seq: number; state: string }>(
      'SELECT seq, state FROM snapshots ORDER BY seq DESC LIMIT 1',
    );
    const row = rows[0];
    return row && { seq: row.seq, state: JSON.parse(row.state) as StoredState };
  }

  async eventsAfter(seq: number): Promise<StampedEvent[]> {
    const { rows } = await this.db.query<{ payload: string }>('SELECT payload FROM events WHERE seq > $1 ORDER BY seq', [seq]);
    return rows.map((r) => JSON.parse(r.payload) as StampedEvent);
  }

  // Начальное состояние бота: снимок с seq 0 и приветственные сообщения.
  async initialize(state: BotState, out: OutgoingMessage[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query('INSERT INTO snapshots (seq, state) VALUES (0, $1)', [JSON.stringify(state)]);
      await enqueueOutbox(tx, out);
    });
  }

  // Одна транзакция на событие: журнал, исходящие и inbox фиксируются вместе. Сбой отправки
  // после commit не откатывает игру — сообщения останутся в outbox до доставки.
  async commit({ event, state, out, updateIds }: CommitInput): Promise<void> {
    const snapshotDue = this.sinceSnapshot + 1 >= SNAPSHOT_EVERY;
    await this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ seq: number }>('INSERT INTO events (at, payload) VALUES ($1, $2) RETURNING seq', [
        event.at,
        JSON.stringify(event),
      ]);
      for (const id of updateIds) await tx.query('INSERT INTO inbox (update_id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
      await enqueueOutbox(tx, out);
      if (snapshotDue) {
        await tx.query('INSERT INTO snapshots (seq, state) VALUES ($1, $2)', [rows[0]!.seq, JSON.stringify(state)]);
        await tx.query('DELETE FROM snapshots WHERE seq NOT IN (SELECT seq FROM snapshots ORDER BY seq DESC LIMIT 3)');
      }
    });
    this.sinceSnapshot = snapshotDue ? 0 : this.sinceSnapshot + 1;
  }

  // Принудительный снимок при остановке: следующий запуск не будет повторять журнал.
  async snapshot(state: BotState): Promise<void> {
    await this.db.query(
      `INSERT INTO snapshots (seq, state) VALUES ((SELECT COALESCE(MAX(seq), 0) FROM events), $1)
       ON CONFLICT (seq) DO UPDATE SET state = EXCLUDED.state`,
      [JSON.stringify(state)],
    );
    this.sinceSnapshot = 0;
  }

  // --- Inbox ---------------------------------------------------------------------

  async seenUpdate(updateId: number): Promise<boolean> {
    const { rows } = await this.db.query('SELECT 1 FROM inbox WHERE update_id = $1', [updateId]);
    return rows.length > 0;
  }

  // Отметить update, который не стал событием турнира (служебный, из группы и т. п.).
  async markUpdate(updateId: number): Promise<void> {
    await this.db.query('INSERT INTO inbox (update_id) VALUES ($1) ON CONFLICT DO NOTHING', [updateId]);
  }

  // --- Outbox --------------------------------------------------------------------

  async pendingOutbox(limit = 100): Promise<OutboxItem[]> {
    const { rows } = await this.db.query<{ id: number; payload: string; attempts: number }>(
      `SELECT id, payload, attempts FROM outbox WHERE status = 'pending' ORDER BY id LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({ id: r.id, message: JSON.parse(r.payload) as OutgoingMessage, attempts: r.attempts }));
  }

  async markSent(id: number): Promise<void> {
    await this.db.query(`UPDATE outbox SET status = 'sent', payload = '{}' WHERE id = $1`, [id]);
  }

  async markFailed(id: number, error: string, giveUp: boolean): Promise<void> {
    await this.db.query(
      `UPDATE outbox SET attempts = attempts + 1, error = $2, status = CASE WHEN $3 THEN 'failed' ELSE status END WHERE id = $1`,
      [id, error, giveUp],
    );
  }

  // --- Слоты ---------------------------------------------------------------------

  async get(chatId: UserId, slot: string): Promise<SlotRecord | undefined> {
    const { rows } = await this.db.query<{ message_id: number; kind: SlotRecord['kind']; file_id: string | null }>(
      'SELECT message_id, kind, file_id FROM slots WHERE chat_id = $1 AND slot = $2',
      [chatId, slot],
    );
    const row = rows[0];
    return row && { messageId: row.message_id, kind: row.kind, fileId: row.file_id ?? undefined };
  }

  async set(chatId: UserId, slot: string, record: SlotRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO slots (chat_id, slot, message_id, kind, file_id) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (chat_id, slot) DO UPDATE SET message_id = EXCLUDED.message_id, kind = EXCLUDED.kind, file_id = EXCLUDED.file_id`,
      [chatId, slot, record.messageId, record.kind, record.fileId ?? null],
    );
  }

  async forgetChat(chatId: UserId): Promise<void> {
    await this.db.query('DELETE FROM slots WHERE chat_id = $1', [chatId]);
  }

  // --- Очередь аудио ---------------------------------------------------------------

  // Автор сдвинул начало или организатор сменил длину фрагмента — задача той же заявки возвращается
  // в очередь. Если старая в этот момент режется, её результат уже ничего не закроет (complete по
  // start_sec и fragment_sec). У задач прошлых версий fragment_sec нет — worker режет по умолчанию.
  async enqueueJobs(jobs: AudioJob[]): Promise<number> {
    let added = 0;
    for (const job of jobs) {
      const { rowCount } = await this.db.query(
        `INSERT INTO jobs (submission_id, file_id, size_bytes, start_sec, fragment_sec) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (submission_id) DO UPDATE
           SET start_sec = EXCLUDED.start_sec, fragment_sec = EXCLUDED.fragment_sec,
             status = 'pending', attempts = 0, not_before = 0, result = NULL
           WHERE jobs.start_sec <> EXCLUDED.start_sec OR jobs.fragment_sec IS DISTINCT FROM EXCLUDED.fragment_sec`,
        [job.submissionId, job.fileId, job.sizeBytes ?? null, job.startSec, job.fragmentSec ?? null],
      );
      added += rowCount;
    }
    return added;
  }

  async claim(): Promise<AudioJob | undefined> {
    const { rows } = await this.db.query<{
      submission_id: string;
      file_id: string;
      size_bytes: number | null;
      start_sec: number;
      fragment_sec: number | null;
    }>(
      `UPDATE jobs SET status = 'running'
       WHERE submission_id = (
         SELECT submission_id FROM jobs
         WHERE status = 'pending' AND not_before <= $1 AND attempts < $2
         ORDER BY seq LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       RETURNING submission_id, file_id, size_bytes::float8 AS size_bytes, start_sec, fragment_sec`,
      [Date.now(), JOB_ATTEMPTS],
    );
    const row = rows[0];
    return (
      row && {
        submissionId: row.submission_id,
        fileId: row.file_id,
        sizeBytes: row.size_bytes ?? undefined,
        startSec: row.start_sec,
        fragmentSec: row.fragment_sec ?? undefined,
      }
    );
  }

  async complete(result: AudioResult): Promise<void> {
    await this.db.query(
      `UPDATE jobs SET status = 'done', result = $2
       WHERE submission_id = $1 AND start_sec = $3 AND fragment_sec IS NOT DISTINCT FROM $4`,
      [result.submissionId, JSON.stringify(result), result.startSec, result.fragmentSec ?? null],
    );
  }

  // Временная ошибка: повтор с растущей задержкой (1, 2, 4… минуты, не больше 30);
  // после нескольких попыток файл считается битым.
  async retryLater(job: AudioJob, error: unknown): Promise<void> {
    await this.db.query(
      `UPDATE jobs SET status = 'pending', attempts = attempts + 1,
         not_before = $2 + LEAST(60000 * power(2, attempts), 1800000)::bigint, result = $3
       WHERE submission_id = $1 AND start_sec = $4 AND fragment_sec IS NOT DISTINCT FROM $5`,
      [job.submissionId, Date.now(), String(error instanceof Error ? error.message : error), job.startSec, job.fragmentSec ?? null],
    );
  }

  // Задачи, исчерпавшие попытки, — превращаются в окончательную неудачу файла.
  async exhaustedJobs(): Promise<AudioJob[]> {
    const { rows } = await this.db.query<{ submission_id: string; file_id: string; start_sec: number; fragment_sec: number | null }>(
      `SELECT submission_id, file_id, start_sec, fragment_sec FROM jobs WHERE status = 'pending' AND attempts >= $1 ORDER BY seq`,
      [JOB_ATTEMPTS],
    );
    return rows.map((r) => ({
      submissionId: r.submission_id,
      fileId: r.file_id,
      startSec: r.start_sec,
      fragmentSec: r.fragment_sec ?? undefined,
    }));
  }
}

async function enqueueOutbox(tx: Queryable, out: OutgoingMessage[]): Promise<void> {
  for (const message of out) await tx.query('INSERT INTO outbox (payload) VALUES ($1)', [JSON.stringify(message)]);
}
