import type { Api } from 'grammy';
import type { Update } from 'grammy/types';
import { pendingSubmissions } from '../bot/intakeSession.ts';
import type { OutgoingMessage, OutgoingToast, UserId } from '../bot/protocol.ts';
import type { AudioFile } from '../domain/submission/intake.ts';
import type { Store } from '../storage/store.ts';
import type { TournamentEvent } from '../tournament/events.ts';
import { createTournament, handleEvent, type TournamentConfig, type TournamentState } from '../tournament/tournament.ts';
import type { AudioResult } from '../worker/audioProcessor.ts';
import { isPermanent } from './apiErrors.ts';
import { Delivery, type Logger, type Trigger } from './delivery.ts';
import { FileBatcher, type Timers } from './fileBatcher.ts';
import { parseUpdate, type Sender } from './updates.ts';

// Связка: update → разбор → оркестратор турнира → хранение → доставка.
// События обрабатываются строго по одному (блокировка на турнир): две кнопки судьи не применяются
// параллельно. Порядок на каждое событие: обработка → commit (журнал, outbox, inbox) → ответ на
// нажатие → отправка outbox. Сбой отправки не откатывает игру; после перезапуска outbox досылается.

export interface RuntimeOptions {
  api: Api;
  store: Store;
  config: TournamentConfig;
  log: Logger;
  timers?: Timers;
  batchQuietMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  // В очереди аудио появились задачи — разбудить worker.
  onJobs?: () => void;
}

// Настройки, которые берутся из окружения при каждом запуске, а не из сохранённого состояния.
type LiveConfig = Pick<TournamentConfig, 'organizerId' | 'adminIds' | 'botUsername'>;

const OUTBOX_GIVE_UP_ATTEMPTS = 10;
const OUTBOX_RETRY_MS = 5_000;
const FAILURE_TOAST = 'Ошибка, попробуйте ещё раз';

export class Runtime {
  private readonly store: Store;
  private readonly log: Logger;
  private readonly delivery: Delivery;
  private readonly batcher: FileBatcher;
  private readonly now: () => number;
  private readonly onJobs: () => void;
  private readonly senders = new Map<UserId, Sender>();
  private readonly batchUpdates = new Map<UserId, number[]>();
  // Проверка inbox идёт строго в порядке поступления updates: файлы пачки и нажатия
  // не обгоняют друг друга, пока ждут ответа базы.
  private inbox: Promise<unknown> = Promise.resolve();
  private queue: Promise<void> = Promise.resolve();
  private draining = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private current: TournamentState;

  private constructor(options: RuntimeOptions, state: TournamentState) {
    this.store = options.store;
    this.log = options.log;
    this.now = options.now ?? Date.now;
    this.onJobs = options.onJobs ?? (() => {});
    this.delivery = new Delivery({ api: options.api, slots: options.store, log: options.log, sleep: options.sleep });
    this.batcher = new FileBatcher(
      (from, files) => void this.enqueue(() => this.dispatchFiles(from, files)),
      options.batchQuietMs,
      options.timers,
    );
    this.current = state;
  }

  static async create(options: RuntimeOptions): Promise<Runtime> {
    return new Runtime(options, await restore(options.store, options.config, options.log));
  }

  get state(): TournamentState {
    return this.current;
  }

  // Возвращает промис обработки — polling его не ждёт, тесты ждут.
  receive(update: Update): Promise<void> {
    const accepted = this.inbox.then(() => this.accept(update));
    this.inbox = accepted;
    return accepted.then(({ processed }) => processed);
  }

  // Принять update: отсеять повтор и разобрать. Обработка уходит в очередь событий; её промис
  // завёрнут в объект, чтобы приём следующего update не ждал конца обработки.
  private async accept(update: Update): Promise<{ processed: Promise<void> }> {
    const skip = { processed: Promise.resolve() };
    try {
      if (await this.store.seenUpdate(update.update_id)) return skip;
      const parsed = parseUpdate(update);
      if (parsed.kind === 'ignored') {
        await this.store.markUpdate(update.update_id);
        return skip;
      }
      this.senders.set(parsed.from.id, parsed.from);

      if (parsed.kind === 'file') {
        this.batchUpdates.set(parsed.from.id, [...(this.batchUpdates.get(parsed.from.id) ?? []), update.update_id]);
        this.batcher.push(parsed.from.id, parsed.file, parsed.mediaGroupId);
        return skip;
      }
      // Недособранная пачка того же пользователя уходит раньше его следующего действия.
      this.batcher.flush(parsed.from.id);

      const ids = [update.update_id];
      if (parsed.kind === 'button') {
        const trigger: Trigger = { from: parsed.from.id, callbackQueryId: parsed.callbackQueryId };
        return { processed: this.enqueue(() => this.process({ kind: 'button', from: parsed.from, data: parsed.data }, ids, trigger)) };
      }
      return { processed: this.enqueue(() => this.process(parsed, ids)) };
    } catch (error) {
      this.log.error(`update ${update.update_id} не принят`, error);
      return skip;
    }
  }

  workerResult(result: AudioResult): Promise<void> {
    const { submissionId, ok, gameFileId, startSec } = result;
    const results = [{ submissionId, ok, gameFileId, startSec }];
    return this.enqueue(() => this.process({ kind: 'worker', results }, []));
  }

  tick(): Promise<void> {
    return this.enqueue(async () => {
      // Файлы, которые так и не удалось обработать, — окончательная неудача, участник пришлёт замену.
      for (const job of await this.store.exhaustedJobs()) {
        const { submissionId, startSec } = job;
        await this.store.complete({ submissionId, ok: false, startSec, reason: 'attempts' });
        await this.process({ kind: 'worker', results: [{ submissionId, ok: false, startSec }] }, []);
      }
      await this.process({ kind: 'tick' }, []);
    });
  }

  // Дождаться обработки всего, что уже принято (тесты и остановка процесса).
  async idle(): Promise<void> {
    await this.inbox;
    this.batcher.flushAll();
    await this.queue;
  }

  async stop(): Promise<void> {
    await this.idle();
    clearTimeout(this.retryTimer);
    await this.store.snapshot(this.current);
  }

  // Досылка outbox, оставшегося с прошлого запуска.
  resume(): Promise<void> {
    return this.enqueue(() => this.drain());
  }

  private dispatchFiles(from: UserId, files: AudioFile[]): Promise<void> {
    const sender = this.senders.get(from) ?? { id: from, name: from };
    const ids = this.batchUpdates.get(from) ?? [];
    this.batchUpdates.delete(from);
    return this.process({ kind: 'files', from: sender, files }, ids);
  }

  private async process(event: TournamentEvent, updateIds: number[], trigger?: Trigger): Promise<void> {
    const stamped = { at: this.now(), event };
    let step;
    try {
      step = handleEvent(this.current, stamped);
    } catch (error) {
      this.log.error(`ошибка обработки ${event.kind}`, error);
      for (const id of updateIds) await this.store.markUpdate(id);
      if (trigger) await this.delivery.answer(trigger, [{ kind: 'toast', to: trigger.from, text: FAILURE_TOAST }]);
      return;
    }
    // Пустой tick не засоряет журнал.
    if (event.kind === 'tick' && step.out.length === 0 && step.state === this.current) return;

    const messages = messagesOf(step.out);
    try {
      await this.store.commit({ event: stamped, state: step.state, out: messages, updateIds });
    } catch (error) {
      // База недоступна: состояние не меняется, нажатие можно повторить.
      this.log.error(`событие ${event.kind} не сохранено`, error);
      if (trigger) await this.delivery.answer(trigger, [{ kind: 'toast', to: trigger.from, text: FAILURE_TOAST }]);
      return;
    }
    this.current = step.state;
    await this.enqueueJobs();

    const toasts = step.out.filter((o): o is OutgoingToast => o.kind === 'toast');
    if (trigger) await this.delivery.answer(trigger, toasts);
    for (const t of toasts) if (t.to !== trigger?.from) this.log.warn(`toast для ${t.to} без нажатия — пропущен: ${t.text}`);
    await this.drain();
  }

  private async enqueueJobs(): Promise<void> {
    const jobs = pendingSubmissions(this.current.intake).map((s) => ({
      submissionId: s.id,
      fileId: s.file.fileId,
      sizeBytes: s.file.sizeBytes,
      startSec: s.startSec,
    }));
    if (jobs.length > 0 && (await this.store.enqueueJobs(jobs)) > 0) this.onJobs();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const items = await this.store.pendingOutbox(50);
        if (items.length === 0) return;
        for (const item of items) {
          try {
            await this.delivery.deliverMessage(item.message);
            await this.store.markSent(item.id);
          } catch (error) {
            const giveUp = isPermanent(error) || item.attempts + 1 >= OUTBOX_GIVE_UP_ATTEMPTS;
            const text = error instanceof Error ? error.message : String(error);
            await this.store.markFailed(item.id, text, giveUp);
            this.log.error(`outbox ${item.id} для ${item.message.to}${giveUp ? ' — отказ' : ', повтор позже'}`, text);
            if (!giveUp) {
              // Сохраняем порядок: следующие сообщения ждут, пока это не уйдёт.
              clearTimeout(this.retryTimer);
              this.retryTimer = setTimeout(() => void this.resume(), OUTBOX_RETRY_MS);
              return;
            }
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task).catch((error: unknown) => this.log.error('сбой в очереди событий', error));
    this.queue = run;
    return run;
  }
}

// Снимок плюс повтор событий после него. Если базы ещё нет — новый турнир.
async function restore(store: Store, config: TournamentConfig, log: Logger): Promise<TournamentState> {
  const live: LiveConfig = { organizerId: config.organizerId, adminIds: config.adminIds, botUsername: config.botUsername };
  const snapshot = await store.latestSnapshot();
  if (!snapshot) {
    const created = createTournament(config);
    await store.initialize(created.state, messagesOf(created.out));
    log.info(`новый турнир «${config.title}», код ${config.code}`);
    return created.state;
  }
  let state: TournamentState = { ...snapshot.state, config: { ...snapshot.state.config, ...live } };
  const events = await store.eventsAfter(snapshot.seq);
  for (const event of events) state = handleEvent(state, event).state;
  log.info(`турнир восстановлен: снимок ${snapshot.seq} + ${events.length} событий`);
  return state;
}

function messagesOf(out: readonly { kind: string }[]): OutgoingMessage[] {
  return out.filter((o): o is OutgoingMessage => o.kind === 'message');
}
