import type { InlineKeyboardMarkup, Update } from 'grammy/types';
import { afterEach, describe, expect, it } from 'vitest';
import { matchPlayers } from '../bot/drawSession.ts';
import { Store } from '../storage/store.ts';
import { testDatabase, type TestDatabase } from '../storage/testDatabase.ts';
import { ORGANIZER, testConfig } from '../tournament/testBot.ts';
import { buttonUpdate, FakeApi, privateChat, silentLog, textUpdate, user } from './fakeApi.ts';
import { Runtime } from './runtime.ts';

const databases: TestDatabase[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) await db.close();
});

function database(): TestDatabase {
  const db = testDatabase();
  databases.push(db);
  return db;
}

// Запуск бота над базой. Повторный boot над той же базой — перезапуск процесса:
// новый Store и Runtime, в памяти ничего не осталось.
async function boot(db: TestDatabase = database(), api = new FakeApi()) {
  const store = await Store.open(db);
  let clock = Date.parse('2026-10-10T10:00:00Z');
  let jobs = 0;
  const runtime = await Runtime.create({
    api,
    store,
    config: testConfig(),
    log: silentLog,
    sleep: async () => {},
    now: () => (clock += 1000),
    onJobs: () => jobs++,
    batchQuietMs: 0,
  });
  return { api, store, runtime, jobs: () => jobs };
}

// Кнопки, которые видит пользователь в Telegram: по вызовам Bot API.
function visibleData(api: FakeApi, chatId: string, action: string): string | undefined {
  const keyboards = new Map<number, InlineKeyboardMarkup>();
  let nextId = 100;
  for (const { method, params } of api.calls) {
    if (method.startsWith('send')) {
      const id = nextId++;
      if (params.chat_id === chatId && params.reply_markup) keyboards.set(id, params.reply_markup as InlineKeyboardMarkup);
    } else if ((method === 'editMessageText' || method === 'editMessageCaption') && params.chat_id === chatId) {
      keyboards.set(params.message_id as number, params.reply_markup as InlineKeyboardMarkup);
    } else if (method === 'deleteMessage' && params.chat_id === chatId) {
      keyboards.delete(params.message_id as number);
    }
  }
  for (const markup of [...keyboards.values()].reverse()) {
    for (const button of markup.inline_keyboard.flat()) {
      if ('callback_data' in button && button.callback_data.split('|')[0] === action) return button.callback_data;
    }
  }
  return undefined;
}

async function press(api: FakeApi, runtime: Runtime, id: number, action: string) {
  const data = visibleData(api, String(id), action);
  if (!data) throw new Error(`У ${id} нет кнопки ${action}`);
  await runtime.receive(buttonUpdate(user(id, `Игрок ${id}`), data));
}

let fileUpdateId = 50_000;
function audioUpdate(id: number, index: number): Update {
  const from = user(id, `Игрок ${id}`);
  return {
    update_id: fileUpdateId++,
    message: {
      message_id: fileUpdateId,
      from,
      chat: privateChat(from),
      date: 0,
      audio: {
        file_id: `F-${id}-${index}`,
        file_unique_id: `U-${id}-${index}`,
        duration: 200,
        performer: `Группа ${id}-${index}`,
        title: `Песня ${index}`,
        mime_type: 'audio/mpeg',
        file_size: 4_000_000,
      },
    },
  };
}

async function register(api: FakeApi, runtime: Runtime, id: number) {
  await runtime.receive(textUpdate(user(id, `Игрок ${id}`), '/start t_test'));
  await press(api, runtime, id, 'r:name');
  await press(api, runtime, id, 'r:accept');
}

// Три игрока, по 10 песен, сбор закрыт, жеребьёвка проведена.
async function toQualifiers(api: FakeApi, store: Store, runtime: Runtime) {
  for (const id of [1, 2, 3]) await register(api, runtime, id);
  for (const id of [1, 2, 3]) for (let i = 0; i < 10; i++) await runtime.receive(audioUpdate(id, i));
  await runtime.idle();
  for (let job = await store.claim(); job; job = await store.claim()) {
    await store.complete({ submissionId: job.submissionId, ok: true, startSec: job.startSec });
    await runtime.workerResult({ submissionId: job.submissionId, ok: true, gameFileId: `G-${job.submissionId}`, startSec: job.startSec });
  }
  const org = user(Number(ORGANIZER), 'Орг');
  await runtime.receive(textUpdate(org, '/start'));
  for (const action of ['o:closeIntake', 'o:toDraw', 'o:draw']) await press(api, runtime, Number(ORGANIZER), action);
}

describe('Runtime на PostgreSQL (PGlite)', () => {
  it('регистрация через updates: правки на месте и ответы на каждое нажатие', async () => {
    const { api, runtime } = await boot();
    await register(api, runtime, 1);
    expect(runtime.state.people['1']?.number).toBe(1);
    expect(api.methods().filter((m) => m === 'answerCallbackQuery')).toHaveLength(2);
    // Карточка регистрации правится на месте.
    expect(api.methods()).toContain('editMessageText');
  });

  it('повтор update не обрабатывается и после перезапуска', async () => {
    const db = database();
    const first = await boot(db);
    const update = textUpdate(user(1, 'Аня'), '/start t_test');
    await first.runtime.receive(update);

    const second = await boot(db);
    await second.runtime.receive(update);
    expect(second.api.calls).toEqual([]);
    expect(await second.store.seenUpdate(update.update_id)).toBe(true);
  });

  it('пачка файлов: одно событие, задачи в очереди аудио, worker отмечает песни принятыми', async () => {
    const { api, store, runtime, jobs } = await boot();
    await register(api, runtime, 1);
    for (let i = 0; i < 3; i++) await runtime.receive(audioUpdate(1, i));
    await runtime.idle();
    expect(runtime.state.intake.intake.submissions).toHaveLength(3);
    expect(jobs()).toBe(1);

    const job = (await store.claim())!;
    await store.complete({ submissionId: job.submissionId, ok: true, startSec: job.startSec });
    await runtime.workerResult({ submissionId: job.submissionId, ok: true, gameFileId: 'G-1', startSec: job.startSec });
    const done = runtime.state.intake.intake.submissions.find((s) => s.id === job.submissionId)!;
    expect(done.gameFileId).toBe('G-1');
  });

  it('updates, пришедшие разом, обрабатываются в порядке поступления', async () => {
    const db = database();
    // Ответы базы приходят не по порядку — как из разных соединений пула.
    let delays: number[] = [];
    const shuffled: TestDatabase = {
      ...db,
      async query<R>(text: string, params?: unknown[]) {
        if (text.includes('FROM inbox')) await new Promise((resolve) => setTimeout(resolve, delays.shift() ?? 0));
        return db.query<R>(text, params);
      },
    };
    const { api, runtime } = await boot(shuffled);
    await register(api, runtime, 1);
    delays = [30, 20, 10];
    await Promise.all([0, 1, 2].map((i) => runtime.receive(audioUpdate(1, i))));
    await runtime.idle();
    expect(runtime.state.intake.intake.submissions.map((s) => s.file.fileId)).toEqual(['F-1-0', 'F-1-1', 'F-1-2']);
  });

  it('база недоступна: нажатие не применяется, пользователь видит ошибку и может повторить', async () => {
    const db = database();
    let down = false;
    const flaky: TestDatabase = {
      ...db,
      transaction: (work) => (down ? Promise.reject(new Error('connection terminated')) : db.transaction(work)),
    };
    const { api, runtime } = await boot(flaky);
    await runtime.receive(textUpdate(user(1, 'Аня'), '/start t_test'));

    down = true;
    await press(api, runtime, 1, 'r:name');
    expect(api.calls.at(-1)).toMatchObject({ method: 'answerCallbackQuery', params: { text: 'Ошибка, попробуйте ещё раз' } });

    down = false;
    await press(api, runtime, 1, 'r:name');
    await press(api, runtime, 1, 'r:accept');
    expect(runtime.state.people['1']?.number).toBe(1);
  });

  it('перезапуск посреди трека: очки и панель судьи сохраняются', async () => {
    const db = database();
    const { api, store, runtime } = await boot(db);
    await toQualifiers(api, store, runtime);

    const matchId = playable(runtime);
    const [a, b] = matchPlayers(runtime.state.draw!, matchId)!.map(Number) as [number, number];
    // Судья — гость по ссылке.
    await runtime.receive(textUpdate(user(7, 'Судья'), `/start judge_${matchId}`));
    await press(api, runtime, 7, 'r:name');
    await press(api, runtime, 7, 'r:accept');
    await press(api, runtime, 7, `d:accept:${matchId}`);
    await press(api, runtime, a, `d:confirmJudge:${matchId}`);
    await press(api, runtime, b, `d:confirmJudge:${matchId}`);

    const p = `m:${matchId}:`;
    await press(api, runtime, 7, `${p}ready`);
    await press(api, runtime, a, `${p}ready`);
    await press(api, runtime, b, `${p}ready`);
    await press(api, runtime, 7, `${p}issue`);
    await press(api, runtime, 7, `${p}start`);
    await press(api, runtime, 7, `${p}aw:a:0`);
    // Падение процесса: без снимка при остановке, только журнал.
    const restarted = await boot(db, api);
    const phase = restarted.runtime.state.matches[matchId]!.session.match.phase;
    expect(phase.kind === 'track' && phase.track.awards.artist).toBe(0);

    const editsBefore = api.calls.filter((c) => c.method === 'editMessageText').length;
    await press(api, restarted.runtime, 7, `${p}aw:t:1`);
    const after = restarted.runtime.state.matches[matchId]!.session.match.phase;
    expect(after.kind === 'track' && after.track.awards).toEqual({ artist: 0, title: 1 });
    // Панель правится в том же сообщении — slot → message_id пережил перезапуск.
    expect(api.calls.filter((c) => c.method === 'editMessageText').length).toBeGreaterThan(editsBefore);
  });

  it('сбой отправки не теряет сообщение: outbox досылается после восстановления', async () => {
    const db = database();
    const api = new FakeApi();
    const first = await boot(db, api);
    for (let i = 0; i < 5; i++) api.failNext('sendMessage', 502, 'Bad Gateway');
    await first.runtime.receive(textUpdate(user(1, 'Аня'), '/start t_test'));
    // Стартовые панели организатора и карточка регистрации ждут — порядок сохраняется.
    expect((await first.store.pendingOutbox()).map((i) => i.message.to)).toEqual([ORGANIZER, ORGANIZER, '1']);

    const second = await boot(db, api);
    await second.runtime.resume();
    expect(await second.store.pendingOutbox()).toHaveLength(0);
    expect(api.calls.at(-1)).toMatchObject({ method: 'sendMessage', params: { chat_id: '1' } });
  });
});

function playable(runtime: Runtime): string {
  const draw = runtime.state.draw!;
  return draw.bracket!.rounds.flat().find((m) => !m.isBye && matchPlayers(draw, m.id))!.id;
}
