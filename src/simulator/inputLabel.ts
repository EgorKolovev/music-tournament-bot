import { actionOf } from '../bot/chat.ts';
import type { Incoming } from '../bot/protocol.ts';

// Подпись шага в журнале нажатий.
export function describeInput(input: Incoming | undefined, names: Map<string, string>): string {
  if (!input) return 'старт';
  if (input.kind === 'worker') return `⚙️ worker обработал файлов: ${input.results.length}`;
  const who = names.get(input.from) ?? input.from;
  switch (input.kind) {
    case 'button':
      return `${who}: ${actionOf(input.data)}`;
    case 'text':
      return `${who}: «${input.text}»`;
    case 'files':
      return `${who}: переслал файлов: ${input.files.length}`;
  }
}
