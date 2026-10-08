import type { Engine, Scenario } from '../scenarios/engine.ts';
import { DRAW_SCENARIOS } from '../scenarios/drawScenarios.ts';
import { drawEngine, finalEngine, intakeEngine, matchEngine } from '../scenarios/engines.ts';
import { FINAL_SCENARIOS } from '../scenarios/finalScenarios.ts';
import { INTAKE_SCENARIOS } from '../scenarios/intakeScenarios.ts';
import { MATCH_SCENARIOS } from '../scenarios/matchScenarios.ts';

export type StageId = Engine<unknown>['id'];

export interface Stage {
  id: StageId;
  number: number;
  title: string;
  summary: string;
  // Ключевые решения этапа из docs/decisions/2026-10-08-mechanics-revision.md.
  decisions: string[];
  // Сессии движков разные; симулятор работает с ними одинаково через кадры.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  engine: Engine<any>;
  scenarios: Scenario[];
}

export const STAGES: Stage[] = [
  {
    id: 'intake',
    number: 1,
    title: 'Сбор треков',
    summary: 'Участники пересылают боту до 10 песен пачкой — из музыкального бота или откуда удобно.',
    decisions: [
      'Названия берутся из тегов и имени файла; бот спрашивает только непонятное',
      'Пул игрок не выбирает: бот делит песни на отбор и финал после закрытия сбора',
      'Чужие дубли принимаются молча — состав библиотеки не утекает',
      'Недобравших бот не пускает в жеребьёвку без решения организатора',
    ],
    engine: intakeEngine(),
    scenarios: INTAKE_SCENARIOS,
  },
  {
    id: 'draw',
    number: 2,
    title: 'Жеребьёвка и пары',
    summary: 'Сетка на выбывание до 8 финалистов, проходы без игры распределены по первому кругу.',
    decisions: [
      'Карточка пары сразу показывает соперника и его контакт',
      'Судью выбирают из зарегистрированных; он соглашается, второй игрок подтверждает',
      'Сроки сдвигает админ кнопкой — бот уведомляет только затронутых и пишет журнал',
    ],
    engine: drawEngine(),
    scenarios: DRAW_SCENARIOS,
  },
  {
    id: 'match',
    number: 3,
    title: 'Отборочный матч',
    summary: 'Игроки и судья вместе; судья включает трек со своего телефона и отмечает ответы кнопками.',
    decisions: [
      'Короткий матч: 5 треков, побеждает тот, у кого больше очков',
      'Исполнитель 0,9 и название 1,2 разыгрываются независимо; итог — после закрытия трека',
      'Ничья — по одному треку до разрыва; остановка только если кончились песни',
      'Свои песни игрокам не выдаются, ответы видит только судья',
    ],
    engine: matchEngine(),
    scenarios: MATCH_SCENARIOS,
  },
  {
    id: 'final',
    number: 4,
    title: 'Финал',
    summary: 'Очный финал через бота: 8 → 4 → 2 → 1, судит человек не из участников.',
    decisions: [
      'Регламент финала свой: до 9,0, ничья — до разрыва',
      'Песни идут из одной очереди с seed, песни пары на сцене пропускаются',
      'Прозвучавшее в финале больше не выдаётся никому — зал слышит все матчи',
      'Офлайн-комплект с той же очередью — запасной план без интернета',
    ],
    engine: finalEngine(),
    scenarios: FINAL_SCENARIOS,
  },
];

export function stageById(id: string): Stage | undefined {
  return STAGES.find((s) => s.id === id);
}
