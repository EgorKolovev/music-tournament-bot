import type { AudioFile } from '../domain/submission/intake.ts';
import type { Button, Outgoing, OutgoingMessage, UserId, UserIncoming } from './protocol.ts';

// Модель того, что пользователь видит в своём чате с ботом. Повторяет поведение Telegram:
// сообщение со slot редактируется на месте, с bump — переезжает вниз, остальные добавляются в конец.

export interface BotChatMessage extends OutgoingMessage {
  author: 'bot';
  id: number;
  edits: number;
}

export interface UserChatMessage {
  author: 'user';
  id: number;
  text?: string;
  files?: AudioFile[];
}

export type ChatMessage = BotChatMessage | UserChatMessage;

export interface ChatToast {
  id: number;
  text: string;
}

export interface Chat {
  messages: ChatMessage[];
  toasts: ChatToast[];
}

export type Chats = Record<UserId, Chat>;

const EMPTY_CHAT: Chat = { messages: [], toasts: [] };

export function applyOutgoing(chats: Chats, outgoing: readonly Outgoing[], nextId: () => number): Chats {
  const result: Chats = { ...chats };
  for (const item of outgoing) {
    const chat = result[item.to] ?? EMPTY_CHAT;
    if (item.kind === 'toast') {
      result[item.to] = { ...chat, toasts: [...chat.toasts, { id: nextId(), text: item.text }] };
      continue;
    }
    const index =
      item.slot === undefined ? -1 : chat.messages.findIndex((m) => m.author === 'bot' && m.slot === item.slot);
    const messages = [...chat.messages];
    if (index === -1) {
      messages.push({ ...item, author: 'bot', id: nextId(), edits: 0 });
    } else if (item.bump) {
      messages.splice(index, 1);
      messages.push({ ...item, author: 'bot', id: nextId(), edits: 0 });
    } else {
      const previous = messages[index] as BotChatMessage;
      messages[index] = { ...item, author: 'bot', id: previous.id, edits: previous.edits + 1 };
    }
    result[item.to] = { ...chat, messages };
  }
  return result;
}

// Сообщения самого пользователя: текст и пересланные файлы видны в его чате.
export function applyUserMessage(chats: Chats, input: UserIncoming, id: number): Chats {
  if (input.kind === 'button') return chats;
  const chat = chats[input.from] ?? EMPTY_CHAT;
  const message: UserChatMessage =
    input.kind === 'text' ? { author: 'user', id, text: input.text } : { author: 'user', id, files: input.files };
  return { ...chats, [input.from]: { ...chat, messages: [...chat.messages, message] } };
}

// Ищет кнопку по действию (data без суффикса версии) среди сообщений чата, начиная с последнего.
// Сценарии жмут только то, что пользователь действительно видит.
export function findButton(chat: Chat | undefined, action: string): Button | undefined {
  for (const message of [...(chat?.messages ?? [])].reverse()) {
    if (message.author !== 'bot') continue;
    for (const row of message.buttons ?? []) {
      const button = row.find((b) => actionOf(b.data) === action || b.label === action);
      if (button) return button;
    }
  }
  return undefined;
}

export function actionOf(data: string): string {
  return data.split('|')[0]!;
}
