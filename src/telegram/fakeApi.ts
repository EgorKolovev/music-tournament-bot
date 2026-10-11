import { Api } from 'grammy';
import type { Chat, Update, User } from 'grammy/types';
import type { Logger } from './delivery.ts';

// Подмена Bot API для тестов: настоящий Api grammY, но запросы перехватывает transformer —
// записывает вызовы и выдаёт растущие message_id. Ответ ok:false grammY сам превращает в GrammyError.

export interface ApiCall {
  method: string;
  params: Record<string, unknown>;
}

interface ApiErrorResponse {
  ok: false;
  error_code: number;
  description: string;
  parameters: { retry_after?: number };
}

export class FakeApi extends Api {
  readonly calls: ApiCall[] = [];
  // Свой ответ на метод вместо стандартного (message_id для send*, true для остальных).
  readonly replies = new Map<string, (params: Record<string, unknown>) => unknown>();
  private nextMessageId = 100;
  // Очередь ошибок по методу: следующий вызов этого метода упадёт с ней.
  private readonly failures = new Map<string, ApiErrorResponse[]>();

  constructor() {
    super('0:test');
    this.config.use(async (_prev, method, payload) => {
      const params = (payload ?? {}) as Record<string, unknown>;
      this.calls.push({ method, params });
      const failure = this.failures.get(method)?.shift();
      if (failure) return failure as never;
      const reply = this.replies.get(method);
      const result = reply ? reply(params) : method.startsWith('send') ? { message_id: this.nextMessageId++ } : true;
      return { ok: true, result } as never;
    });
  }

  failNext(method: string, code: number, description: string, retryAfter?: number): void {
    const list = this.failures.get(method) ?? [];
    list.push({ ok: false, error_code: code, description, parameters: { retry_after: retryAfter } });
    this.failures.set(method, list);
  }

  methods(): string[] {
    return this.calls.map((c) => c.method);
  }

  clear(): void {
    this.calls.length = 0;
  }
}

export const silentLog: Logger = { info: () => {}, warn: () => {}, error: () => {} };

let updateId = 1;

export function user(id: number, firstName: string): User {
  return { id, is_bot: false, first_name: firstName };
}

export function privateChat(from: User): Chat.PrivateChat {
  return { id: from.id, type: 'private', first_name: from.first_name };
}

export function textUpdate(from: User, text: string): Update {
  return {
    update_id: updateId++,
    message: { message_id: updateId, from, chat: privateChat(from), date: 0, text },
  };
}

export function buttonUpdate(from: User, data: string): Update {
  return { update_id: updateId++, callback_query: { id: `cq-${updateId}`, from, chat_instance: 'test', data } };
}
