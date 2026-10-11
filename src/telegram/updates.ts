import type { Message, Update, User } from 'grammy/types';
import type { UserId } from '../bot/protocol.ts';
import type { AudioFile } from '../domain/submission/intake.ts';

// Разбор Telegram update в события ядра. Файлы приходят по одному — в пачку их собирает FileBatcher.

export interface Sender {
  id: UserId;
  name: string;
  username?: string;
}

export type ParsedUpdate =
  | { kind: 'button'; from: Sender; data: string; callbackQueryId: string }
  | { kind: 'text'; from: Sender; text: string }
  | { kind: 'command'; from: Sender; command: string; payload: string }
  | { kind: 'file'; from: Sender; file: AudioFile; mediaGroupId?: string }
  | { kind: 'ignored'; reason: string };

const AUDIO_EXTENSIONS = /\.(mp3|m4a|aac|mp4|ogg|oga|opus|flac|wav)$/i;

export function parseUpdate(update: Update): ParsedUpdate {
  const query = update.callback_query;
  if (query) {
    if (query.message && query.message.chat.type !== 'private') return { kind: 'ignored', reason: 'not private' };
    return { kind: 'button', from: senderOf(query.from), data: query.data ?? '', callbackQueryId: query.id };
  }

  const message = update.message;
  if (!message?.from) return { kind: 'ignored', reason: 'no message' };
  if (message.chat.type !== 'private') return { kind: 'ignored', reason: 'not private' };
  if (message.from.is_bot) return { kind: 'ignored', reason: 'from bot' };
  const from = senderOf(message.from);

  if (message.text !== undefined) {
    const command = /^\/([a-z0-9_]+)(?:@\w+)?(?:\s+(.*))?$/is.exec(message.text.trim());
    if (command) return { kind: 'command', from, command: command[1]!.toLowerCase(), payload: command[2]?.trim() ?? '' };
    return { kind: 'text', from, text: message.text };
  }

  // Пересланные сообщения приходят с теми же полями audio/document.
  const file = audioFileOf(message);
  if (file) return { kind: 'file', from, file, mediaGroupId: message.media_group_id };

  return { kind: 'ignored', reason: 'unsupported message' };
}

export function audioFileOf(message: Message): AudioFile | undefined {
  const { audio, document } = message;
  if (audio) {
    return {
      fileId: audio.file_id,
      fileUniqueId: audio.file_unique_id,
      fileName: audio.file_name,
      mimeType: audio.mime_type,
      sizeBytes: audio.file_size ?? 0,
      durationSec: audio.duration,
      performer: audio.performer,
      title: audio.title,
    };
  }
  // Документ считаем аудио по MIME или расширению; формат окончательно проверяет ядро и worker.
  if (document && (document.mime_type?.startsWith('audio/') || AUDIO_EXTENSIONS.test(document.file_name ?? ''))) {
    return {
      fileId: document.file_id,
      fileUniqueId: document.file_unique_id,
      fileName: document.file_name,
      mimeType: document.mime_type,
      sizeBytes: document.file_size ?? 0,
    };
  }
  return undefined;
}

export function senderOf(user: User): Sender {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || user.username || String(user.id);
  return { id: String(user.id), name, username: user.username };
}
