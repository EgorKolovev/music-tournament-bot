import { describe, expect, it } from 'vitest';
import type { Outgoing, OutgoingMessage, UserId } from '../bot/protocol.ts';
import { createBot, fromSnapshot, handleBotEvent, pendingAudio, type BotState } from './bot.ts';
import { ORGANIZER, sender, TestBot, testConfig, violations } from './testBot.ts';

const ADMIN = '950';

const panelOf = (bot: TestBot, id: UserId) => {
  const message = bot.chats[id]?.messages.find((m) => m.author === 'bot' && m.slot === 'o:phase');
  return message?.author === 'bot' ? message : undefined;
};

// Организатор создаёт турнир через «🗂 Все турниры»: название текстом, затем подтверждение.
function createSecond(bot: TestBot, title = 'Пробный'): void {
  bot.press(ORGANIZER, 't:list');
  bot.press(ORGANIZER, 't:new');
  bot.text(ORGANIZER, title);
  bot.press(ORGANIZER, 't:create');
}

// Регистрация в турнире №N: кнопки с префиксом N~.
function register(bot: TestBot, id: UserId, number: number): void {
  const prefix = number === 1 ? '' : `${number}~`;
  bot.command(id, `/start t_${bot.state.config.code}`);
  bot.press(id, `${prefix}r:name`);
  bot.press(id, `${prefix}r:accept`);
}

describe('Несколько турниров', () => {
  it('новый турнир: название текстом, настройки как у текущего, прежний — на паузе', () => {
    const bot = new TestBot(testConfig({ adminIds: [ADMIN] }));
    bot.register('1');
    bot.register('2');
    bot.open(ORGANIZER, 'settings');
    bot.press(ORGANIZER, 'o:set:songs');
    bot.press(ORGANIZER, 'o:set:songs:5');
    bot.press(ORGANIZER, 'o:v:home');

    bot.press(ORGANIZER, 't:list');
    expect(panelOf(bot, ORGANIZER)?.text).toContain('▶️ №1 «Тестовый турнир» · сбор · 2 участника · активный');
    bot.press(ORGANIZER, 't:new');
    bot.text(ORGANIZER, 'а');
    expect(bot.lastText(ORGANIZER)).toContain('от 2 до 48 символов');
    const out = bot.text(ORGANIZER, 'Пробный');
    expect(out).toContainEqual(expect.objectContaining({ to: ORGANIZER, slot: 'o:phase', bump: true }));
    expect(bot.lastText(ORGANIZER)).toContain('➕ Новый турнир «Пробный»');
    expect(bot.lastText(ORGANIZER)).toContain('🎵 Песен на игрока: до 5');
    bot.press(ORGANIZER, 't:create');

    expect(bot.bot.active).toBe(2);
    expect(bot.bot.tournaments[0]!.pausedAt).toBe(bot.now);
    const { config, people } = bot.state;
    expect(config).toMatchObject({ title: 'Пробный', intakeRules: { maxSubmissions: 5 } });
    expect(config.code).not.toBe('test');
    expect(config.seed).not.toBe(42);
    expect(people).toEqual({});
    // Панель та же — одно сообщение, теперь про новый турнир; кнопки турнира №2 — с префиксом.
    const panel = panelOf(bot, ORGANIZER)!;
    expect(panel.text).toContain('📣 Пробный');
    expect(panel.text).toContain(`start=t_${config.code}`);
    expect(panel.buttons?.flat().map((b) => b.data)).toEqual(['2~o:v:intake', '2~o:v:players', '2~o:v:settings', 't:list']);
    // У админа — тот же активный турнир, но без списка турниров.
    expect(panelOf(bot, ADMIN)?.text).toContain('📣 Пробный');
    bot.send({ kind: 'button', from: sender(ADMIN), data: 't:list' });
    expect(bot.toasts.at(-1)).toEqual({ to: ADMIN, text: 'Турнирами управляет организатор' });
    expect(violations(bot.outLog)).toEqual([]);
  });

  it('у турнира на паузе кнопки, ссылка и сообщения отвечают паузой; в активный — по его ссылке', () => {
    const bot = new TestBot();
    bot.register('1');
    createSecond(bot);

    bot.press('1', 'i:role:songs');
    expect(bot.toasts.at(-1)).toEqual({ to: '1', text: '⏸ Турнир «Тестовый турнир» сейчас на паузе. Организатор напишет, когда продолжим.' });
    bot.text('1', 'привет');
    expect(bot.lastText('1')).toContain('на паузе');
    bot.command('5', '/start t_test');
    expect(bot.lastText('5')).toContain('«Тестовый турнир» сейчас на паузе');
    expect(bot.state.registration['5']).toBeUndefined();

    register(bot, '1', 2);
    register(bot, '5', 2);
    expect(Object.keys(bot.state.people)).toEqual(['1', '5']);
    expect(bot.bot.tournaments[0]!.state.people['1']?.number).toBe(1);
    // Сообщения турнира №2 — в своих ключах: список песен №1 у игрока остался как был.
    const slots = bot.chats['1']!.messages.flatMap((m) => (m.author === 'bot' && m.slot ? [m.slot] : []));
    expect(slots).toEqual(expect.arrayContaining(['r:reg', 'i:list', '2~r:reg', '2~i:list']));
  });

  it('переключение обратно: аудио — своему турниру, кнопки №2 — на паузе, панель без префиксов', () => {
    const bot = new TestBot();
    bot.register('1');
    createSecond(bot);
    register(bot, '3', 2);
    bot.submitSongs('3', 2);
    expect(pendingAudio(bot.bot).map((a) => a.id)).toEqual(['2~s1', '2~s2']);

    bot.press(ORGANIZER, 't:list');
    bot.press(ORGANIZER, 't:card:1');
    expect(bot.lastText(ORGANIZER)).toContain('на паузе с 10 октября');
    bot.press(ORGANIZER, 't:switch:1');
    expect(bot.lastText(ORGANIZER)).toContain('«Пробный» встанет на паузу');
    bot.press(ORGANIZER, 't:switchOk:1');
    expect(bot.bot.active).toBe(1);
    expect(bot.state.journal.at(-1)).toMatch(/^Турнир продолжен после паузы \d+ час/);
    expect(panelOf(bot, ORGANIZER)!.buttons?.flat().map((b) => b.data)).toEqual(['o:v:intake', 'o:v:players', 'o:v:settings', 't:list']);

    // Нарезка закончилась, пока №2 на паузе: результат уходит ему.
    bot.send({ kind: 'worker', results: [{ submissionId: '2~s1', ok: true, startSec: 0 }] });
    expect(bot.bot.tournaments[1]!.state.intake.intake.submissions[0]!.processing).toBe('ok');
    expect(bot.state.intake.intake.submissions).toEqual([]);

    bot.press('3', '2~i:randomAll');
    expect(bot.toasts.at(-1)?.text).toContain('«Пробный» сейчас на паузе');
  });

  it('повтор журнала даёт то же состояние', () => {
    const bot = new TestBot();
    bot.register('1');
    createSecond(bot);
    register(bot, '2', 2);
    bot.submitSongs('2', 3);
    bot.processAudio();
    bot.press(ORGANIZER, 't:list');
    bot.press(ORGANIZER, 't:card:1');
    bot.press(ORGANIZER, 't:switch:1');
    bot.press(ORGANIZER, 't:switchOk:1');

    let replayed: BotState = createBot(testConfig(), Date.parse('2026-10-10T10:00:00Z')).state;
    for (const event of bot.events) replayed = handleBotEvent(replayed, event).state;
    expect(replayed).toEqual(bot.bot);
  });

  it('пустой tick не меняет состояние — Runtime не пишет его в журнал', () => {
    const bot = new TestBot();
    createSecond(bot);
    const step = handleBotEvent(bot.bot, { at: bot.now + 1000, event: { kind: 'tick' } });
    expect(step.state).toBe(bot.bot);
    expect(step.out).toEqual([]);
  });

  it('снимок прошлой версии — один турнир: он становится №1', () => {
    const bot = new TestBot();
    bot.register('1');
    const legacy = bot.state;
    expect(fromSnapshot(legacy)).toEqual({ tournaments: [{ state: legacy }], active: 1 });
    expect(fromSnapshot(bot.bot)).toBe(bot.bot);
  });
});

// Тик в момент по Москве: '2026-10-11 12:00'.
function tickAt(bot: TestBot, moscowTime: string): Outgoing[] {
  return bot.send({ kind: 'tick' }, moscowMs(moscowTime) - bot.now);
}

function moscowMs(moscowTime: string): number {
  return Date.parse(`${moscowTime.replace(' ', 'T')}:00+03:00`);
}

const copies = (out: Outgoing[]) => out.filter((o): o is OutgoingMessage => o.kind === 'message' && Boolean(o.document?.databaseCopy));

describe('Копия базы организатору', () => {
  it('по умолчанию выключена; строка и кнопки — только в настройках организатора', () => {
    const bot = new TestBot(testConfig({ adminIds: [ADMIN] }));
    bot.open(ORGANIZER, 'settings');
    const panel = panelOf(bot, ORGANIZER)!;
    expect(panel.text).toContain('📦 Копия базы вам: выключена');
    expect(panel.buttons?.flat().map((b) => b.data).slice(-3)).toEqual(['t:copy:on', 't:copy:now', 'o:v:home']);

    bot.open(ADMIN, 'settings');
    expect(panelOf(bot, ADMIN)!.text).toContain('⚙️ Настройки');
    expect(panelOf(bot, ADMIN)!.text).not.toContain('Копия базы');
    expect(bot.buttons(ADMIN)).not.toContain('t:copy:now');
    bot.send({ kind: 'button', from: sender(ADMIN), data: 't:copy:now' });
    expect(bot.toasts.at(-1)).toEqual({ to: ADMIN, text: 'Копию базы получает только организатор' });

    expect(copies(tickAt(bot, '2026-10-11 12:00'))).toEqual([]);
    expect(bot.bot.copy).toBeUndefined();
  });

  it('включена утром: копия в 12:00 по Москве раз в день, тихий день — без файла', () => {
    const bot = new TestBot();
    bot.now = moscowMs('2026-10-11 10:00');
    bot.open(ORGANIZER, 'settings');
    bot.press(ORGANIZER, 't:copy:on');
    expect(bot.toasts.at(-1)?.text).toBe('📦 Буду присылать копию каждый день в 12:00 МСК, первую — сегодня');
    expect(panelOf(bot, ORGANIZER)!.text).toContain('📦 Копия базы вам: каждый день в 12:00 МСК');
    expect(bot.buttons(ORGANIZER)).toContain('t:copy:off');

    expect(copies(tickAt(bot, '2026-10-11 11:59'))).toEqual([]);
    const [copy] = copies(tickAt(bot, '2026-10-11 12:00'));
    expect(copy).toMatchObject({
      to: ORGANIZER,
      document: { fileName: 'tournament-20261011-120000.zip', mimeType: 'application/zip', databaseCopy: true },
      buttons: [[{ label: '🔕 Больше не присылать', data: 't:copy:stop' }]],
    });
    expect(copy!.text).toContain('📦 Копия базы на 11 октября, 12:00 МСК');
    expect(copy!.text).toContain('Активный турнир: «Тестовый турнир», сбор');

    // Второй копии за день не будет, даже если что-то произошло: это попадёт в завтрашнюю.
    bot.register('1');
    expect(copies(tickAt(bot, '2026-10-11 18:00'))).toEqual([]);
    expect(copies(tickAt(bot, '2026-10-12 12:00'))).toHaveLength(1);
    // За сутки ничего не изменилось — день отмечен, файла нет.
    expect(copies(tickAt(bot, '2026-10-13 12:00'))).toEqual([]);
    expect(bot.bot.copy).toEqual({ daily: true, day: '2026-10-13', changed: false });
    // Дальше тик пустой — Runtime не пишет его в журнал.
    const step = handleBotEvent(bot.bot, { at: moscowMs('2026-10-13 18:00'), event: { kind: 'tick' } });
    expect(step.state).toBe(bot.bot);
    expect(violations(bot.outLog)).toEqual([]);

    let replayed: BotState = createBot(testConfig(), Date.parse('2026-10-10T10:00:00Z')).state;
    for (const event of bot.events) replayed = handleBotEvent(replayed, event).state;
    expect(replayed).toEqual(bot.bot);
  });

  it('включена после 12:00 — первая завтра; бот лежал в 12:00 — пришлёт после запуска', () => {
    const bot = new TestBot();
    bot.open(ORGANIZER, 'settings');
    bot.press(ORGANIZER, 't:copy:on');
    expect(bot.toasts.at(-1)?.text).toContain('первую — завтра');
    expect(copies(tickAt(bot, '2026-10-10 20:00'))).toEqual([]);
    expect(copies(tickAt(bot, '2026-10-11 09:00'))).toEqual([]);
    const [late] = copies(tickAt(bot, '2026-10-11 15:40'));
    expect(late?.document?.fileName).toBe('tournament-20261011-154000.zip');
  });

  it('«🔕 Больше не присылать» под копией выключает, панель настроек обновляется', () => {
    const bot = new TestBot();
    bot.now = moscowMs('2026-10-11 10:00');
    bot.open(ORGANIZER, 'settings');
    bot.press(ORGANIZER, 't:copy:on');
    tickAt(bot, '2026-10-11 12:00');

    bot.press(ORGANIZER, 't:copy:stop');
    expect(bot.toasts.at(-1)).toEqual({ to: ORGANIZER, text: '🔕 Больше не пришлю. Включить снова — в ⚙️ Настройках' });
    expect(bot.bot.copy).toEqual({ daily: false });
    expect(panelOf(bot, ORGANIZER)!.text).toContain('📦 Копия базы вам: выключена');
    bot.register('1');
    expect(copies(tickAt(bot, '2026-10-12 12:00'))).toEqual([]);
    bot.press(ORGANIZER, 't:copy:stop');
    expect(bot.toasts.at(-1)?.text).toBe('Копии и так выключены');
  });

  it('«Прислать копию сейчас» — и при выключенной; при включённой ежедневная её не повторяет', () => {
    const bot = new TestBot();
    bot.open(ORGANIZER, 'settings');
    const [now] = copies(bot.press(ORGANIZER, 't:copy:now'));
    expect(now).toMatchObject({ to: ORGANIZER, document: { databaseCopy: true } });
    expect(now!.document!.fileName).toMatch(/^tournament-20261010-1300\d{2}\.zip$/);
    expect(now!.buttons).toBeUndefined();
    expect(bot.toasts.at(-1)?.text).toBe('📦 Собираю копию — пришлю файлом');
    expect(bot.bot.copy).toBeUndefined();

    bot.now = moscowMs('2026-10-11 10:00');
    bot.press(ORGANIZER, 't:copy:on');
    expect(copies(bot.press(ORGANIZER, 't:copy:now'))).toHaveLength(1);
    // С разовой копии ничего не изменилось — в 12:00 файла нет.
    expect(copies(tickAt(bot, '2026-10-11 12:00'))).toEqual([]);
    bot.register('1');
    expect(copies(tickAt(bot, '2026-10-12 12:00'))).toHaveLength(1);
  });
});
