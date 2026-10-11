import { PGlite, type Transaction } from '@electric-sql/pglite';
import type { Database, Queryable } from './database.ts';

// База для тестов: настоящий PostgreSQL в памяти процесса (PGlite), сервер не нужен.
// Одна база может пережить несколько Store — так тесты имитируют перезапуск бота.

export interface TestDatabase extends Database {
  close(): Promise<void>;
}

export function testDatabase(): TestDatabase {
  const db = new PGlite();
  const wrap = (client: PGlite | Transaction): Queryable => ({
    async query<R>(text: string, params?: unknown[]) {
      const result = await client.query<R>(text, params);
      return { rows: result.rows, rowCount: result.affectedRows ?? 0 };
    },
  });
  return {
    ...wrap(db),
    async exec(script) {
      await db.exec(script);
    },
    transaction: (work) => db.transaction((tx) => work(wrap(tx))),
    close: () => db.close(),
  };
}
