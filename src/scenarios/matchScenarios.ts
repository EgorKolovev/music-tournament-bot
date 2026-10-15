import type { MatchPhase } from '../domain/match/match.ts';
import type { Scenario, ScenarioStep } from './engine.ts';

// Шаги матча жмут кнопки по действию без суффикса версии:
// ready, issue, start, aw:a:0, aw:t:1, undo, close, none, cancel, pause, resume, confirm.
export interface MatchScenario extends Scenario {
  expect: Pick<MatchPhase, 'kind'> & { winner?: 0 | 1 };
}

const judge = (press: string): ScenarioStep => ({ as: 'judge', press });

export const everyoneReady: ScenarioStep[] = [judge('ready'), { as: 'p0', press: 'ready' }, { as: 'p1', press: 'ready' }];

export const confirmAll: ScenarioStep[] = [judge('confirm'), { as: 'p0', press: 'confirm' }, { as: 'p1', press: 'confirm' }];

export function track(...awards: string[]): ScenarioStep[] {
  const closing = awards.length > 0 ? 'close' : 'none';
  return [judge('issue'), judge('start'), ...awards.map(judge), judge(closing)];
}

export function repeat(times: number, steps: ScenarioStep[]): ScenarioStep[] {
  return Array.from({ length: times }, () => steps).flat();
}

export const MATCH_SCENARIOS: MatchScenario[] = [
  {
    id: 'quick-win',
    engine: 'match',
    title: 'Короткий матч: уверенная победа',
    description:
      'Отборочный матч из 5 треков. Аня угадывает всё, но матч не заканчивается досрочно — победа фиксируется после пятого трека. Результат подтверждают судья и оба игрока.',
    steps: [...everyoneReady, ...repeat(5, track('aw:a:0', 'aw:t:0')), ...confirmAll],
    expect: { kind: 'finished', winner: 0 },
  },
  {
    id: 'qualifier-tie',
    engine: 'match',
    title: 'Ничья 2,5 : 2,5 и отрыв в 2 балла',
    description:
      'Аня берёт исполнителя первой песни, Борис — название, во второй наоборот: после 5 треков 2,5 : 2,5. Дальше по одному треку, пока отрыв меньше 2 баллов: Борис уходит вперёд, 2,5 : 4,0, но этого мало; Аня отыгрывается — 3,5 : 4,0, затем 6,0 : 4,0. Паузы и жребия нет.',
    steps: [
      ...everyoneReady,
      ...track('aw:a:0', 'aw:t:1'), // 1,0 : 1,5
      ...track('aw:a:1', 'aw:t:0'), // 2,5 : 2,5
      ...repeat(3, track()), // 5 треков, 2,5 : 2,5
      ...track('aw:t:1'), // 2,5 : 4,0 — отрыв 1,5, мало
      ...track('aw:a:0'), // 3,5 : 4,0
      ...track('aw:a:0', 'aw:t:0'), // 6,0 : 4,0 — ровно 2,0
      ...confirmAll,
    ],
    expect: { kind: 'finished', winner: 0 },
  },
  {
    id: 'undo-audio-error-pause',
    engine: 'match',
    title: 'Отмена, ошибка аудио, пауза',
    description:
      'Судья ошибся кнопкой и отменил её, потом трек сломался и был технически отменён — он не тратит лимит матча. Затем пауза и продолжение.',
    steps: [
      ...everyoneReady,
      judge('issue'),
      judge('start'),
      judge('aw:a:1'),
      judge('undo'),
      judge('aw:a:0'),
      judge('close'),
      judge('issue'),
      judge('start'),
      judge('aw:t:1'),
      judge('audioError'),
      judge('pause'),
      judge('resume'),
      ...track(),
    ],
    expect: { kind: 'between_tracks' },
  },
  {
    id: 'songs-exhausted',
    engine: 'match',
    title: 'Закончились песни',
    description:
      'Никто ничего не угадывает, ничья тянется, пока не кончатся подходящие песни (свои песни игрокам не выдаются). Только тогда матч останавливается до решения организатора.',
    steps: [...everyoneReady, ...repeat(34, track()), judge('issue')],
    expect: { kind: 'suspended' },
  },
];
