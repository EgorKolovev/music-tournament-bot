import { formatDate } from '../bot/drawSession.ts';
import { pendingSubmissions } from '../bot/intakeSession.ts';
import type { Button, Outgoing, OutgoingMessage, UserId, WorkerResult } from '../bot/protocol.ts';
import type { Submission } from '../domain/submission/intake.ts';
import { plural } from '../shared/text.ts';
import type { Sender, StampedEvent, TournamentEvent } from './events.ts';
import { canAdmin, isoDate, isOrganizer, panelHolders } from './helpers.ts';
import { adminPanel, PANEL_SLOT, screenOf } from './panels.ts';
import { SETTING_KEYS, settingLine, settingSummary } from './settings.ts';
import type { Phase, TournamentConfig, TournamentState } from './state.ts';
import { createTournament, handleEvent } from './tournament.ts';

// Несколько турниров в одном боте (docs/decisions/2026-10-13-tournaments-in-bot.md). Активен один,
// остальные на паузе, ничего не удаляется. Создаёт турниры и переключает активный только
// организатор — из «🗂 Все турниры» в панели.
//
// Все турниры — одно состояние и один журнал событий: создание и переключение — обычные нажатия
// в журнале, и повтор журнала приходит к тому же. Внутри турнира ничего не знает о соседях: у турнира
// №N (N > 1) префикс N~ в данных кнопок, ключах сообщений и задачах аудио, у №1 префикса нет —
// поэтому журнал и кнопки, отправленные до этой версии, значат то же самое.
//
// Панель админа — одно сообщение на весь бот: она показывает активный турнир, а организатору —
// ещё и список турниров. Переключение правит её на месте.

export interface TournamentEntry {
  state: TournamentState;
  // У турнира, начатого до этой версии, не известно.
  createdAt?: number;
  // С какого момента на паузе; у активного нет.
  pausedAt?: number;
}

// Экраны «🗂 Все турниры» поверх панели турнира.
export type LobbyScreen = 'list' | 'new' | 'newConfirm' | `card:${number}` | `switch:${number}`;

export interface BotState {
  // №N — tournaments[N − 1].
  tournaments: TournamentEntry[];
  active: number;
  // Организатор вышел из панели турнира к списку; undefined — панель активного турнира.
  lobby?: LobbyScreen;
  // Название нового турнира, пока организатор его подтверждает.
  draftTitle?: string;
  // Копия базы организатору (docs/decisions/2026-10-14-database-copy.md). Нет — выключена.
  copy?: DatabaseCopy;
}

export interface DatabaseCopy {
  // Присылать каждый день в 12:00 по Москве.
  daily: boolean;
  // День по Москве (YYYY-MM-DD), за который ежедневная копия уже прислана или пропущена.
  day?: string;
  // С прошлой копии в турнирах что-то изменилось — есть что сохранять.
  changed?: boolean;
}

export interface BotStep {
  state: BotState;
  out: Outgoing[];
}

// Шаг маршрутизации: кому панель нужно прислать внизу ленты, а не править на месте.
interface Routed extends BotStep {
  bumped: Set<UserId>;
}

const SCOPED = /^(\d+)~(.*)$/s;
const LOBBY = 't:';
// Москва — UTC+3 круглый год; по ней же считаются сроки кругов.
const MSK_OFFSET_MS = 3 * 3_600_000;
const COPY_HOUR = 12;
const PHASE_NAME: Record<Phase, string> = { intake: 'сбор', qualifiers: 'отбор', final: 'финал', archive: 'завершён' };

export function createBot(config: TournamentConfig, at?: number): BotStep {
  const created = createTournament(config);
  const bot: BotState = { tournaments: [{ state: created.state, createdAt: at }], active: 1 };
  const routed = absorb(bot, 1, created);
  return { state: routed.state, out: [...routed.out, ...botPanels(bot)] };
}

// Снимок до этой версии — один турнир без обёртки: он становится турниром №1.
export function fromSnapshot(stored: BotState | TournamentState): BotState {
  return 'tournaments' in stored ? stored : { tournaments: [{ state: stored }], active: 1 };
}

// Организатор, админы и username бота приходят из окружения при каждом запуске — у всех турниров.
export function withLiveConfig(bot: BotState, live: Pick<TournamentConfig, 'organizerId' | 'adminIds' | 'botUsername'>): BotState {
  const tournaments = bot.tournaments.map((t) => ({ ...t, state: { ...t.state, config: { ...t.state.config, ...live } } }));
  return { ...bot, tournaments };
}

export function activeTournament(bot: BotState): TournamentState {
  return bot.tournaments[bot.active - 1]!.state;
}

// Песни, ждущие нарезки, во всех турнирах: id задачи с префиксом турнира, длина фрагмента — его.
export function pendingAudio(bot: BotState): { id: string; submission: Submission; fragmentSec: number }[] {
  return bot.tournaments.flatMap((t, index) =>
    pendingSubmissions(t.state.intake).map((submission) => ({
      id: scoped(index + 1, submission.id),
      submission,
      fragmentSec: t.state.config.fragmentSec,
    })),
  );
}

export function handleBotEvent(bot: BotState, { at, event }: StampedEvent): BotStep {
  const before = new Map(botPanels(bot).map((m) => [m.to, JSON.stringify(m)]));
  let routed = trackChanges(bot, route(bot, event, at));
  if (event.kind === 'tick') routed = dailyCopy(routed, at);
  const panels = botPanels(routed.state).flatMap((m): OutgoingMessage[] => {
    if (routed.bumped.has(m.to)) return [{ ...m, bump: true }];
    return before.get(m.to) === JSON.stringify(m) ? [] : [m];
  });
  return { state: routed.state, out: [...routed.out, ...panels] };
}

function route(bot: BotState, event: TournamentEvent, at: number): Routed {
  switch (event.kind) {
    case 'button':
      return routeButton(bot, event.from, event.data, at);
    case 'command':
      return routeCommand(bot, event, at);
    case 'text':
      if (bot.lobby === 'new' && isOrganizer(activeTournament(bot), event.from.id)) return draftTitle(bot, event.from.id, event.text);
      return pausedNotice(bot, event.from.id) ?? inActive(bot, event, at);
    case 'files':
      return pausedNotice(bot, event.from.id) ?? inActive(bot, event, at);
    case 'worker':
      return routeWorker(bot, event.results, at);
    case 'tick':
      // Сроки и напоминания — только у активного турнира.
      return inActive(bot, event, at);
  }
}

function routeButton(bot: BotState, from: Sender, data: string, at: number): Routed {
  if (data.startsWith(LOBBY)) return lobbyButton(bot, from.id, data.slice(LOBBY.length), at);
  const { number, rest } = unscope(data);
  if (number !== bot.active) return toast(bot, from.id, inactiveText(bot, number) ?? 'Кнопка устарела');
  const routed = inActive(bot, { kind: 'button', from, data: rest }, at);
  // Нажатие в панели турнира — организатор вернулся к нему из списка турниров.
  if (bot.lobby && rest.startsWith('o:') && isOrganizer(activeTournament(bot), from.id)) {
    return { ...routed, state: { ...routed.state, lobby: undefined, draftTitle: undefined } };
  }
  return routed;
}

// Ссылка-приглашение и ссылка судьи финала несут код турнира: по ссылке турнира на паузе
// в активный никто не записывается.
function routeCommand(bot: BotState, event: Extract<TournamentEvent, { kind: 'command' }>, at: number): Routed {
  const { from, command, payload } = event;
  if (command === 'help') return inActive(bot, event, at);
  if (command === 'start') {
    const code = /^(?:t|fjudge)_(.+)$/.exec(payload)?.[1];
    const owner = code === undefined ? undefined : bot.tournaments.findIndex((t) => t.state.config.code === code) + 1;
    if (owner && owner !== bot.active) return say(bot, from.id, inactiveText(bot, owner)!);
    if (owner === bot.active) return inActive(bot, event, at);
  }
  return pausedNotice(bot, from.id) ?? inActive(bot, event, at);
}

// Результаты нарезки — тому турниру, чья это песня, даже если он на паузе.
function routeWorker(bot: BotState, results: WorkerResult[], at: number): Routed {
  const groups = new Map<number, WorkerResult[]>();
  for (const result of results) {
    const { number, rest } = unscope(result.submissionId);
    if (!bot.tournaments[number - 1]) continue;
    groups.set(number, [...(groups.get(number) ?? []), { ...result, submissionId: rest }]);
  }
  let routed: Routed = { state: bot, out: [], bumped: new Set() };
  for (const [number, group] of groups) {
    const state = routed.state.tournaments[number - 1]!.state;
    const step = absorb(routed.state, number, handleEvent(state, { at, event: { kind: 'worker', results: group } }));
    routed = { state: step.state, out: [...routed.out, ...step.out], bumped: routed.bumped };
  }
  return routed;
}

function inActive(bot: BotState, event: TournamentEvent, at: number): Routed {
  return absorb(bot, bot.active, handleEvent(activeTournament(bot), { at, event }));
}

// Шаг турнира №number в общем состоянии: его сообщения — с префиксом, панели рисует сам бот.
function absorb(bot: BotState, number: number, step: { state: TournamentState; out: Outgoing[] }): Routed {
  const bumped = new Set<UserId>();
  const out: Outgoing[] = [];
  for (const o of step.out) {
    if (o.kind === 'message' && o.slot === PANEL_SLOT) {
      if (o.bump) bumped.add(o.to);
      continue;
    }
    out.push(scopeOutgoing(number, o));
  }
  // Турнир не изменился — и бот тот же: Runtime не пишет пустой tick в журнал.
  if (bot.tournaments[number - 1]!.state === step.state) return { state: bot, out, bumped };
  const tournaments = bot.tournaments.map((t, i) => (i === number - 1 ? { ...t, state: step.state } : t));
  return { state: { ...bot, tournaments }, out, bumped };
}

// Человек пишет боту, а его турнир на паузе: в активном его не знают, ответит пауза.
function pausedNotice(bot: BotState, id: UserId): Routed | undefined {
  const active = activeTournament(bot);
  if (knows(active, id) || canAdmin(active, id)) return undefined;
  for (let number = bot.tournaments.length; number >= 1; number--) {
    if (number !== bot.active && knows(bot.tournaments[number - 1]!.state, id)) return say(bot, id, inactiveText(bot, number)!);
  }
  return undefined;
}

function knows(state: TournamentState, id: UserId): boolean {
  return Boolean(state.people[id] || state.registration[id]);
}

function inactiveText(bot: BotState, number: number): string | undefined {
  const entry = bot.tournaments[number - 1];
  if (!entry) return undefined;
  const { title } = entry.state.config;
  if (entry.state.phase === 'archive') return `🏁 Турнир «${title}» завершён.`;
  return `⏸ Турнир «${title}» сейчас на паузе. Организатор напишет, когда продолжим.`;
}

// --- Префиксы ---------------------------------------------------------------------------

function scoped(number: number, value: string): string {
  return number === 1 ? value : `${number}~${value}`;
}

function unscope(value: string): { number: number; rest: string } {
  const match = SCOPED.exec(value);
  return match ? { number: Number(match[1]), rest: match[2]! } : { number: 1, rest: value };
}

function scopeOutgoing(number: number, o: Outgoing): Outgoing {
  if (number === 1 || o.kind === 'toast') return o;
  return { ...o, slot: o.slot === undefined ? undefined : scoped(number, o.slot), buttons: scopeButtons(number, o.buttons) };
}

function scopeButtons(number: number, rows: Button[][] | undefined): Button[][] | undefined {
  return rows?.map((row) => row.map((b) => (b.url || b.data.startsWith(LOBBY) ? b : { ...b, data: scoped(number, b.data) })));
}

// --- Панель -------------------------------------------------------------------------------

function botPanels(bot: BotState): OutgoingMessage[] {
  return panelHolders(activeTournament(bot)).map((holder) => botPanel(bot, holder));
}

function botPanel(bot: BotState, holder: UserId): OutgoingMessage {
  const state = activeTournament(bot);
  const organizer = isOrganizer(state, holder);
  if (organizer && bot.lobby) return { kind: 'message', to: holder, slot: PANEL_SLOT, ...lobbyScreen(bot) };
  const panel = adminPanel(state, holder);
  const buttons = scopeButtons(bot.active, panel.buttons) ?? [];
  if (organizer && screenOf(state, holder) === 'home') buttons.push([{ label: '🗂 Все турниры', data: 't:list' }]);
  return { ...panel, buttons: buttons.length > 0 ? buttons : undefined };
}

function lobbyScreen(bot: BotState): { text: string; buttons: Button[][] } {
  const screen = bot.lobby!;
  const current = activeTournament(bot).config.title;
  if (screen === 'new') {
    const text = [
      '➕ Новый турнир',
      '',
      'Пришлите название одним сообщением — от 2 до 48 символов.',
      `Настройки возьму у «${current}», поменять их можно в ⚙️ Настройках нового турнира, пока идёт сбор.`,
    ];
    return { text: text.join('\n'), buttons: [[{ label: 'Отмена', data: 't:list' }]] };
  }
  if (screen === 'newConfirm') {
    const config = activeTournament(bot).config;
    const text = [
      `➕ Новый турнир «${bot.draftTitle}»`,
      '',
      `Настройки — как у «${current}»:`,
      ...SETTING_KEYS.map((key) => settingSummary(config, key)),
      '',
      'Участники регистрируются заново — по новой ссылке-приглашению, она будет в панели.',
      `«${current}» встанет на паузу.`,
    ];
    const buttons = [
      [{ label: '✅ Создать и перейти', data: 't:create' }],
      [
        { label: '✏️ Другое название', data: 't:new' },
        { label: 'Отмена', data: 't:list' },
      ],
    ];
    return { text: text.join('\n'), buttons };
  }
  const card = /^card:(\d+)$/.exec(screen);
  if (card) return cardScreen(bot, Number(card[1]));
  const confirm = /^switch:(\d+)$/.exec(screen);
  if (confirm) {
    const number = Number(confirm[1]);
    const text = [
      `Перейти в «${bot.tournaments[number - 1]!.state.config.title}»?`,
      '',
      `«${current}» встанет на паузу: его кнопки и ссылки перестанут работать, напоминаний о сроках не будет. ` +
        'Сами сроки кругов не останавливаются — после возвращения их можно сдвинуть в «Сетке».',
      'Вернуться можно в любой момент — здесь же, в «🗂 Все турниры».',
    ];
    const buttons = [
      [
        { label: '✅ Перейти', data: `t:switchOk:${number}` },
        { label: 'Отмена', data: `t:card:${number}` },
      ],
    ];
    return { text: text.join('\n'), buttons };
  }
  return listScreen(bot);
}

function listScreen(bot: BotState): { text: string; buttons: Button[][] } {
  const lines = ['🗂 Турниры', ''];
  const buttons: Button[][] = [];
  bot.tournaments.forEach((entry, index) => {
    const number = index + 1;
    const { title } = entry.state.config;
    lines.push(`${mark(bot, number)} №${number} «${title}» · ${summary(bot, number)}`);
    buttons.push([{ label: `${mark(bot, number)} №${number} ${title}`, data: `t:card:${number}` }]);
  });
  lines.push('', 'Активен один турнир. У остальных кнопки и ссылки не работают, пока в них не вернётесь.');
  // Бэкап — здесь, а не в настройках турнира: в файле вся база, все турниры разом.
  const daily = bot.copy?.daily ?? false;
  lines.push('', `📦 Бэкап — все турниры одним файлом вам в личку. Каждый день в 12:00 МСК: ${daily ? 'включено' : 'выключено'}.`);
  buttons.push(
    [{ label: '➕ Новый турнир', data: 't:new' }],
    [
      { label: '📦 Прислать бэкап', data: `${LOBBY}copy:now` },
      daily ? { label: '🔕 Не присылать в 12:00', data: `${LOBBY}copy:off` } : { label: '⏰ Присылать в 12:00', data: `${LOBBY}copy:on` },
    ],
    [{ label: '⬅️ К турниру', data: 't:close' }],
  );
  return { text: lines.join('\n'), buttons };
}

function cardScreen(bot: BotState, number: number): { text: string; buttons: Button[][] } {
  const entry = bot.tournaments[number - 1]!;
  const { state } = entry;
  const lines = [`${mark(bot, number)} №${number} «${state.config.title}»`, summary(bot, number)];
  if (entry.createdAt !== undefined) lines.push(`Создан ${formatDate(isoDate(entry.createdAt))}`);
  lines.push('', ...SETTING_KEYS.map((key) => settingLine(state, key)));
  const buttons: Button[][] = [];
  if (number !== bot.active) buttons.push([{ label: '▶️ Перейти в этот турнир', data: `t:switch:${number}` }]);
  buttons.push([{ label: '⬅️ К списку', data: 't:list' }]);
  return { text: lines.join('\n'), buttons };
}

function mark(bot: BotState, number: number): string {
  if (number === bot.active) return '▶️';
  return bot.tournaments[number - 1]!.state.phase === 'archive' ? '🏁' : '⏸';
}

function summary(bot: BotState, number: number): string {
  const entry = bot.tournaments[number - 1]!;
  const people = Object.keys(entry.state.people).length;
  const parts = [PHASE_NAME[entry.state.phase], `${people} ${plural(people, 'участник', 'участника', 'участников')}`];
  if (number === bot.active) parts.push('активный');
  else if (entry.pausedAt !== undefined && entry.state.phase !== 'archive') parts.push(`на паузе с ${formatDate(isoDate(entry.pausedAt))}`);
  return parts.join(' · ');
}

// --- Список турниров: t:<действие>, только организатор ------------------------------------

function lobbyButton(bot: BotState, actor: UserId, data: string, at: number): Routed {
  const copy = data.startsWith('copy:');
  if (!isOrganizer(activeTournament(bot), actor)) return toast(bot, actor, copy ? 'Бэкап получает только организатор' : 'Турнирами управляет организатор');
  if (copy) return copyButton(bot, actor, data.slice('copy:'.length), at);
  const show =(lobby: LobbyScreen | undefined): Routed => ({ state: { ...bot, lobby, draftTitle: undefined }, out: [], bumped: new Set() });
  if (data === 'list') return show('list');
  if (data === 'close') return show(undefined);
  if (data === 'new') return show('new');
  if (data === 'create') {
    if (bot.lobby !== 'newConfirm' || !bot.draftTitle) return toast(bot, actor, 'Кнопка устарела');
    return createNext(bot, actor, at);
  }
  const target = /^(card|switch|switchOk):(\d+)$/.exec(data);
  const number = Number(target?.[2]);
  if (!target || !bot.tournaments[number - 1]) return toast(bot, actor, 'Кнопка устарела');
  if (target[1] === 'card') return show(`card:${number}`);
  if (number === bot.active) return toast(bot, actor, 'Этот турнир и так активный');
  if (target[1] === 'switch') return show(`switch:${number}`);
  const switched = switchTo(bot, number, at);
  return toast(switched, actor, `▶️ Активный турнир — «${activeTournament(switched).config.title}»`);
}

function draftTitle(bot: BotState, actor: UserId, text: string): Routed {
  const title = text.trim().replace(/\s+/g, ' ');
  if (title.length < 2 || title.length > 48 || title.startsWith('/')) {
    return say(bot, actor, 'Название — от 2 до 48 символов. Пришлите ещё раз или нажмите «Отмена» в панели.');
  }
  // Панель ушла вверх по ленте, пока организатор писал, — присылаем её внизу.
  return { state: { ...bot, lobby: 'newConfirm', draftTitle: title }, out: [], bumped: new Set([actor]) };
}

// Активный турнир встаёт на паузу, выбранный продолжается.
function switchTo(bot: BotState, number: number, at: number): BotState {
  const paused = pauseActive(bot, at);
  const tournaments = paused.tournaments.map((entry, index): TournamentEntry => {
    if (index !== number - 1) return entry;
    const hours = entry.pausedAt === undefined ? undefined : Math.round((at - entry.pausedAt) / 3_600_000);
    const pause = hours === undefined ? '' : ` после паузы ${hours} ${plural(hours, 'час', 'часа', 'часов')}`;
    return { ...entry, pausedAt: undefined, state: note(entry.state, `Турнир продолжен${pause}`) };
  });
  return { ...paused, tournaments, active: number };
}

function pauseActive(bot: BotState, at: number): BotState {
  const tournaments = bot.tournaments.map((entry, index) =>
    index === bot.active - 1 ? { ...entry, pausedAt: at, state: note(entry.state, 'Турнир на паузе') } : entry,
  );
  return { ...bot, tournaments, lobby: undefined, draftTitle: undefined };
}

// Новый турнир — с нуля, с настройками активного; код и seed выводятся из времени нажатия,
// чтобы повтор журнала дал те же.
function createNext(bot: BotState, actor: UserId, at: number): Routed {
  const number = bot.tournaments.length + 1;
  const base = activeTournament(bot);
  const config: TournamentConfig = {
    ...base.config,
    title: bot.draftTitle!,
    code: newCode(bot, at),
    seed: hash32(`${at}:${number}:seed`) % 1_000_000,
  };
  const created = createTournament(config);
  const started = note(created.state, `Создан с настройками «${base.config.title}»`);
  const paused = pauseActive(bot, at);
  const next: BotState = { ...paused, tournaments: [...paused.tournaments, { state: started, createdAt: at }], active: number };
  const routed = absorb(next, number, { state: started, out: created.out });
  return { ...routed, out: [...routed.out, { kind: 'toast', to: actor, text: `✅ Турнир «${config.title}» создан и активен` }] };
}

function newCode(bot: BotState, at: number): string {
  for (let salt = 0; ; salt++) {
    const code = hash32(`${at}:${bot.tournaments.length + 1}:${salt}`).toString(16).padStart(8, '0');
    if (!bot.tournaments.some((t) => t.state.config.code === code)) return code;
  }
}

// FNV-1a: детерминированный, без зависимости от процесса.
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// --- Бэкап, то есть копия базы: t:copy:<действие>, только организатор -------------------------

// now, on и off — в «🗂 Все турниры», stop — под присланным бэкапом. now работает и при выключенном ежедневном.
function copyButton(bot: BotState, actor: UserId, action: string, at: number): Routed {
  const copy = bot.copy ?? { daily: false };
  if (action === 'now') {
    // Разовая копия тоже копия: если до 12:00 ничего не изменится, ежедневная её не повторит.
    const state = copy.daily ? { ...bot, copy: { ...copy, changed: false } } : bot;
    const out: Outgoing[] = [copyMessage(bot, actor, at, false), { kind: 'toast', to: actor, text: '📦 Собираю бэкап — пришлю файлом' }];
    return { state, out, bumped: new Set() };
  }
  if (action === 'on') {
    if (copy.daily) return toast(bot, actor, 'Ежедневный бэкап и так включён');
    // После 12:00 сегодняшний уже не придёт: первый — завтра. Сейчас — кнопкой «Прислать бэкап».
    const { day, hour } = moscow(at);
    const late = hour >= COPY_HOUR;
    const next: DatabaseCopy = { daily: true, day: late ? day : undefined, changed: true };
    return toast({ ...bot, copy: next }, actor, `⏰ Буду присылать бэкап каждый день в 12:00 МСК, первый — ${late ? 'завтра' : 'сегодня'}`);
  }
  if (action === 'off' || action === 'stop') {
    if (!copy.daily) return toast(bot, actor, 'Ежедневный бэкап и так выключен');
    const text = action === 'stop' ? '🔕 Больше не пришлю. Включить снова — в «🗂 Все турниры»' : '🔕 Ежедневный бэкап выключен';
    return toast({ ...bot, copy: { daily: false } }, actor, text);
  }
  return toast(bot, actor, 'Кнопка устарела');
}

// Ежедневная копия — в 12:00 по Москве или позже, если сегодня её ещё не было: бот был выключен
// в 12:00 — пришлёт после запуска. Если с прошлой копии ничего не изменилось, день отмечается без файла.
function dailyCopy(routed: Routed, at: number): Routed {
  const { copy } = routed.state;
  if (!copy?.daily) return routed;
  const { day, hour } = moscow(at);
  if (hour < COPY_HOUR || copy.day === day) return routed;
  const state: BotState = { ...routed.state, copy: { daily: true, day, changed: false } };
  if (!copy.changed) return { ...routed, state };
  const organizer = activeTournament(state).config.organizerId;
  return { ...routed, state, out: [...routed.out, copyMessage(state, organizer, at, true)] };
}

// Любое изменение в турнирах — повод для следующей ежедневной копии. Экраны списка турниров
// и сама настройка копии не в счёт.
function trackChanges(before: BotState, routed: Routed): Routed {
  const { copy } = routed.state;
  if (!copy?.daily || copy.changed) return routed;
  if (routed.state.tournaments === before.tournaments && routed.state.active === before.active) return routed;
  return { ...routed, state: { ...routed.state, copy: { ...copy, changed: true } } };
}

// Файл собирает Telegram-адаптер при отправке; имя — как у npm run db:backup, его понимает db:restore.
function copyMessage(bot: BotState, to: UserId, at: number, daily: boolean): OutgoingMessage {
  const { day, time, stamp } = moscow(at);
  const active = activeTournament(bot);
  const others = bot.tournaments.length - 1;
  const lines = [
    `📦 Бэкап на ${formatDate(day)}, ${time} МСК`,
    `Активный турнир: «${active.config.title}», ${PHASE_NAME[active.phase]}` +
      (others > 0 ? `; ещё ${others} ${plural(others, 'турнир', 'турнира', 'турниров')} в этом же файле` : ''),
    'Песни — ссылками Telegram, без mp3: восстанавливать в этого же бота.',
    'Как восстановить — docs/operations.md, «Бэкап от бота».',
  ];
  return {
    kind: 'message',
    to,
    text: lines.join('\n'),
    document: { fileName: `tournament-${stamp}.zip`, mimeType: 'application/zip', content: '', databaseCopy: true },
    buttons: daily ? [[{ label: '🔕 Больше не присылать', data: `${LOBBY}copy:stop` }]] : undefined,
  };
}

function moscow(at: number): { day: string; hour: number; time: string; stamp: string } {
  const iso = new Date(at + MSK_OFFSET_MS).toISOString();
  const day = iso.slice(0, 10);
  return { day, hour: Number(iso.slice(11, 13)), time: iso.slice(11, 16), stamp: `${day.replaceAll('-', '')}-${iso.slice(11, 19).replaceAll(':', '')}` };
}

function note(state: TournamentState, line: string): TournamentState {
  return { ...state, journal: [...state.journal, line] };
}

function toast(bot: BotState, to: UserId, text: string): Routed {
  return { state: bot, out: [{ kind: 'toast', to, text }], bumped: new Set() };
}

function say(bot: BotState, to: UserId, text: string): Routed {
  return { state: bot, out: [{ kind: 'message', to, text }], bumped: new Set() };
}
