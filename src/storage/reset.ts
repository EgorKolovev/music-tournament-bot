import { createInterface } from 'node:readline/promises';
import pg from 'pg';
import { DEFAULT_DATABASE_URL, pgDatabase } from './database.ts';
import { dropTournament, tournamentSummary } from './store.ts';

// Новый турнир с нуля: npm run db:reset (без вопроса — npm run db:reset -- --yes).
// Удаляет таблицы бота в базе из DATABASE_URL; следующий npm run bot создаст их заново
// с параметрами турнира из .env. В Docker Compose вместо этого — docker compose down -v.

const url = process.env.DATABASE_URL?.trim() || DEFAULT_DATABASE_URL;
const where = describe(url);
const pool = new pg.Pool({ connectionString: url });

try {
  const db = pgDatabase(pool);
  // Бот держит соединения открытыми: таблицы под работающим ботом удалять нельзя.
  const { rows } = await db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()',
  );
  const summary = await tournamentSummary(db);
  if (rows[0]!.n > 0) {
    console.error(`К базе ${where} подключён кто-то ещё — похоже, бот запущен. Остановите его (Ctrl+C) и повторите.`);
    process.exitCode = 1;
  } else if (!summary) {
    console.log(`В базе ${where} турнира нет — чистить нечего.`);
  } else {
    console.log(`База ${where}: турнир «${summary.title}», событий в журнале: ${summary.events}.`);
    if (process.argv.includes('--yes') || (await confirm('Удалить его безвозвратно? Напишите «да»: '))) {
      await dropTournament(db);
      console.log('Удалён. npm run bot начнёт новый турнир с параметрами из .env.');
    } else {
      console.log('Отменено, база не тронута.');
    }
  }
} catch (error) {
  console.error(`Не получилось подключиться к ${where}: ${error instanceof Error ? error.message : String(error)}`);
  console.error('Запущен ли PostgreSQL и верный ли DATABASE_URL в .env?');
  process.exitCode = 1;
} finally {
  await pool.end();
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error('Нет терминала, чтобы спросить. Чтобы удалить без вопроса: npm run db:reset -- --yes');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return ['да', 'yes'].includes((await rl.question(question)).trim().toLowerCase());
  } finally {
    rl.close();
  }
}

// Адрес базы без пользователя и пароля — для сообщений.
function describe(connection: string): string {
  try {
    const parsed = new URL(connection);
    return `${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`;
  } catch {
    return 'из DATABASE_URL';
  }
}
