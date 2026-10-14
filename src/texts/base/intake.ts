import { plural } from '../../shared/text.ts';
import { pick, pickWith } from '../variants.ts';

// Сбор песен: вводное, список песен участника, фрагмент. Вводное — от организаторов («мы»),
// остальное — от бота.

export const intake = {
  welcome: {
    hello: ({ name }: { name: string }) => `Привет, ${name}! Сейчас собираем песни для всего турнира.`,
    send: ({ max }: { max: number }) =>
      `Пришли до ${max} песен — пересылай по одному файлу или пачкой сразу, можешь воспользоваться вот этим ботом @Music_to_you_bot или скачать их откуда удобно.`,
    titles: [
      'Исполнителя и название бот определит из файла; если не получится — спросит.',
      'Исполнитель и название песни должны быть без лишних слов. Их можно будет поменять после загрузки.',
    ].join('\n'),
    fragment: ({ sec }: { sec: number }) =>
      `Судья услышит фрагмент до ${sec} секунд — с начала песни, с места, которое выберешь ты, или со случайного.`,
    pools: 'Песни на отборочные и финал ботик разделит сам после закрытия сбора.',
    songsOnly: '🎁 Ты только присылаешь песни: в жеребьёвку не попадёшь, но тебя могут позвать судить. Передумаешь — кнопка под списком.',
  },

  reject: {
    tooLarge: 'файл больше 20 МБ, Telegram не даст его скачать',
    badFormat: 'нужен MP3 или M4A',
    corrupt: 'файл не открывается',
    duplicateOwn: 'она уже есть в твоём списке',
    quotaFull: ({ max }: { max: number }) => `сверх лимита: можно ${max} ${plural(max, 'песню', 'песни', 'песен')}`,
  },

  list: {
    closed: ({ accepted, max }: { accepted: number; max: number }) => `🔒 Сбор закрыт · принято ${accepted} из ${max}`,
    closedSongsOnly: 'Спасибо за песни! Ты не играешь, но тебя могут позвать судить.',
    closedPlaying: pick('Дальше жеребьёвка — пару пришлю сюда.', 'Дальше жеребьёвка — как только она пройдёт, пару пришлю сюда.'),
    songsOnly: ({ accepted, max }: { accepted: number; max: number }) => `🎁 Твои песни · принято ${accepted} из ${max}`,
    songsOnlyHint: 'Ты только присылаешь песни — в жеребьёвку не попадёшь. Проверь названия: по ним судья засчитывает ответы.',
    full: ({ max }: { max: number }) => `✅ Все ${max} песен приняты`,
    fullHint: 'Можно менять до закрытия сбора.',
    progress: ({ accepted, max }: { accepted: number; max: number }) => `🎵 Твои песни · принято ${accepted} из ${max}`,
    progressHint: 'Проверь названия — по ним судья засчитывает ответы.',
    song: ({ n, label, mark, start }: { n: number; label: string; mark: string; start: string }) => `${n}. ${label} ${mark} · с ${start}`,
    rejectedTitle: 'Не подошло — пришли замену:',
    rejected: ({ n, label, reason }: { n: number; label: string; reason: string }) => `${n}. ${label} — ${reason}`,
    noName: 'без имени',
    askTitle: ({ n, label }: { n: number; label: string }) => `✏️ Песня ${n}: сейчас «${label}». Ответь сообщением в формате «Исполнитель — Название».`,
    noTitle: ({ n, file }: { n: number; file: string }) =>
      `✏️ Песня ${n} (${file}): не нашёл название. Ответь сообщением в формате «Исполнитель — Название».`,
    askStart: ({ n, start }: { n: number; start: string }) =>
      `⏱ Песня ${n}: сейчас с ${start}. С какого момента её играть? Напиши время, например 1:15; 0 — с начала. Или 🎲 — случайное место.`,
    pick: {
      edit: 'Какую песню исправить?',
      remove: 'Какую песню убрать?',
      start: 'Для какой песни выбрать начало?',
      listen: 'Какую песню послушать?',
    },
  },

  buttons: {
    cancel: 'Отмена',
    random: '🎲 Случайно',
    play: '🎤 Всё-таки играю',
    songsOnly: '🎁 Не играю, только песни',
    edit: '✏️ Исправить',
    remove: '🗑 Убрать',
    start: '⏱ Начало',
    listen: '🎧 Послушать',
    randomAll: '🎲 Случайное начало всем',
    done: '✅ Готово',
  },

  notice: {
    closed: 'Сбор уже закрыт, так что новые песни и правки я больше не принимаю.',
    received: ({ count, rejected }: { count: number; rejected: number }) =>
      `Получил ${count} ${plural(count, 'файл', 'файла', 'файлов')}${rejected ? `, не подошло: ${rejected}` : ''}.`,
    // Спасибо за пачку песен, которая вся подошла.
    thanks: pickWith<{ total: number }>('Спасибо!', 'Спасибо за песни!', 'Отлично, спасибо!'),
    editHint: 'Чтобы поправить название, нажми «✏️ Исправить» под списком.',
    badTitle: ({ text }: { text: string }) => `Не разобрал «${text}»: исполнителя и название нужно разделить тире.`,
    titleRejected: ({ label, reason }: { label: string; reason: string }) => `«${label}»: ${reason}. Пришли другую песню.`,
    titleSaved: pickWith<{ label: string }>(({ label }) => `Записал: ${label}.`, ({ label }) => `Готово, записал: ${label}.`),
    songsOnly: '🎁 Готово: присылаешь песни, но не играешь. Передумаешь — кнопка ниже.',
    playing: '🎤 Готово: ты снова играешь.',
    left: '🎁 Ты больше не играешь — присланные песни остаются в турнире.',
    removed: ({ label }: { label: string }) => `Убрал «${label}».`,
    gone: 'Этой песни уже нет в списке.',
    badStart: ({ text }: { text: string }) =>
      `Не разобрал «${text}». Напиши время, например 1:15; 0 — с начала. Или 🎲 — случайное место.`,
    tooLate: ({ duration, sec, latest }: { duration: string; sec: number; latest: string }) =>
      `Песня длится ${duration}, фрагмент ${sec} с — начало не позже ${latest}.`,
    start: ({ n, start }: { n: number; start: string }) => `Песня ${n} начнётся с ${start}.`,
    randomStart: ({ n, start }: { n: number; start: string }) => `Песня ${n} начнётся с ${start} — выбрал случайно.`,
    randomAll: ({ changed, kept }: { changed: number; kept: number }) =>
      `🎲 Случайное начало у ${changed} ${plural(changed, 'песни', 'песен', 'песен')}` +
      (kept > 0 ? `, у ${kept} — прежнее: короткие или без длины` : '') +
      '. Послушать — «🎧 Послушать».',
  },

  toast: {
    closed: 'Сбор уже закрыт',
    gone: 'Этой песни уже нет в списке',
    noFurther: 'Дальше сдвигать некуда',
    stalePreview: 'Этот фрагмент уже устарел',
    nothing: 'Пока нечего выбирать',
    pickFirst: 'Сначала выбери действие под списком',
    noDuration: 'Не знаю длину песни — напиши время вручную',
    tooShort: 'Песня короткая — случайное место не выбрать',
    allTooShort: 'Песни короткие или без длины — случайное начало не выбрать',
  },

  preview: {
    done: ({ n, label, start }: { n: number; label: string; start: string }) => `✅ Песня ${n}: ${label}\nНачнётся с ${start}.`,
    title: ({ n, label }: { n: number; label: string }) => `🎧 Песня ${n}: ${label}`,
    start: ({ start, sec }: { start: string; sec: number }) => `Начало ${start} · до ${sec} с`,
    cutting: '⏳ Нарезаю фрагмент…',
    ready: 'Так её услышит судья.',
    noCut: 'Фрагменты сейчас не нарезаются — судья включит песню с этого места вручную.',
    shift: 'Сдвинуть начало или выбрать случайно:',
  },
};
