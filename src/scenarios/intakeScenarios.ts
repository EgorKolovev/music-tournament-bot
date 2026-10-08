import type { Scenario } from './engine.ts';

// Кнопки в шагах сбора треков ищутся по data (pick:edit, closeIntake, admit:u-boris) или по подписи (номер песни).
export const INTAKE_SCENARIOS: Scenario[] = [
  {
    id: 'intake-batch',
    engine: 'intake',
    title: 'Пачка из 10 с проблемами',
    description:
      'Аня пересылает 10 песен разом: часть с мусором в тегах, одна без тегов, одна с заглушками, одна слишком большая. Бот сам чистит названия, спрашивает только про непонятные и принимает замену. «Queen» и «Кино» уже прислали другие — бот молча склеивает дубли.',
    steps: [
      {
        as: 'p0',
        forward: ['queen', 'kino', 'abba', 'splean', 'track04', 'daftpunk', 'linkin', 'unknown', 'radiohead-big', 'agata'],
      },
      { worker: true },
      { as: 'p0', send: 'Полковнику никто не пишет' },
      { as: 'p0', send: 'Би-2 — Полковнику никто не пишет' },
      { as: 'p0', send: 'Ночные Снайперы — 31-я весна' },
      { as: 'p0', forward: ['ddt'] },
      { worker: true },
    ],
  },
  {
    id: 'intake-duplicates',
    engine: 'intake',
    title: 'Дубли и битые файлы',
    description:
      'Борис присылает «Hey Jude», которую уже прислали другие, — бот принимает её без вопросов, чтобы не выдать состав библиотеки. Свою же песню второй раз бот не берёт. OGG и битый файл отклоняются, замены принимаются.',
    steps: [
      { as: 'p1', forward: ['beatles2', 'nirvana', 'billie-broken', 'coldplay-ogg'] },
      { worker: true },
      { as: 'p1', forward: ['nirvana', 'zemfira', 'rammstein'] },
      { worker: true },
    ],
  },
  {
    id: 'intake-close',
    engine: 'intake',
    title: 'Закрытие сбора и пулы',
    description:
      'Аня сдаёт все 10, Борис — только 3. Организатор закрывает сбор: бот делит песни на отбор и финал под число участников, показывает достаточность пулов и не пускает недобравших в жеребьёвку без решения организатора.',
    steps: [
      {
        as: 'p0',
        forward: ['queen', 'kino', 'abba', 'nirvana', 'zemfira', 'muse', 'rammstein', 'agata', 'ddt', 'splean-tagged'],
      },
      { as: 'p1', forward: ['beatles', 'linkin', 'daftpunk'] },
      { worker: true },
      { as: 'org', press: 'closeIntake' },
      { as: 'p1', forward: ['coldplay-ogg'] },
      { as: 'org', press: 'admit:u-boris' },
      { as: 'org', press: 'admit:u-bg-1' },
      { as: 'org', press: 'exclude:u-bg-11' },
    ],
  },
];
