import { plural } from '../../shared/text.ts';
import { pickWith } from '../variants.ts';

// Матч — отборочный и финальный: панель судьи и сообщение игроку о ходе матча.
// points и lead — уже отформатированные баллы («1,5», «2,0»), score — строка счёта «Аня 2,5 : 1,0 Борис».
// Номер трека или матча у фраз, которые повторяются от трека к треку и от матча к матчу, — только для
// выбора варианта: в стилях на новом треке или матче выпадает другой, а перерисовка панели его не меняет.

export const match = {
  judge: {
    title: ({ final, match }: { final: boolean; match: string }) => `${final ? 'Финал' : 'Отбор'} · матч №${match} · ты судья`,
    fixed: ({ tracks }: { tracks: number }) => `${tracks} ${plural(tracks, 'трек', 'трека', 'треков')}, побеждает тот, кто наберёт больше`,
    fixedTie: 'При ничьей — ещё по треку, пока кто-то не вырвется вперёд',
    // Отбор с отрывом (настройка «📏 Отрыв в отборе»); без отрыва — fixedTie.
    fixedLead: ({ lead }: { lead: string }) => `При отрыве меньше ${lead} — ещё по треку, пока кто-то не оторвётся на ${lead}`,
    firstTo: ({ points }: { points: string }) => `Играем до ${points}: кто первым наберёт столько и будет впереди, тот и победил`,
    limit: ({ tracks }: { tracks: number }) => `Не больше ${tracks} ${plural(tracks, 'трека', 'треков', 'треков')}; при ничьей — ещё по треку, пока кто-то не вырвется вперёд`,
    points: ({ artist, title }: { artist: string; title: string }) => `За исполнителя ${artist} · за название ${title}`,
    whoIsHere: ({ judge, p0, p1 }: { judge: string; p0: string; p1: string }) => `Кто на месте: судья ${judge}, ${p0}, ${p1}`,
    fewSongs: ({ available, needed }: { available: number; needed: number }) =>
      `⚠️ Подходящих песен ${available}, а нужно хотя бы ${needed}. Напиши организатору.`,
    allHere: 'Все на месте ✅',
    paused: pickWith<{ n: number }>('⏸ Пауза'),
    startAt: ({ start }: { start: string }) => `Включи с ${start}`,
    answers: ({ n }: { n: number }) => `🔒 Ответы · трек ${n}`,
    artist: ({ artist }: { artist: string }) => `Исполнитель: ${artist}`,
    songTitle: ({ title }: { title: string }) => `Название: ${title}`,
    alsoAccepted: ({ answers }: { answers: string }) => `Засчитывай и так: ${answers}`,
    awards: ({ artist, title }: { artist: string; title: string }) => `Исполнитель: ${artist} · Название: ${title}`,
    cancelled: ({ n }: { n: number }) => `Трек ${n} не в счёт: не включилось аудио`,
    closed: ({ n }: { n: number }) => `Трек ${n} закрыт`,
    // К треку, который никто не угадал.
    nobody: pickWith<{ n: number }>('Непростой трек — бывает.', 'Сложный попался, бывает.', 'Этот трек оказался непростым.'),
    playing: ({ n }: { n: number }) => `▶️ Трек ${n} идёт`,
    ready: ({ n }: { n: number }) => `Трек ${n} готов`,
    startHint: pickWith<{ n: number }>('Аудио и ответы — выше. Включи трек и нажми «Начать трек».'),
    played: ({ played, of }: { played: number; of: number }) => `Сыграно ${played} из ${of}`,
    extra: ({ n }: { n: number }) => `Ничья — дополнительный трек ${n}`,
    // После основной части при отрыве: счёт может быть и неравным, поэтому не «ничья».
    extraLead: ({ n, lead }: { n: number; lead: string }) => `Отрыв меньше ${lead} — дополнительный трек ${n}`,
    winner: ({ name }: { name: string }) => `🏁 Победа: ${name}`,
    waitConfirm: ({ names }: { names: string }) => `Ждём подтверждения: ${names}`,
    confirm: pickWith<{ match: string }>('Подтверди результат матча.'),
    confirmed: ({ name }: { name: string }) => `✅ Результат подтверждён. Победа: ${name}`,
    suspended: '⛔ Подходящие песни закончились — матч остановлен, дальше решает организатор.',
  },

  player: {
    header: ({ match, opponent, judge }: { match: string; opponent: string; judge: string }) =>
      `Матч №${match} · соперник: ${opponent} · судья: ${judge}`,
    here: pickWith<{ match: string }>('✅ Ты на месте, ждём остальных', '✅ Отметил, что ты на месте. Ждём остальных'),
    comeIn: pickWith<{ match: string }>('Как доберёшься до места — нажми «Я на месте».', 'Когда будешь на месте — нажми «Я на месте».'),
    played: ({ count }: { count: number }) => `Сыграно треков: ${count}`,
    winner: ({ name }: { name: string }) => `🏁 Победа: ${name}`,
    waitJudge: 'Ждём подтверждения судьи.',
    confirmed: '✅ Твоё подтверждение есть — ждём соперника.',
    finished: ({ name }: { name: string }) => `✅ Матч завершён. Победа: ${name}`,
    suspended: '⛔ Подходящие песни закончились — матч остановлен, ждём решения организатора.',
    paused: '⏸ Пауза',
    // К итогу матча.
    won: pickWith<{ match: string }>('Поздравляю с победой!', 'Отличная игра, поздравляю!', 'Здорово сыграно, поздравляю!'),
    lost: pickWith<{ match: string }>('Спасибо за игру, было здорово!', 'Хорошая игра, спасибо!', 'Спасибо, что сыграли!'),
  },

  buttons: {
    resume: '▶️ Продолжить',
    allHere: 'Все на месте',
    issue: ({ n }: { n: number }) => `Выдать трек ${n}`,
    pause: '⏸ Пауза',
    start: '▶️ Начать трек',
    audioError: '⚠️ Ошибка аудио',
    artist: ({ points }: { points: string }) => `Исполнитель +${points}`,
    title: ({ points }: { points: string }) => `Название +${points}`,
    artistDone: '✅ Исполнитель',
    titleDone: '✅ Название',
    undo: '↩️ Отменить последнее',
    nobody: 'Никто не угадал',
    close: '✅ Закрыть трек',
    confirm: 'Подтвердить результат',
    here: 'Я на месте',
    confirmPlayer: 'Подтверждаю результат',
  },

  toast: {
    paused: 'Матч на паузе',
    notPaused: 'Матч не на паузе',
    wrongPhase: 'Сейчас эта кнопка не работает',
    alreadyReady: 'Уже отмечено, что ты на месте',
    trackNotStarted: 'Сначала нажми «Начать трек»',
    trackStarted: 'Трек уже идёт',
    componentTaken: 'Этот ответ уже засчитан',
    nothingToUndo: 'Нечего отменять',
    awardsPresent: 'Ответы уже отмечены — закрой трек',
    judgeFirst: 'Сначала результат подтверждает судья',
    alreadyConfirmed: 'Результат уже подтверждён',
    stranger: 'Ты не играешь и не судишь этот матч',
    stalePanel: 'Эта панель устарела — вот свежая',
    judgeOnly: 'Эта кнопка — для судьи',
    unknown: 'Не понял, что это за кнопка',
  },
};
