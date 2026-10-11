import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import pg from 'pg';
import { DEFAULT_DATABASE_URL, pgDatabase, type Database } from './database.ts';
import { dropTournament, exportTournament, importTournament, tournamentSummary, type TournamentDump } from './store.ts';

// Турнир в локальной базе: npm run db:backup | db:restore [файл] | db:reset; --yes — без вопроса.
// База — DATABASE_URL из .env. Копии — JSON в backups/: там ID и имена участников, в git они не попадают.
// Перед reset и restore текущий турнир сохраняется в копию — случайный сброс можно откатить.
// В Docker Compose копии делает сервис backup (pg_dump), новый турнир — docker compose down -v.

const BACKUP_DIR = 'backups';
const BACKUP_FILE = /^tournament-\d{8}-\d{6}\.json$/;

const url = process.env.DATABASE_URL?.trim() || DEFAULT_DATABASE_URL;
const where = describe(url);
const [command, ...args] = process.argv.slice(2);
const yes = args.includes('--yes');

const pool = new pg.Pool({ connectionString: url });
try {
  const db = pgDatabase(pool);
  if (command === 'backup') await backup(db);
  else if (command === 'restore') await restore(db, args.find((a) => a !== '--yes'));
  else if (command === 'reset') await reset(db);
  else {
    console.error('Команды: backup, restore [файл], reset');
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Ошибка: ${error instanceof Error ? error.message : String(error)}`);
  const code = (error as { code?: string }).code;
  if (code === 'ECONNREFUSED' || code === '3D000' || code === '28000') {
    console.error(`База ${where}: запущен ли PostgreSQL и верный ли DATABASE_URL в .env?`);
  }
  process.exitCode = 1;
} finally {
  await pool.end();
}

async function backup(db: Database): Promise<void> {
  const file = await saveBackup(db);
  console.log(file ? `Копия турнира: ${file}` : `В базе ${where} турнира нет — копировать нечего.`);
}

async function restore(db: Database, fileArg: string | undefined): Promise<void> {
  const file = fileArg ?? (await latestBackup());
  if (!file) {
    console.error(`В ${BACKUP_DIR}/ нет копий — сначала npm run db:backup.`);
    process.exitCode = 1;
    return;
  }
  const text = await readFile(file, 'utf8').catch(() => {
    throw new Error(`файла ${file} нет`);
  });
  const dump = JSON.parse(text) as TournamentDump;
  if (dump?.format !== 'music-tournament') throw new Error(`${file} — не копия турнира`);
  if (await botRunning(db)) return;

  const created = new Date(dump.createdAt).toLocaleString('ru-RU');
  console.log(`Копия ${file}: турнир «${dump.title}» от ${created}, событий в журнале: ${dump.tables.events?.length ?? 0}.`);
  const current = await tournamentSummary(db);
  if (current) console.log(`Сейчас в базе ${where}: «${current.title}», событий: ${current.events} — сохраню его в копию.`);
  if (!(yes || (await confirm('Восстановить? Напишите «да»: ')))) {
    console.log('Отменено, база не тронута.');
    return;
  }
  const saved = current && (await saveBackup(db));
  await importTournament(db, dump);
  console.log(`Восстановлено${saved ? `, прежний турнир — в ${saved}` : ''}. Запустите npm run bot.`);
}

async function reset(db: Database): Promise<void> {
  if (await botRunning(db)) return;
  const summary = await tournamentSummary(db);
  if (!summary) {
    console.log(`В базе ${where} турнира нет — чистить нечего.`);
    return;
  }
  console.log(`База ${where}: турнир «${summary.title}», событий в журнале: ${summary.events}.`);
  if (!(yes || (await confirm('Удалить его? Копию сохраню в backups/. Напишите «да»: ')))) {
    console.log('Отменено, база не тронута.');
    return;
  }
  const saved = await saveBackup(db);
  await dropTournament(db);
  console.log(`Удалён, копия — ${saved}. npm run bot начнёт новый турнир с параметрами из .env.`);
}

async function saveBackup(db: Database): Promise<string | undefined> {
  const now = new Date();
  const dump = await exportTournament(db, now);
  if (!dump) return undefined;
  await mkdir(BACKUP_DIR, { recursive: true });
  // Местное время в имени: tournament-20261012-153000.
  const two = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`;
  const time = `${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  const file = join(BACKUP_DIR, `tournament-${date}-${time}.json`);
  await writeFile(file, JSON.stringify(dump));
  return file;
}

async function latestBackup(): Promise<string | undefined> {
  try {
    const names = (await readdir(BACKUP_DIR)).filter((name) => BACKUP_FILE.test(name)).sort();
    return names.length > 0 ? join(BACKUP_DIR, names.at(-1)!) : undefined;
  } catch {
    return undefined;
  }
}

// Бот держит соединения открытыми: менять таблицы под работающим ботом нельзя.
async function botRunning(db: Database): Promise<boolean> {
  const { rows } = await db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()',
  );
  if (rows[0]!.n === 0) return false;
  console.error(`К базе ${where} подключён кто-то ещё — похоже, бот запущен. Остановите его (Ctrl+C) и повторите.`);
  process.exitCode = 1;
  return true;
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error('Нет терминала, чтобы спросить. Без вопроса — добавьте --yes: npm run db:reset -- --yes');
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
