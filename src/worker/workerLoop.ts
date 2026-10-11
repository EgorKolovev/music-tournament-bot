import type { Logger } from '../telegram/delivery.ts';
import type { AudioJob, AudioResult } from './audioProcessor.ts';

// Цикл обработки очереди аудио: одна задача одновременно, ошибка одного файла не блокирует остальные.

export interface JobSource {
  // Взять следующую задачу (пометить как взятую); undefined — очередь пуста.
  claim(): Promise<AudioJob | undefined>;
  // Успех или окончательная неудача файла.
  complete(result: AudioResult): Promise<void>;
  // Временная ошибка (сеть, Telegram 5xx/429): задача вернётся в очередь.
  retryLater(job: AudioJob, error: unknown): Promise<void>;
}

export interface WorkerLoopOptions {
  source: JobSource;
  process: (job: AudioJob) => Promise<AudioResult>;
  onResult: (result: AudioResult) => void;
  log: Logger;
  // Сколько ждать новую задачу, если очередь пуста (kick будит раньше).
  idleMs?: number;
  // Пауза после временной ошибки, чтобы не крутиться вхолостую без сети.
  errorPauseMs?: number;
}

// Режим AUDIO_MODE=skip: без ffmpeg файл считается годным, судья видит заглушку вместо плеера.
export async function skipProcessor(job: AudioJob): Promise<AudioResult> {
  return { submissionId: job.submissionId, ok: true };
}

export class WorkerLoop {
  private readonly options: WorkerLoopOptions;
  private wake: (() => void) | undefined;

  constructor(options: WorkerLoopOptions) {
    this.options = options;
  }

  // Новая задача в очереди — не ждать окончания паузы.
  kick(): void {
    this.wake?.();
  }

  async start(signal: AbortSignal): Promise<void> {
    const { source, process, onResult, log } = this.options;
    const errorPauseMs = this.options.errorPauseMs ?? 1_000;
    while (!signal.aborted) {
      let job: AudioJob | undefined;
      try {
        job = await source.claim();
      } catch (error) {
        log.error('очередь аудио недоступна', error);
        await this.pause(errorPauseMs, signal);
        continue;
      }
      if (!job) {
        await this.pause(this.options.idleMs ?? 5_000, signal);
        continue;
      }
      let result: AudioResult;
      try {
        result = await process(job);
      } catch (error) {
        log.warn(`аудио ${job.submissionId}: ${error instanceof Error ? error.message : String(error)}, повтор позже`);
        await source.retryLater(job, error).catch((e: unknown) => log.error(`повтор аудио ${job.submissionId} не записан`, e));
        await this.pause(errorPauseMs, signal);
        continue;
      }
      try {
        await source.complete(result);
      } catch (error) {
        // Задача останется взятой и вернётся в очередь при перезапуске.
        log.error(`результат аудио ${job.submissionId} не записан`, error);
        await this.pause(errorPauseMs, signal);
        continue;
      }
      try {
        onResult(result);
      } catch (error) {
        log.error(`обработчик результата аудио ${job.submissionId}`, error);
      }
    }
  }

  private pause(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
      this.wake = done;
    });
  }
}
