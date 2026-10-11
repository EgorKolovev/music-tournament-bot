import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OutgoingMessage } from '../bot/protocol.ts';
import { createTournament } from '../tournament/tournament.ts';
import { testConfig } from '../tournament/testBot.ts';
import { Store } from './store.ts';
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
    expect(await store.enqueueJobs([{ submissionId: 'a', fileId: 'A', sizeBytes: 3_000_000_000 }, { submissionId: 'b', fileId: 'B' }])).toBe(2);
    expect(await store.enqueueJobs([{ submissionId: 'a', fileId: 'A' }])).toBe(0);

    expect(await store.claim()).toEqual({ submissionId: 'a', fileId: 'A', sizeBytes: 3_000_000_000 });
    const b = (await store.claim())!;
    expect(await store.claim()).toBeUndefined();

    await store.complete({ submissionId: 'a', ok: true });
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
    expect(await store.exhaustedJobs()).toEqual([{ submissionId: 'b', fileId: 'B' }]);
  });

  it('взятая до падения задача возвращается в очередь при следующем запуске', async () => {
    const { db, store } = await open();
    await store.enqueueJobs([{ submissionId: 'a', fileId: 'A' }]);
    await store.claim();
    const restarted = await Store.open(db);
    expect(await restarted.claim()).toMatchObject({ submissionId: 'a' });
  });
});
