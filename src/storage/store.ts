import type { OutgoingMessage, UserId } from '../bot/protocol.ts';
import type { SlotRecord, SlotStore } from '../telegram/delivery.ts';
import type { StampedEvent } from '../tournament/events.ts';
import type { TournamentState } from '../tournament/tournament.ts';
import type { AudioJob, AudioResult } from '../worker/audioProcessor.ts';
import type { JobSource } from '../worker/workerLoop.ts';
import type { Database, Queryable } from './database.ts';

// Хранение по «минимальному» варианту (docs/telegram-integration.md, раздел 3): журнал событий
// турнира и периодический снимок состояния, плюс inbox, outbox, slot → message_id и очередь
// задач аудио — в PostgreSQL. JSON хранится текстом: jsonb переставил бы ключи, а порядок ключей
// в состоянии влияет на повтор журнала.

export interface OutboxItem {
  id: number;
  message: OutgoingMessage;
  attempts: number;
}

export interface CommitInput {
  event: StampedEvent;
  state: TournamentState;
  out: OutgoingMessage[];
  updateIds: number[];
}

const SNAPSHOT_EVERY = 50;
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
`;

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

  // --- Журнал и снимки ----------------------------------------------------------

  async latestSnapshot(): Promise<{ seq: number; state: TournamentState } | undefined> {
    const { rows } = await this.db.query<{ seq: number; state: string }>(
      'SELECT seq, state FROM snapshots ORDER BY seq DESC LIMIT 1',
    );
    const row = rows[0];
    return row && { seq: row.seq, state: JSON.parse(row.state) as TournamentState };
  }

  async eventsAfter(seq: number): Promise<StampedEvent[]> {
    const { rows } = await this.db.query<{ payload: string }>('SELECT payload FROM events WHERE seq > $1 ORDER BY seq', [seq]);
    return rows.map((r) => JSON.parse(r.payload) as StampedEvent);
  }

  // Начальное состояние турнира: снимок с seq 0 и приветственные сообщения.
  async initialize(state: TournamentState, out: OutgoingMessage[]): Promise<void> {
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
  async snapshot(state: TournamentState): Promise<void> {
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

  // Автор сдвинул начало — задача той же заявки возвращается в очередь с новым началом.
  // Если старая в этот момент режется, её результат уже ничего не закроет (complete по start_sec).
  async enqueueJobs(jobs: AudioJob[]): Promise<number> {
    let added = 0;
    for (const job of jobs) {
      const { rowCount } = await this.db.query(
        `INSERT INTO jobs (submission_id, file_id, size_bytes, start_sec) VALUES ($1, $2, $3, $4)
         ON CONFLICT (submission_id) DO UPDATE
           SET start_sec = EXCLUDED.start_sec, status = 'pending', attempts = 0, not_before = 0, result = NULL
           WHERE jobs.start_sec <> EXCLUDED.start_sec`,
        [job.submissionId, job.fileId, job.sizeBytes ?? null, job.startSec],
      );
      added += rowCount;
    }
    return added;
  }

  async claim(): Promise<AudioJob | undefined> {
    const { rows } = await this.db.query<{ submission_id: string; file_id: string; size_bytes: number | null; start_sec: number }>(
      `UPDATE jobs SET status = 'running'
       WHERE submission_id = (
         SELECT submission_id FROM jobs
         WHERE status = 'pending' AND not_before <= $1 AND attempts < $2
         ORDER BY seq LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       RETURNING submission_id, file_id, size_bytes::float8 AS size_bytes, start_sec`,
      [Date.now(), JOB_ATTEMPTS],
    );
    const row = rows[0];
    return (
      row && {
        submissionId: row.submission_id,
        fileId: row.file_id,
        sizeBytes: row.size_bytes ?? undefined,
        startSec: row.start_sec,
      }
    );
  }

  async complete(result: AudioResult): Promise<void> {
    await this.db.query(`UPDATE jobs SET status = 'done', result = $2 WHERE submission_id = $1 AND start_sec = $3`, [
      result.submissionId,
      JSON.stringify(result),
      result.startSec,
    ]);
  }

  // Временная ошибка: повтор с растущей задержкой (1, 2, 4… минуты, не больше 30);
  // после нескольких попыток файл считается битым.
  async retryLater(job: AudioJob, error: unknown): Promise<void> {
    await this.db.query(
      `UPDATE jobs SET status = 'pending', attempts = attempts + 1,
         not_before = $2 + LEAST(60000 * power(2, attempts), 1800000)::bigint, result = $3
       WHERE submission_id = $1 AND start_sec = $4`,
      [job.submissionId, Date.now(), String(error instanceof Error ? error.message : error), job.startSec],
    );
  }

  // Задачи, исчерпавшие попытки, — превращаются в окончательную неудачу файла.
  async exhaustedJobs(): Promise<AudioJob[]> {
    const { rows } = await this.db.query<{ submission_id: string; file_id: string; start_sec: number }>(
      `SELECT submission_id, file_id, start_sec FROM jobs WHERE status = 'pending' AND attempts >= $1 ORDER BY seq`,
      [JOB_ATTEMPTS],
    );
    return rows.map((r) => ({ submissionId: r.submission_id, fileId: r.file_id, startSec: r.start_sec }));
  }
}

async function enqueueOutbox(tx: Queryable, out: OutgoingMessage[]): Promise<void> {
  for (const message of out) await tx.query('INSERT INTO outbox (payload) VALUES ($1)', [JSON.stringify(message)]);
}
