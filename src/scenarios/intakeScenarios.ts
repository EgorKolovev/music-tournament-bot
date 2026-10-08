import type { Scenario } from './engine.ts';

// Кнопки в шагах сбора треков ищутся по data (pick:edit, cancel) или по подписи (номер трека).
export const INTAKE_SCENARIOS: Scenario[] = [
  {
    id: 'intake-batch',
    engine: 'intake',
    title: 'Пачка из 10 с проблемами',
    description:
      'Аня пересылает 10 треков разом: часть с мусором в тегах, один без тегов, один с заглушками, один огромный. Бот сам чистит названия, спрашивает только про непонятные, принимает замену.',
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
    title: 'Дубли и битый файл',
    description:
      'Борис присылает «Hey Jude» с другими тегами — это дубль песни Ани. Ещё один его файл оказывается битым после обработки. Он убирает лишнее и присылает замены.',
    steps: [
      { as: 'p0', forward: ['beatles', 'muse'] },
      { as: 'p1', forward: ['beatles2', 'nirvana', 'billie-broken', 'coldplay-ogg'] },
      { worker: true },
      { as: 'p1', forward: ['zemfira', 'rammstein'] },
      { worker: true },
    ],
  },
  {
    id: 'intake-pools',
    engine: 'intake',
    title: 'Перенос между пулами и правка',
    description:
      'Аня сдаёт все 10, потом меняет местами трек из отбора и из финала, исправляет название и убирает один трек.',
    steps: [
      {
        as: 'p0',
        forward: ['queen', 'kino', 'abba', 'nirvana', 'zemfira', 'muse', 'rammstein', 'agata', 'ddt', 'splean-tagged'],
      },
      { worker: true },
      { as: 'p0', press: 'pick:move' },
      { as: 'p0', press: '1' },
      { as: 'p0', press: '10' },
      { as: 'p0', press: 'pick:edit' },
      { as: 'p0', press: '1' },
      { as: 'p0', send: 'Кино — Группа крови' },
      { as: 'p0', press: 'pick:remove' },
      { as: 'p0', press: '5' },
    ],
  },
];
