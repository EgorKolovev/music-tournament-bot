import type { AudioFile } from '../domain/submission/intake.ts';

// Транспортно-независимый протокол бота. Ядро получает Incoming и отдаёт Outgoing[];
// Telegram-адаптер переводит их в Bot API, веб-симулятор рисует как чаты.

export type UserId = string;

export interface Button {
  label: string;
  // Уходит в Telegram как callback_data: не длиннее 64 байт.
  data: string;
}

export interface AudioAttachment {
  // Нейтральные title/performer, которые увидит судья в плеере Telegram.
  title: string;
  performer: string;
  url?: string;
}

export interface OutgoingMessage {
  kind: 'message';
  to: UserId;
  // Сообщение с тем же slot у того же получателя редактируется на месте (editMessageText).
  slot?: string;
  // Пользователь писал после этого сообщения: старое удаляется и отправляется новое внизу чата,
  // иначе правка останется незаметной выше по ленте.
  bump?: boolean;
  text: string;
  audio?: AudioAttachment;
  // Файл для скачивания (sendDocument): офлайн-комплект, таблица ответов.
  document?: { fileName: string; mimeType: string; content: string };
  buttons?: Button[][];
}

// Всплывающий ответ на нажатие кнопки (answerCallbackQuery).
export interface OutgoingToast {
  kind: 'toast';
  to: UserId;
  text: string;
}

export type Outgoing = OutgoingMessage | OutgoingToast;

export type Incoming =
  | { kind: 'button'; from: UserId; data: string }
  | { kind: 'text'; from: UserId; text: string }
  // Пересланная пачка аудио. Telegram присылает каждый файл отдельным update —
  // адаптер собирает их по media_group_id и короткой паузе.
  | { kind: 'files'; from: UserId; files: AudioFile[] }
  // Внутреннее событие: worker закончил обработку файлов.
  | { kind: 'worker'; results: { submissionId: string; ok: boolean }[] };

export type UserIncoming = Exclude<Incoming, { kind: 'worker' }>;

export const NOOP = 'noop';

// Лимиты Bot API, которые симулятор проверяет, чтобы интерфейс не разошёлся с настоящим Telegram.
export const TELEGRAM_LIMITS = {
  callbackDataBytes: 64,
  messageTextChars: 4096,
  buttonsPerRow: 8,
  buttonRows: 100,
} as const;

export function limitViolations(message: OutgoingMessage): string[] {
  const problems: string[] = [];
  if (message.text.length > TELEGRAM_LIMITS.messageTextChars) {
    problems.push(`текст ${message.text.length} > ${TELEGRAM_LIMITS.messageTextChars} символов`);
  }
  const rows = message.buttons ?? [];
  if (rows.length > TELEGRAM_LIMITS.buttonRows) problems.push(`рядов кнопок ${rows.length}`);
  for (const row of rows) {
    if (row.length > TELEGRAM_LIMITS.buttonsPerRow) problems.push(`кнопок в ряду ${row.length}`);
    for (const button of row) {
      const bytes = new TextEncoder().encode(button.data).length;
      if (bytes > TELEGRAM_LIMITS.callbackDataBytes) problems.push(`callback_data «${button.data}» ${bytes} байт`);
    }
  }
  return problems;
}
