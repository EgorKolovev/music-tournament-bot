import { GrammyError, HttpError } from 'grammy';
import { describe, expect, it } from 'vitest';
import { isGone, isNotModified, isPermanent, isRetryable, retryAfterMs } from './apiErrors.ts';

function apiError(code: number, description: string, retryAfter?: number): GrammyError {
  return new GrammyError(
    `Call to 'sendMessage' failed! (${code}: ${description})`,
    { ok: false, error_code: code, description, parameters: { retry_after: retryAfter } },
    'sendMessage',
    {},
  );
}

describe('разбор ошибок grammY', () => {
  it('429 и 5xx повторяются, 429 — через retry_after', () => {
    expect(isRetryable(apiError(429, 'Too Many Requests: retry after 7', 7))).toBe(true);
    expect(retryAfterMs(apiError(429, 'Too Many Requests: retry after 7', 7))).toBe(7000);
    expect(isRetryable(apiError(502, 'Bad Gateway'))).toBe(true);
    expect(retryAfterMs(apiError(502, 'Bad Gateway'))).toBeUndefined();
  });

  it('сетевой сбой повторяется и окончательным не считается', () => {
    const network = new HttpError("Network request for 'sendMessage' failed!", new Error('ECONNRESET'));
    expect(isRetryable(network)).toBe(true);
    expect(isPermanent(network)).toBe(false);
  });

  it('4xx кроме 429 — окончательная ошибка', () => {
    expect(isPermanent(apiError(403, 'Forbidden: bot was blocked by the user'))).toBe(true);
    expect(isRetryable(apiError(403, 'Forbidden: bot was blocked by the user'))).toBe(false);
    expect(isPermanent(apiError(429, 'Too Many Requests'))).toBe(false);
  });

  it('правка на месте: «не изменилось» и «сообщения больше нет»', () => {
    expect(isNotModified(apiError(400, 'Bad Request: message is not modified'))).toBe(true);
    expect(isGone(apiError(400, 'Bad Request: message to edit not found'))).toBe(true);
    expect(isGone(apiError(400, "Bad Request: message can't be deleted for everyone"))).toBe(true);
    expect(isGone(apiError(400, 'Bad Request: chat not found'))).toBe(false);
  });
});
