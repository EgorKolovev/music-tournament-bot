import type { UserId } from '../bot/protocol.ts';
import type { AudioFile } from '../domain/submission/intake.ts';

// Telegram присылает каждый файл пачки отдельным update. Копим файлы пользователя, пока идут
// новые, и отдаём одной пачкой после паузы. Смена media_group_id закрывает предыдущую пачку сразу.

export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const REAL_TIMERS: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Pending {
  files: AudioFile[];
  mediaGroupId?: string;
  timer: unknown;
}

export class FileBatcher {
  private readonly pending = new Map<UserId, Pending>();
  private readonly onBatch: (from: UserId, files: AudioFile[]) => void;
  private readonly quietMs: number;
  private readonly timers: Timers;

  constructor(onBatch: (from: UserId, files: AudioFile[]) => void, quietMs = 1500, timers: Timers = REAL_TIMERS) {
    this.onBatch = onBatch;
    this.quietMs = quietMs;
    this.timers = timers;
  }

  push(from: UserId, file: AudioFile, mediaGroupId?: string): void {
    const current = this.pending.get(from);
    if (current && mediaGroupId !== undefined && current.mediaGroupId !== undefined && current.mediaGroupId !== mediaGroupId) {
      this.flush(from);
    }
    const entry = this.pending.get(from);
    if (entry) this.timers.clear(entry.timer);
    const files = [...(entry?.files ?? []), file];
    this.pending.set(from, {
      files,
      mediaGroupId: mediaGroupId ?? entry?.mediaGroupId,
      timer: this.timers.set(() => this.flush(from), this.quietMs),
    });
  }

  // Текст или кнопка от того же пользователя закрывают пачку раньше, чтобы сохранить порядок событий.
  flush(from: UserId): void {
    const entry = this.pending.get(from);
    if (!entry) return;
    this.timers.clear(entry.timer);
    this.pending.delete(from);
    this.onBatch(from, entry.files);
  }

  flushAll(): void {
    for (const from of [...this.pending.keys()]) this.flush(from);
  }
}
