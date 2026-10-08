import type { Button, Outgoing, OutgoingMessage, UserId } from './protocol.ts';

// Модель того, что пользователь видит в своём чате с ботом. Повторяет поведение Telegram:
// сообщение со slot редактируется на месте, остальные добавляются в конец.

export interface ChatMessage extends OutgoingMessage {
  id: number;
  edits: number;
}

export interface ChatToast {
  id: number;
  text: string;
}

export interface Chat {
  messages: ChatMessage[];
  toasts: ChatToast[];
}

export type Chats = Record<UserId, Chat>;

export function applyOutgoing(chats: Chats, outgoing: readonly Outgoing[], nextId: () => number): Chats {
  const result: Chats = { ...chats };
  for (const item of outgoing) {
    const chat = result[item.to] ?? { messages: [], toasts: [] };
    if (item.kind === 'toast') {
      result[item.to] = { ...chat, toasts: [...chat.toasts, { id: nextId(), text: item.text }] };
      continue;
    }
    const index = item.slot === undefined ? -1 : chat.messages.findIndex((m) => m.slot === item.slot);
    const messages = [...chat.messages];
    if (index === -1) {
      messages.push({ ...item, id: nextId(), edits: 0 });
    } else {
      const previous = messages[index]!;
      messages[index] = { ...item, id: previous.id, edits: previous.edits + 1 };
    }
    result[item.to] = { ...chat, messages };
  }
  return result;
}

// Ищет кнопку по действию (data без суффикса версии) среди сообщений чата, начиная с последнего.
// Сценарии жмут только то, что пользователь действительно видит.
export function findButton(chat: Chat | undefined, action: string): Button | undefined {
  for (const message of [...(chat?.messages ?? [])].reverse()) {
    for (const row of message.buttons ?? []) {
      const button = row.find((b) => actionOf(b.data) === action);
      if (button) return button;
    }
  }
  return undefined;
}

export function actionOf(data: string): string {
  return data.split('|')[0]!;
}
