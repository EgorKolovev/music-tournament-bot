import { mkdirSync } from 'node:fs';
import { Bot, GrammyError, type Api } from 'grammy';
import pg from 'pg';
import { pgDatabase } from '../storage/database.ts';
import { Store } from '../storage/store.ts';
import { checkFfmpeg, createAudioProcessor, createTelegramDownloader } from '../worker/audioProcessor.ts';
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

// Меню команд в Telegram (кнопка «Меню» у поля ввода): участникам — общие, организатору и админам — ещё свои.
const PUBLIC_COMMANDS = [
  { command: 'matches', description: 'Кто с кем играет' },
  { command: 'status', description: 'Где ты сейчас' },
  { command: 'help', description: 'Что умеет бот' },
];
const ADMIN_COMMANDS = [
  ...PUBLIC_COMMANDS,
  { command: 'tech', description: 'Технический результат: /tech 1.3 <номер победителя> <причина>' },
  { command: 'broadcast', description: 'Сообщение всем участникам' },
];
const ORGANIZER_COMMANDS = [...ADMIN_COMMANDS, { command: 'panel', description: 'Прислать панели заново' }];

async function setCommands(api: Api, organizerId: string, adminIds: string[]): Promise<void> {
  await api.setMyCommands(PUBLIC_COMMANDS);
  const scoped: [string, typeof PUBLIC_COMMANDS][] = [
    ...adminIds.filter((id) => id !== organizerId).map((id): [string, typeof PUBLIC_COMMANDS] => [id, ADMIN_COMMANDS]),
    [organizerId, ORGANIZER_COMMANDS],
  ];
  for (const [id, commands] of scoped) {
    // Пока человек не писал боту, Telegram не знает этот чат — меню появится после перезапуска.
    await api.setMyCommands(commands, { scope: { type: 'chat', chat_id: Number(id) } }).catch((error: unknown) => {
      log.warn(`меню команд для ${id}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

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
  if (settings.audioMode === 'ffmpeg') {
    const problem = await checkFfmpeg(settings.ffmpegPath, settings.ffprobePath);
    if (problem) {
      console.error(
        `AUDIO_MODE=ffmpeg, но ${problem}.\n` +
          'Поставьте ffmpeg (macOS: brew install ffmpeg) или укажите в .env AUDIO_MODE=skip — без нарезки, судья включает песни сам.',
      );
      process.exit(1);
    }
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
  await setCommands(bot.api, settings.tournament.organizerId, settings.tournament.adminIds).catch((error: unknown) => {
    log.warn(`меню команд: ${error instanceof Error ? error.message : String(error)}`);
  });

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
