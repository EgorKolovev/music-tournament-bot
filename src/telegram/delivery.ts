import { InputFile, type Api } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';
import { zipSync } from 'fflate';
import {
  limitViolations,
  type Button,
  type Outgoing,
  type OutgoingMessage,
  type OutgoingToast,
  type UserId,
} from '../bot/protocol.ts';
import { isGone, isNotModified, isRetryable, retryAfterMs } from './apiErrors.ts';

// Перевод Outgoing в вызовы Bot API (docs/telegram-integration.md, раздел 1).
// Сообщение со slot отправляется один раз, дальше правится на месте; bump переносит его вниз.

type MessageKind = 'text' | 'audio' | 'document';

export interface SlotRecord {
  messageId: number;
  kind: MessageKind;
  // Для аудио: какой файл уже в сообщении. Другой файл — удалить и отправить заново.
  fileId?: string;
}

// (chat_id, slot) → message_id. В боте — таблица slots в PostgreSQL.
export interface SlotStore {
  get(chatId: UserId, slot: string): Promise<SlotRecord | undefined>;
  set(chatId: UserId, slot: string, record: SlotRecord): Promise<void>;
  forgetChat(chatId: UserId): Promise<void>;
}

export class MemorySlotStore implements SlotStore {
  private readonly records = new Map<UserId, Map<string, SlotRecord>>();

  async get(chatId: UserId, slot: string): Promise<SlotRecord | undefined> {
    return this.records.get(chatId)?.get(slot);
  }

  async set(chatId: UserId, slot: string, record: SlotRecord): Promise<void> {
    const chat = this.records.get(chatId) ?? new Map<string, SlotRecord>();
    chat.set(slot, record);
    this.records.set(chatId, chat);
  }

  async forgetChat(chatId: UserId): Promise<void> {
    this.records.delete(chatId);
  }
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface DeliveryOptions {
  api: Api;
  slots: SlotStore;
  log: Logger;
  downloadFile?: (filePath: string, signal?: AbortSignal) => Promise<Uint8Array>;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

// Нажатие, которое вызвало шаг: на него обязательно отвечаем, иначе у пользователя крутится индикатор.
export interface Trigger {
  from: UserId;
  callbackQueryId: string;
}

// Пока аудио не обрабатывает worker (шаг 5), вместо плеера — текстовая заглушка.
export function audioPlaceholder(message: OutgoingMessage): string {
  const title = message.audio?.title ?? 'Трек';
  return [`🎵 ${title}`, '(аудио ещё не подключено — включите трек по ответам ниже)', message.text]
    .filter(Boolean)
    .join('\n');
}

export class Delivery {
  private readonly api: Api;
  private readonly slots: SlotStore;
  private readonly log: Logger;
  private readonly downloadFile?: (filePath: string, signal?: AbortSignal) => Promise<Uint8Array>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;

  constructor(options: DeliveryOptions) {
    this.api = options.api;
    this.slots = options.slots;
    this.log = options.log;
    this.downloadFile = options.downloadFile;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxAttempts = options.maxAttempts ?? 5;
  }

  // Сбой одного сообщения не останавливает остальные: состояние ядра уже сохранено.
  async deliver(out: readonly Outgoing[], trigger?: Trigger): Promise<void> {
    const toasts = out.filter((o): o is OutgoingToast => o.kind === 'toast');
    if (trigger) await this.answer(trigger, toasts);
    for (const toast of toasts) {
      if (toast.to !== trigger?.from) this.log.warn(`toast для ${toast.to} без нажатия — пропущен: ${toast.text}`);
    }

    for (const item of out) {
      if (item.kind !== 'message') continue;
      try {
        await this.deliverMessage(item);
      } catch (error) {
        this.log.error(`не доставлено сообщение ${item.slot ?? '(без slot)'} для ${item.to}`, error);
      }
    }
  }

  // Ответ на нажатие: toast нажавшему или пустой ответ, чтобы погас индикатор на кнопке.
  async answer(trigger: Trigger, toasts: readonly OutgoingToast[]): Promise<void> {
    const text = toasts
      .filter((t) => t.to === trigger.from)
      .map((t) => t.text)
      .join('\n');
    try {
      await this.request('answerCallbackQuery', () =>
        this.api.raw.answerCallbackQuery({
          callback_query_id: trigger.callbackQueryId,
          text: text || undefined,
          // Длинный toast Telegram не покажет целиком — показываем окном.
          show_alert: text.length > 200 || undefined,
        }),
      );
    } catch (error) {
      // «query is too old» — нажатие старше ~15 секунд, ответить уже нельзя, шаг всё равно применён.
      this.log.warn(`answerCallbackQuery: ${describe(error)}`);
    }
  }

  // Одно сообщение; ошибку пробрасывает — outbox решает, повторять ли.
  async deliverMessage(message: OutgoingMessage): Promise<void> {
    const problems = limitViolations(message);
    if (problems.length > 0) this.log.warn(`лимиты Bot API (${message.slot ?? 'без slot'}): ${problems.join('; ')}`);

    const kind = kindOf(message);
    const known = message.slot === undefined ? undefined : await this.slots.get(message.to, message.slot);

    if (known && !message.bump && canEditInPlace(known, message, kind)) {
      try {
        await this.edit(known, message, kind);
        return;
      } catch (error) {
        if (isNotModified(error)) return;
        if (!isGone(error)) throw error;
        // Сообщение пропало — отправим новое ниже.
      }
    } else if (known) {
      await this.deleteQuietly(message.to, known.messageId);
    }

    const sent = await this.send(message, kind);
    if (message.slot !== undefined) {
      await this.slots.set(message.to, message.slot, { messageId: sent, kind, fileId: message.audio?.fileId });
    }
  }

  private async send(message: OutgoingMessage, kind: MessageKind): Promise<number> {
    const chat_id = message.to;
    const reply_markup = keyboard(message.buttons);
    if (kind === 'audio') {
      const result = await this.request('sendAudio', () =>
        this.api.raw.sendAudio({
          chat_id,
          audio: message.audio!.fileId!,
          // Явные нейтральные title/performer, чтобы плеер не показал теги исходного файла.
          title: message.audio!.title,
          performer: message.audio!.performer,
          caption: message.text || undefined,
          reply_markup,
        }),
      );
      return result.message_id;
    }
    if (kind === 'document') {
      const { fileName, content, archiveFiles } = message.document!;
      if (archiveFiles) return this.sendArchive(message, archiveFiles);
      // Строку InputFile принял бы за путь к файлу — передаём байты.
      const document = new InputFile(new TextEncoder().encode(content), fileName);
      const result = await this.request('sendDocument', () =>
        this.api.raw.sendDocument({ chat_id, document, caption: message.text || undefined, reply_markup }),
      );
      return result.message_id;
    }
    const text = message.audio ? audioPlaceholder(message) : message.text;
    const result = await this.request('sendMessage', () =>
      this.api.raw.sendMessage({ chat_id, text: text || '…', reply_markup }),
    );
    return result.message_id;
  }

  private async sendArchive(
    message: OutgoingMessage,
    files: { fileName: string; fileId: string }[],
  ): Promise<number> {
    if (!this.downloadFile) throw new Error('скачивание файлов для архива не настроено');

    const parts: Uint8Array[] = [];
    let entries: Record<string, Uint8Array> = {};
    let bytes = 0;
    for (const file of files) {
      const info = await this.request('getFile', () => this.api.raw.getFile({ file_id: file.fileId }));
      if (!info.file_path) throw new Error(`getFile без file_path для ${file.fileName}`);
      const content = await this.request('downloadFile', () => this.downloadFile!(info.file_path!));
      // MP3 уже сжат: level 0 быстрее и почти не меняет размер. Запас покрывает заголовки ZIP.
      if (bytes > 0 && bytes + content.byteLength + 1024 > MAX_ARCHIVE_PART_BYTES) {
        parts.push(zipSync(entries, { level: 0 }));
        entries = {};
        bytes = 0;
      }
      entries[file.fileName] = content;
      bytes += content.byteLength + 256;
    }
    if (Object.keys(entries).length > 0) parts.push(zipSync(entries, { level: 0 }));

    const base = message.document!.fileName.replace(/\.zip$/i, '');
    let sent = 0;
    for (const [index, part] of parts.entries()) {
      const number = String(index + 1).padStart(2, '0');
      const document = new InputFile(part, `${base}-${number}.zip`);
      const caption = `${message.text}${parts.length > 1 ? `\nЧасть ${index + 1} из ${parts.length}.` : ''}`;
      const result = await this.request('sendDocument', () =>
        this.api.raw.sendDocument({ chat_id: message.to, document, caption: caption || undefined }),
      );
      sent = result.message_id;
    }
    return sent;
  }

  private async edit(known: SlotRecord, message: OutgoingMessage, kind: MessageKind): Promise<void> {
    // Пустая клавиатура явно убирает кнопки, которые были в прошлой версии сообщения.
    const reply_markup = keyboard(message.buttons) ?? { inline_keyboard: [] };
    if (kind === 'audio') {
      await this.request('editMessageCaption', () =>
        this.api.raw.editMessageCaption({
          chat_id: message.to,
          message_id: known.messageId,
          caption: message.text,
          reply_markup,
        }),
      );
      return;
    }
    await this.request('editMessageText', () =>
      this.api.raw.editMessageText({
        chat_id: message.to,
        message_id: known.messageId,
        text: (message.audio ? audioPlaceholder(message) : message.text) || '…',
        reply_markup,
      }),
    );
  }

  private async deleteQuietly(chatId: UserId, messageId: number): Promise<void> {
    try {
      await this.request('deleteMessage', () => this.api.raw.deleteMessage({ chat_id: chatId, message_id: messageId }));
    } catch (error) {
      // Старше 48 часов или уже удалено — новое сообщение всё равно уйдёт вниз.
      this.log.warn(`deleteMessage ${messageId}: ${describe(error)}`);
    }
  }

  // Повтор с учётом retry_after (лимиты на чат и на бота) и при сетевых сбоях.
  private async request<T>(method: string, call: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await call();
      } catch (error) {
        if (!isRetryable(error) || attempt >= this.maxAttempts) throw error;
        const waitMs = retryAfterMs(error) ?? Math.min(500 * 2 ** (attempt - 1), 10_000);
        this.log.warn(`${method}: ${describe(error)}, повтор через ${waitMs} мс`);
        await this.sleep(waitMs);
      }
    }
  }
}

function kindOf(message: OutgoingMessage): MessageKind {
  if (message.document) return 'document';
  if (message.audio?.fileId) return 'audio';
  return 'text';
}

function canEditInPlace(known: SlotRecord, message: OutgoingMessage, kind: MessageKind): boolean {
  if (known.kind !== kind) return false;
  // Файл документа правкой не заменить; аудио — только если файл тот же.
  if (kind === 'document') return false;
  if (kind === 'audio') return known.fileId === message.audio?.fileId;
  return true;
}

function keyboard(buttons: Button[][] | undefined): InlineKeyboardMarkup | undefined {
  if (!buttons || buttons.length === 0) return undefined;
  return {
    inline_keyboard: buttons.map((row) => row.map((b) => (b.url ? { text: b.label, url: b.url } : { text: b.label, callback_data: b.data }))),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Облачный Bot API принимает документы до 50 МБ; оставляем запас на multipart-запрос.
const MAX_ARCHIVE_PART_BYTES = 45 * 1024 * 1024;
