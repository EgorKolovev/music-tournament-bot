import type { Scenario } from './engine.ts';

export const DRAW_SCENARIOS: Scenario[] = [
  {
    id: 'draw-pairs',
    engine: 'draw',
    title: 'Жеребьёвка, судья, перенос срока',
    description:
      'Организатор проводит жеребьёвку: 19 игроков, 13 проходов без игры, 11 матчей отбора. Аня сразу видит соперника и его контакт, зовёт судьёй Вику — та свободна в первом круге. Вика соглашается, Борис подтверждает. Потом организатор сдвигает срок круга — бот уведомляет только затронутых.',
    steps: [
      { as: 'org', press: 'draw' },
      { as: 'p0', press: 'pickJudge' },
      { as: 'p0', press: 'judge:u-vika' },
      { as: 'judge', press: '✅ Соглашаюсь' },
      { as: 'p1', press: '✅ Подтверждаю судью' },
      { as: 'org', press: 'shift:1' },
    ],
  },
  {
    id: 'draw-decline',
    engine: 'draw',
    title: 'Судья отказался',
    description:
      'Вика не может судить и отказывается. Аня выбирает другого человека из списка зарегистрированных, Борис подтверждает нового судью.',
    steps: [
      { as: 'org', press: 'draw' },
      { as: 'p0', press: 'pickJudge' },
      { as: 'p0', press: 'judge:u-vika' },
      { as: 'judge', press: 'Не смогу' },
      { as: 'p1', press: 'pickJudge' },
      { as: 'p1', press: 'Марина' },
      { as: 'p0', press: '✅ Подтверждаю судью' },
    ],
  },
];
