import { describe, expect, it } from 'vitest';
import { silentLog } from '../telegram/fakeApi.ts';
import type { AudioJob, AudioResult } from './audioProcessor.ts';
import { skipProcessor, WorkerLoop, type JobSource } from './workerLoop.ts';

class MemorySource implements JobSource {
  queue: AudioJob[];
  completed: AudioResult[] = [];
  retried: string[] = [];

  constructor(jobs: AudioJob[]) {
    this.queue = [...jobs];
  }

  async claim(): Promise<AudioJob | undefined> {
    return this.queue.shift();
  }

  async complete(result: AudioResult): Promise<void> {
    this.completed.push(result);
  }

  async retryLater(job: AudioJob): Promise<void> {
    this.retried.push(job.submissionId);
  }
}

describe('WorkerLoop', () => {
  it('ошибка одной задачи уходит в повтор, следующая обрабатывается', async () => {
    const source = new MemorySource([
      { submissionId: 'a', fileId: 'A' },
      { submissionId: 'b', fileId: 'B' },
    ]);
    const results: string[] = [];
    const abort = new AbortController();
    const loop = new WorkerLoop({
      source,
      process: async (job) => {
        if (job.submissionId === 'a') throw new Error('сеть');
        return { submissionId: job.submissionId, ok: true };
      },
      onResult: (result) => {
        results.push(result.submissionId);
        abort.abort();
      },
      log: silentLog,
      errorPauseMs: 1,
    });
    await loop.start(abort.signal);

    expect(source.retried).toEqual(['a']);
    expect(source.completed).toEqual([{ submissionId: 'b', ok: true }]);
    expect(results).toEqual(['b']);
  });

  it('kick будит цикл, когда появляется задача', async () => {
    const source = new MemorySource([]);
    const abort = new AbortController();
    const loop = new WorkerLoop({
      source,
      process: skipProcessor,
      onResult: () => abort.abort(),
      log: silentLog,
      idleMs: 60_000,
    });
    const running = loop.start(abort.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    source.queue.push({ submissionId: 'c', fileId: 'C' });
    loop.kick();
    await running;
    expect(source.completed).toEqual([{ submissionId: 'c', ok: true }]);
  });
});
