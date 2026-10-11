import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OutgoingMessage } from '../bot/protocol.ts';
import { createTournament } from '../tournament/tournament.ts';
import { testConfig } from '../tournament/testBot.ts';
import { dropTournament, exportTournament, importTournament, Store, tournamentSummary } from './store.ts';
import { testDatabase, type TestDatabase } from './testDatabase.ts';

const databases: TestDatabase[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const db of databases.splice(0)) await db.close();
});

async function open(db = testDatabase()) {
  databases.push(db);
  return { db, store: await Store.open(db) };
}

const message = (to: string, text: string): OutgoingMessage => ({ kind: 'message', to, text });
const state = createTournament(testConfig()).state;

describe('Store на PostgreSQL (PGlite)', () => {
  it('журнал: снимок каждые 50 событий, хранятся последние три', async () => {
    const { db, store } = await open();
    await store.initialize(state, []);
    for (let i = 0; i < 200; i++) {
      await store.commit({ event: { at: i, event: { kind: 'tick' } }, state, out: [], updateIds: [] });
    }
    const { rows } = await db.query<{ seq: number }>('SELECT seq FROM snapshots ORDER BY seq');
    expect(rows.map((r) => r.seq)).toEqual([100, 150, 200]);
    expect((await store.latestSnapshot())?.seq).toBe(200);
    expect(await store.eventsAfter(198)).toEqual([
      { at: 198, event: { kind: 'tick' } },
      { at: 199, event: { kind: 'tick' } },
    ]);
  });

  it('снимок при остановке заменяет снимок того же seq', async () => {
    const { store } = await open();
    await store.initialize(state, []);
    await store.snapshot({ ...state, phase: 'archive' });
    expect((await store.latestSnapshot())?.state.phase).toBe('archive');
  });

  it('inbox и outbox: порядок, отказ после ошибки, повтор update не дублируется', async () => {
    const { store } = await open();
    await store.initialize(state, [message('1', 'a')]);
    const event = { at: 1, event: { kind: 'tick' as const } };
    await store.commit({ event, state, out: [message('2', 'b'), message('3', 'c')], updateIds: [7, 7] });
    expect(await store.seenUpdate(7)).toBe(true);
    expect(await store.seenUpdate(8)).toBe(false);

    const [first, second, third] = await store.pendingOutbox();
    expect([first, second, third].map((i) => i?.message.to)).toEqual(['1', '2', '3']);
    await store.markSent(first!.id);
    await store.markFailed(second!.id, '502', false);
    await store.markFailed(third!.id, '403', true);
    expect(await store.pendingOutbox()).toMatchObject([{ id: second!.id, attempts: 1 }]);
  });

  it('слоты: запись заменяет прежнее сообщение', async () => {
    const { store } = await open();
    await store.set('42', 'panel', { messageId: 100, kind: 'text' });
    await store.set('42', 'panel', { messageId: 101, kind: 'audio', fileId: 'F' });
    expect(await store.get('42', 'panel')).toEqual({ messageId: 101, kind: 'audio', fileId: 'F' });
    expect(await store.get('42', 'other')).toBeUndefined();
  });

  it('очередь аудио: по порядку, без дублей, с паузой после ошибки и отказом после пяти попыток', async () => {
    const { store } = await open();
    expect(await store.enqueueJobs([{ submissionId: 'a', fileId: 'A', sizeBytes: 3_000_000_000, startSec: 0 }, { submissionId: 'b', fileId: 'B', startSec: 0 }])).toBe(2);
    expect(await store.enqueueJobs([{ submissionId: 'a', fileId: 'A', startSec: 0 }])).toBe(0);

    expect(await store.claim()).toEqual({ submissionId: 'a', fileId: 'A', sizeBytes: 3_000_000_000, startSec: 0 });
    const b = (await store.claim())!;
    expect(await store.claim()).toBeUndefined();

    await store.complete({ submissionId: 'a', ok: true, startSec: 0 });
    vi.useFakeTimers({ toFake: ['Date'] });
    await store.retryLater(b, new Error('сеть'));
    // Первая пауза — минута.
    expect(await store.claim()).toBeUndefined();
    vi.setSystemTime(Date.now() + 60_000);
    expect(await store.claim()).toMatchObject({ submissionId: 'b' });

    for (let attempt = 2; attempt <= 5; attempt++) {
      await store.retryLater(b, new Error('сеть'));
      vi.setSystemTime(Date.now() + 30 * 60_000);
      if (attempt < 5) expect(await store.claim()).toMatchObject({ submissionId: 'b' });
    }
    expect(await store.claim()).toBeUndefined();
    expect(await store.exhaustedJobs()).toEqual([{ submissionId: 'b', fileId: 'B', startSec: 0 }]);
  });

  it('новое начало возвращает задачу в очередь; результат со старым началом её не закрывает', async () => {
    const { store } = await open();
    await store.enqueueJobs([{ submissionId: 'a', fileId: 'A', startSec: 0 }]);
    const old = (await store.claim())!;
    expect(await store.enqueueJobs([{ submissionId: 'a', fileId: 'A', startSec: 75 }])).toBe(1);
    expect(await store.enqueueJobs([{ submissionId: 'a', fileId: 'A', startSec: 75 }])).toBe(0);

    await store.complete({ submissionId: old.submissionId, ok: true, startSec: old.startSec });
    expect(await store.claim()).toMatchObject({ submissionId: 'a', startSec: 75 });
  });

  it('сброс: показывает, что удаляется, и следующий запуск начинает новый турнир', async () => {
    const { db, store } = await open();
    expect(await tournamentSummary(db)).toBeUndefined();
    await store.initialize(state, [message('1', 'привет')]);
    await store.commit({ event: { at: 1, event: { kind: 'tick' } }, state, out: [], updateIds: [7] });
    expect(await tournamentSummary(db)).toEqual({ title: 'Тестовый турнир', events: 1 });

    await dropTournament(db);
    expect(await tournamentSummary(db)).toBeUndefined();
    const fresh = await Store.open(db);
    expect(await fresh.latestSnapshot()).toBeUndefined();
    expect(await fresh.seenUpdate(7)).toBe(false);
  });

  it('копия: турнир переносится в другую базу как был, номера журнала продолжаются', async () => {
    const { db, store } = await open();
    expect(await exportTournament(db, new Date())).toBeUndefined();
    await store.initialize(state, [message('1', 'привет')]);
    await store.commit({ event: { at: 1, event: { kind: 'tick' } }, state, out: [message('2', 'ход')], updateIds: [7] });
    await store.enqueueJobs([{ submissionId: 'a', fileId: 'A', sizeBytes: 3_000_000_000, startSec: 30 }]);
    await store.set('1', 'i:list', { messageId: 42, kind: 'text' });

    const dump = (await exportTournament(db, new Date('2026-10-12T10:00:00Z')))!;
    expect(dump).toMatchObject({ format: 'music-tournament', version: 1, title: 'Тестовый турнир', createdAt: '2026-10-12T10:00:00.000Z' });
    // Через JSON — как через файл.
    const { db: other } = await open();
    await importTournament(other, JSON.parse(JSON.stringify(dump)));

    const restored = await Store.open(other);
    expect(await restored.latestSnapshot()).toEqual(await store.latestSnapshot());
    expect(await restored.eventsAfter(0)).toEqual(await store.eventsAfter(0));
    expect(await restored.seenUpdate(7)).toBe(true);
    expect(await restored.get('1', 'i:list')).toMatchObject({ messageId: 42, kind: 'text' });
    expect(await restored.claim()).toEqual({ submissionId: 'a', fileId: 'A', sizeBytes: 3_000_000_000, startSec: 30 });
    expect((await restored.pendingOutbox(10)).map((m) => m.message.text)).toEqual(['привет', 'ход']);

    await restored.commit({ event: { at: 2, event: { kind: 'tick' } }, state, out: [message('3', 'дальше')], updateIds: [] });
    const { rows } = await other.query<{ seq: number }>('SELECT seq FROM events ORDER BY seq');
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
  });

  it('копия старой версии бота: недостающие колонки получают значения по умолчанию', async () => {
    const { db, store } = await open();
    await store.initialize(state, []);
    await store.enqueueJobs([{ submissionId: 'a', fileId: 'A', startSec: 0 }]);
    const dump = (await exportTournament(db, new Date()))!;
    for (const row of dump.tables.jobs!) delete row.start_sec;

    const { db: other } = await open();
    await importTournament(other, dump);
    expect(await (await Store.open(other)).claim()).toMatchObject({ submissionId: 'a', startSec: 0 });
    await expect(importTournament(other, { ...dump, format: 'другое' } as never)).rejects.toThrow('не копия турнира');
  });

  it('взятая до падения задача возвращается в очередь при следующем запуске', async () => {
    const { db, store } = await open();
    await store.enqueueJobs([{ submissionId: 'a', fileId: 'A', startSec: 0 }]);
    await store.claim();
    const restarted = await Store.open(db);
    expect(await restarted.claim()).toMatchObject({ submissionId: 'a' });
  });
});
