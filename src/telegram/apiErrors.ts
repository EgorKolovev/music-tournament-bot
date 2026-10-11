import { GrammyError } from 'grammy';

// Клиент Bot API — grammY. Здесь — как адаптер понимает его ошибки: что повторять,
// что считать окончательным и когда сообщение проще отправить заново, чем править.

export function isNotModified(error: unknown): boolean {
  return error instanceof GrammyError && error.description.includes('message is not modified');
}

// Сообщение удалено пользователем или слишком старое для правки — проще отправить новое.
export function isGone(error: unknown): boolean {
  return (
    error instanceof GrammyError &&
    /message to edit not found|message can't be edited|message to delete not found|message can't be deleted/.test(
      error.description,
    )
  );
}

// 429 и 5xx — лимиты и сбои Telegram; сетевая ошибка (HttpError) и любая другая — тоже повторяем.
export function isRetryable(error: unknown): boolean {
  return error instanceof GrammyError ? error.error_code === 429 || error.error_code >= 500 : true;
}

// 4xx кроме 429 — повтор не поможет (бот заблокирован, чат не найден, файл слишком большой).
export function isPermanent(error: unknown): boolean {
  return error instanceof GrammyError && error.error_code >= 400 && error.error_code < 500 && error.error_code !== 429;
}

export function retryAfterMs(error: unknown): number | undefined {
  const seconds = error instanceof GrammyError ? error.parameters.retry_after : undefined;
  return seconds === undefined ? undefined : seconds * 1000;
}
