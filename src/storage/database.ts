import type { Pool, PoolClient } from 'pg';

// Минимальный доступ к PostgreSQL, который нужен хранилищу. В проде — пул pg,
// в тестах — PGlite (тот же PostgreSQL, собранный в WASM, без сервера).

export interface Queryable {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number }>;
}

export interface Database extends Queryable {
  // Несколько команд одной строкой, без параметров — для схемы.
  exec(script: string): Promise<void>;
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
}

export function pgDatabase(pool: Pool): Database {
  const wrap = (client: Pool | PoolClient): Queryable => ({
    async query<R>(text: string, params?: unknown[]) {
      const result = await client.query(text, params);
      return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 };
    },
  });
  return {
    ...wrap(pool),
    async exec(script) {
      await pool.query(script);
    },
    async transaction(work) {
      const client = await pool.connect();
      let broken: Error | undefined;
      try {
        await client.query('BEGIN');
        const result = await work(wrap(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          // Соединение сломано — пул его закроет, а не выдаст снова.
          broken = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
        }
        throw error;
      } finally {
        client.release(broken);
      }
    },
  };
}
