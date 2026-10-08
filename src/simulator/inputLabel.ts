import { actionOf } from '../bot/chat.ts';
import type { Incoming } from '../bot/protocol.ts';

// Понятные подписи действий для журнала: коды кнопок — внутренняя деталь бота.
const ACTIONS: Record<string, string> = {
  ready: 'на месте',
  issue: 'выдать трек',
  start: 'начать трек',
  'aw:a:0': 'исполнитель → 1-й игрок',
  'aw:a:1': 'исполнитель → 2-й игрок',
  'aw:t:0': 'название → 1-й игрок',
  'aw:t:1': 'название → 2-й игрок',
  undo: 'отменить последнее',
  close: 'закрыть трек',
  none: 'никто не угадал',
  audioError: 'ошибка аудио',
  pause: 'пауза',
  resume: 'продолжить',
  confirm: 'подтвердить результат',
  cancel: 'отмена',
  closeIntake: 'закрыть сбор',
  'pick:edit': 'исправить название…',
  'pick:remove': 'убрать песню…',
  draw: 'провести жеребьёвку',
  pickJudge: 'выбрать судью…',
  kit: 'скачать офлайн-комплект',
  paper: 'внести результат с бумаги…',
};

const WITH_ARGUMENT: [RegExp, (arg: string, name: (id: string) => string) => string][] = [
  [/^n:(.+)$/, () => 'выбрать песню'],
  [/^admit:(.+)$/, (id, name) => `допустить: ${name(id)}`],
  [/^exclude:(.+)$/, (id, name) => `не допускать: ${name(id)}`],
  [/^judge:(.+)$/, (id, name) => `позвать судьёй: ${name(id)}`],
  [/^accept:(.+)$/, () => 'согласиться судить'],
  [/^decline:(.+)$/, () => 'отказаться судить'],
  [/^confirmJudge:(.+)$/, () => 'подтвердить судью'],
  [/^shift:(\d+)$/, (round) => `сдвинуть срок ${round}-го круга`],
  [/^start:(.+)$/, () => 'вывести пару на сцену'],
  [/^paper:(.+)$/, () => 'выбрать матч'],
  [/^winner:(.+)$/, (id, name) => `победа: ${name(id)}`],
];

export function describeInput(input: Incoming | undefined, names: Map<string, string>): string {
  if (!input) return 'старт';
  if (input.kind === 'worker') return `⚙️ обработано файлов: ${input.results.length}`;
  const who = names.get(input.from) ?? input.from;
  switch (input.kind) {
    case 'button':
      return `${who}: ${describeAction(actionOf(input.data), names)}`;
    case 'text':
      return `${who}: «${input.text}»`;
    case 'files':
      return `${who}: переслано файлов: ${input.files.length}`;
  }
}

function describeAction(action: string, names: Map<string, string>): string {
  if (ACTIONS[action]) return ACTIONS[action];
  for (const [pattern, label] of WITH_ARGUMENT) {
    const match = pattern.exec(action);
    if (match) return label(match[1]!, (id) => names.get(id) ?? id);
  }
  return action;
}
