import { pickWith } from '../variants.ts';

// Команды участника: /help, /status, /matches, /style, и общие ответы бота.
// title — «№1.4: Аня — Борис», score — «Аня 2,5 : 1,0 Борис».

export const commands = {
  unknown: pickWith<{ command: string }>('Не знаю такой команды.', 'Такой команды я не знаю.'),
  helpRef: '/help — что я умею.',
  hint: 'Команды: /matches — кто с кем играет, /help — что я умею.',

  help: {
    intro: 'Я веду турнир: собираю песни, развожу пары, помогаю судить матчи и финал. Почти всё делается кнопками в сообщениях.',
    status: '/status — где ты сейчас',
    matches: '/matches — кто с кем играет',
    style: '/style — как мне с тобой разговаривать',
    leave: '/leave — выйти из турнира',
  },

  style: {
    title: '🎭 Как мне с тобой разговаривать?',
    current: ({ name }: { name: string }) => `Сейчас: ${name}.`,
    about: 'Стиль меняет только то, как я пишу тебе. Правила и кнопки те же, остальные участники ничего не заметят.',
    chosen: ({ name }: { name: string }) => `Готово, теперь так: ${name}`,
    same: 'Этот стиль уже выбран',
    // Перед включением стиля с предупреждением.
    confirmBack: 'Вернуть прежний стиль можно в любой момент — /style.',
    confirmYes: 'Да, включай',
    confirmNo: 'Нет, оставить как есть',
    stranger: 'Стиль можно выбрать после регистрации в турнире.',
  },

  status: {
    header: ({ title, phase }: { title: string; phase: string }) => `Турнир «${title}» · этап: ${phase}`,
    phases: { intake: 'сбор песен', qualifiers: 'отбор', final: 'финал', archive: 'турнир завершён' },
    you: ({ number, name }: { number: number; name: string }) => `Ты: №${number}, ${name}`,
    organizer: 'Ты организатор турнира.',
    admin: 'Ты админ турнира.',
    stranger: 'Ты пока не в турнире — нужна ссылка-приглашение от организатора.',

    songs: ({ accepted, max }: { accepted: number; max: number }) => `🎵 Песен принято: ${accepted} из ${max}`,
    songsOnlyIntake: '🎁 Ты только присылаешь песни, а в матчах не участвуешь.',
    songsOnly: '🎁 Твои песни в игре, а в матчах ты не участвуешь.',
    champion: ({ name }: { name: string }) => `🏁 Победитель — ${name}`,
    left: '🚪 Ты больше не в турнире.',
    removed: '🚪 Тебя сняли с турнира по решению организатора.',
    noDraw: '🎲 Жеребьёвки ещё не было — пару пришлю, как только она пройдёт.',

    until: ({ until }: { until: string }) => `, сыграть ${until}`,
    current: ({ match, opponent, until, progress }: { match: string; opponent: string; until: string; progress: string }) =>
      `🎤 Твой матч ${match}, соперник — ${opponent}${until}. Сейчас: ${progress}.`,
    eliminated: ({ match, winner }: { match: string; winner: string }) => `Отбор для тебя закончен: в ${match} дальше проходит ${winner}.`,
    finalist: '🏆 Ты в финале! Когда и где он пройдёт, сообщит организатор.',
    nextRound: '⏳ Следующий круг ещё не начался.',
    next: ({ match, from, until }: { match: string; from: string; until: string }) => `⏳ Твой следующий матч ${match}${from}${until}.`,
    from: ({ title }: { title: string }) => ` — соперник определится в ${title}`,

    judging: ({ title, progress }: { title: string; progress: string }) => `⚖️ Судишь ${title}: ${progress}`,
    invited: ({ title }: { title: string }) => `⚖️ Тебя зовут судить ${title} — ответь в приглашении.`,
    judgingWait: ({ title }: { title: string }) => `⚖️ Судишь ${title}: ждём, пока пара подтвердит судью.`,

    finalJudge: '⚖️ Ты судья финала.',
    finalMatch: ({ title }: { title: string }) => `🏆 ${title}`,
    onStage: ({ score }: { score: string }) => ` — на сцене, ${score}`,
    waitStage: ' — ждёт выхода на сцену',
    winner: '🏆 Ты победитель турнира!',
    finalOver: 'Финал для тебя закончен. Спасибо за игру!',
    finalWaiting: '🏆 Ты в финале — соперник ещё определяется.',
  },

  // Шаг матча одной строкой — в /status и карточках.
  progress: {
    dispute: 'спор — решает организатор',
    judge: ({ name }: { name: string }) => `, судья ${name}`,
    lobby: ({ judge }: { judge: string }) => `ждём «Все на месте»${judge}`,
    decided: ({ score }: { score: string }) => `сыгран, ${score} — ждём подтверждения результата`,
    live: ({ score, judge }: { score: string; judge: string }) => `идёт, ${score}${judge}`,
    noJudge: 'нужно выбрать судью — кнопка в карточке пары',
    agreed: ({ judge }: { judge: string }) => `судья ${judge} — согласие есть, ждём подтверждения пары`,
    waitJudge: ({ judge }: { judge: string }) => `ждём ответа судьи ${judge}`,
  },

  matches: {
    intake: '🎵 Идёт сбор песен — матчей пока нет.',
    finished: ({ champion }: { champion?: string }) => `🏁 Турнир завершён${champion ? `. Победитель — ${champion}` : ''}.`,
    noDraw: '🎲 Жеребьёвки ещё не было — пары появятся после неё.',
    qualifiers: ({ done, all }: { done: number; all: number }) => `🎤 Отбор · сыграно ${done} из ${all}`,
    live: 'Сейчас играют:',
    liveMatch: ({ match, score, judge, dispute }: { match: string; score: string; judge: string; dispute: boolean }) =>
      `🎤 ${match}: ${score} · судья ${judge}${dispute ? ' · ⚠️ спор' : ''}`,
    waiting: 'Ждут начала:',
    waitingMatch: ({ title }: { title: string }) => `⏳ ${title} · выбирают судью`,
    done: 'Сыграно:',
    doneMatch: ({ title, winner }: { title: string; winner: string }) => `✅ ${title} → ${winner}`,
    out: ({ names }: { names: string }) => `🚪 Вне турнира: ${names}`,
    finalNotStarted: ({ names }: { names: string }) => `🏆 Финал ещё не начался. Финалисты: ${names}.`,
    final: '🏆 Финал',
    onStage: ({ score }: { score: string }) => `🎤 На сцене: ${score}`,
    finalWaiting: ({ title }: { title: string }) => `⏳ ${title}`,
  },

  toast: {
    stale: 'Кнопка устарела',
    intakeClosed: 'Сбор уже закрыт',
    adminOnly: 'Эта кнопка — для организатора и админов',
    noDraw: 'Жеребьёвки ещё не было',
    finalNotStarted: 'Финал ещё не начался',
  },
  filesClosed: 'Сбор песен уже закрыт — новые песни не нужны.',
  // Турнир, в котором человек участвует, не активен: организатор переключился на другой.
  paused: ({ title }: { title: string }) => `⏸ Турнир «${title}» сейчас на паузе. Организатор напишет, когда продолжим.`,
  over: ({ title }: { title: string }) => `🏁 Турнир «${title}» завершён.`,
  needInvite: 'Чтобы участвовать, открой ссылку-приглашение от организатора.',
};
