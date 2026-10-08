import type { MatchPhase } from '../domain/match/match.ts';

export type Role = 'judge' | 'p0' | 'p1';

export interface ScenarioStep {
  as: Role;
  // Действие кнопки без суффикса версии: ready, issue, start, aw:a:0, aw:t:1, undo, close, none, cancel, pause, resume, confirm.
  press: string;
}

export interface Scenario {
  id: string;
  title: string;
  description: string;
  steps: ScenarioStep[];
  expect: Pick<MatchPhase, 'kind'> & { winner?: 0 | 1 };
}

const judge = (press: string): ScenarioStep => ({ as: 'judge', press });

const everyoneReady: ScenarioStep[] = [judge('ready'), { as: 'p0', press: 'ready' }, { as: 'p1', press: 'ready' }];

const confirmAll: ScenarioStep[] = [judge('confirm'), { as: 'p0', press: 'confirm' }, { as: 'p1', press: 'confirm' }];

function track(...awards: string[]): ScenarioStep[] {
  const closing = awards.length > 0 ? 'close' : 'none';
  return [judge('issue'), judge('start'), ...awards.map(judge), judge(closing)];
}

function repeat(times: number, steps: ScenarioStep[]): ScenarioStep[] {
  return Array.from({ length: times }, () => steps).flat();
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'quick-win',
    title: 'Быстрая победа',
    description: 'Аня угадывает всё пять треков подряд и доходит до 10,5. Подтверждают судья и оба игрока.',
    steps: [...everyoneReady, ...repeat(5, track('aw:a:0', 'aw:t:0')), ...confirmAll],
    expect: { kind: 'finished', winner: 0 },
  },
  {
    id: 'threshold-tie',
    title: 'Порог вничью 9,3 : 9,3',
    description:
      'При 8,4 : 8,1 Аня берёт исполнителя, Борис — название. Оба перешли 9,0, но счёт равный, поэтому игра продолжается.',
    steps: [
      ...everyoneReady,
      ...repeat(4, track('aw:a:0', 'aw:t:0')),
      ...repeat(9, track('aw:a:1')),
      ...track('aw:a:0', 'aw:t:1'),
      ...track('aw:t:1'),
      ...confirmAll,
    ],
    expect: { kind: 'finished', winner: 1 },
  },
  {
    id: 'undo-audio-error-pause',
    title: 'Отмена, ошибка аудио, пауза',
    description:
      'Судья ошибся кнопкой и отменил её, потом трек сломался и был технически отменён, затем пауза и продолжение.',
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
      judge('cancel'),
      judge('pause'),
      judge('resume'),
      ...track(),
    ],
    expect: { kind: 'between_tracks' },
  },
  {
    id: 'tiebreak-win',
    title: 'Дополнительная серия',
    description: '20 треков без угадываний, 0 : 0. В дополнительной серии первый неравный итог завершает матч.',
    steps: [...everyoneReady, ...repeat(21, track()), ...track('aw:a:1'), ...confirmAll],
    expect: { kind: 'finished', winner: 1 },
  },
  {
    id: 'tiebreak-suspended',
    title: 'Равенство после серии',
    description: '25 треков без угадываний. Жребия нет: матч приостанавливается до решения организатора.',
    steps: [...everyoneReady, ...repeat(25, track())],
    expect: { kind: 'suspended' },
  },
];
