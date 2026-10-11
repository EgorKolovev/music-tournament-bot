import { mkdirSync } from 'node:fs';
import { Bot, GrammyError } from 'grammy';
import pg from 'pg';
import { pgDatabase } from '../storage/database.ts';
import { Store } from '../storage/store.ts';
import { createAudioProcessor, createTelegramDownloader } from '../worker/audioProcessor.ts';
import { skipProcessor, WorkerLoop } from '../worker/workerLoop.ts';
import { ConfigError, readSettings } from './config.ts';
import type { Logger } from './delivery.ts';
import { Runtime } from './runtime.ts';

// Точка входа бота: npm run bot. Long polling grammY, один процесс на токен и на базу.

const log: Logger = {
  info: (message) => console.log(`[bot] ${message}`),
  warn: (message) => console.warn(`[bot] ⚠️ ${message}`),
  error: (message, error) => console.error(`[bot] ❌ ${message}`, error ?? ''),
};

const TICK_MS = 15_000;

async function main(): Promise<void> {
  let settings;
  try {
    settings = readSettings(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`${error.message}\nСкопируйте .env.example в .env и заполните.`);
      process.exit(1);
    }
    throw error;
  }

  const bot = new Bot(settings.token, { client: { apiRoot: settings.apiBaseUrl } });
  try {
    await bot.init();
  } catch (error) {
    if (error instanceof GrammyError && error.error_code === 401) {
      log.error('неверный BOT_TOKEN — остановка');
      process.exit(1);
    }
    throw error;
  }
  const me = bot.botInfo;
  mkdirSync(settings.tmpDir, { recursive: true });

  const pool = new pg.Pool({ connectionString: settings.databaseUrl });
  // Обрыв простаивающего соединения не должен ронять процесс: пул откроет новое.
  pool.on('error', (error) => log.warn(`PostgreSQL: ${error.message}`));
  const store = await Store.open(pgDatabase(pool));

  const abort = new AbortController();
  const worker: { loop?: WorkerLoop } = {};
  const runtime = await Runtime.create({
    api: bot.api,
    store,
    config: { ...settings.tournament, botUsername: me.username },
    log,
    onJobs: () => worker.loop?.kick(),
  });
  const { config } = runtime.state;
  log.info(`@${me.username}: «${config.title}», этап ${runtime.state.phase}, аудио ${settings.audioMode}`);
  log.info(`приглашение: https://t.me/${me.username}?start=t_${config.code}`);

  worker.loop = new WorkerLoop({
    source: store,
    process:
      settings.audioMode === 'skip'
        ? skipProcessor
        : createAudioProcessor({
            api: bot.api,
            downloadFile: createTelegramDownloader(settings.token),
            serviceChatId: settings.serviceChatId!,
            tmpDir: settings.tmpDir,
            // Длина фрагмента — параметр турнира, зафиксированный в базе при первом запуске.
            fragmentSec: config.fragmentSec,
            ffmpegPath: settings.ffmpegPath,
            ffprobePath: settings.ffprobePath,
            log,
          }),
    onResult: (result) => void runtime.workerResult(result),
    log,
  });
  const workerDone = worker.loop.start(abort.signal);

  const ticker = setInterval(() => void runtime.tick(), TICK_MS);
  let stopping = false;
  const stop = () => {
    stopping = true;
    void bot.stop();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  await runtime.resume();
  // Update сразу уходит в Runtime и polling его не ждёт: повторы отсеивает inbox в базе,
  // порядок держит очередь событий.
  bot.use((ctx) => void runtime.receive(ctx.update));
  try {
    if (!stopping) await bot.start({ allowed_updates: ['message', 'callback_query'] });
  } catch (error) {
    if (error instanceof GrammyError && error.error_code === 409) {
      log.error('другой процесс уже читает updates этого бота — остановка');
    } else {
      log.error('long polling остановлен', error);
    }
    process.exitCode = 1;
  }

  abort.abort();
  clearInterval(ticker);
  await workerDone;
  await runtime.stop();
  await pool.end();
  log.info('остановлен');
}

await main();
