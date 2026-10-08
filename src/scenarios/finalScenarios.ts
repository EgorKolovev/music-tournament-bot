import type { Scenario, ScenarioStep } from './engine.ts';
import { repeat, track } from './matchScenarios.ts';

const org = (press: string): ScenarioStep => ({ as: 'org', press });
const judge = (press: string): ScenarioStep => ({ as: 'judge', press });

// Аня играет в первом четвертьфинале против Димы, Борис — в третьем против Кати.
// Готовность и подтверждения финалистов без колонки ставятся автоматически.
const annaReady: ScenarioStep[] = [judge('ready'), { as: 'p0', press: 'ready' }];

export const FINAL_SCENARIOS: Scenario[] = [
  {
    id: 'final-quarter',
    engine: 'final',
    title: 'Четвертьфиналы на сцене',
    description:
      'Организатор выводит пару на сцену, судья финала Марина ведёт матч до 9,0. Песни идут из общей очереди: песни игроков на сцене пропускаются, а прозвучавшие в первом матче не попадают во второй.',
    steps: [
      org('start:f1-1'),
      ...annaReady,
      ...repeat(5, track('aw:a:0', 'aw:t:0')),
      judge('confirm'),
      { as: 'p0', press: 'confirm' },
      org('start:f1-2'),
      judge('ready'),
      ...repeat(4, track('aw:a:1', 'aw:t:1')),
      ...track('aw:a:0'),
      ...track('aw:t:1'),
      judge('confirm'),
    ],
  },
  {
    id: 'final-threshold-tie',
    engine: 'final',
    title: 'Порог вничью 9,3 : 9,3',
    description:
      'При 8,4 : 8,1 Аня берёт исполнителя, Дима — название. Оба перешли 9,0, но счёт равный — матч продолжается до разрыва. Победа определяется только после закрытия всего трека.',
    steps: [
      org('start:f1-1'),
      ...annaReady,
      ...repeat(4, track('aw:a:0', 'aw:t:0')),
      ...repeat(9, track('aw:a:1')),
      ...track('aw:a:0', 'aw:t:1'),
      ...track('aw:t:1'),
      judge('confirm'),
      { as: 'p0', press: 'confirm' },
    ],
  },
  {
    id: 'final-offline',
    engine: 'final',
    title: 'Пропал интернет',
    description:
      'Перед финалом организатор скачивает офлайн-комплект: лист судьи по той же очереди, что и в боте. Один матч сыгран на бумаге — после восстановления связи организатор вносит результат, сетка продолжается.',
    steps: [
      org('kit'),
      org('paper'),
      org('paper:f1-1'),
      org('🏅 Дима'),
      org('start:f1-2'),
    ],
  },
];
