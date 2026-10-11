import {
  confirmedJudge,
  handleDraw,
  inviteByLink,
  matchLabel,
  matchPlayers,
  openDrawSession,
  qualifiedIds,
  qualifiersDone,
  recordResult,
  registerPerson,
  render as renderDraw,
  type DrawSession,
} from '../bot/drawSession.ts';
import { handleFinal, openFinalSession, renderOrganizer as renderFinalOrganizer, type FinalSession } from '../bot/finalSession.ts';
import {
  admittedPlayers,
  handleIntake,
  joinIntake,
  openIntakeSession,
  readyForDraw,
  render as renderIntake,
  type IntakeSession,
} from '../bot/intakeSession.ts';
import {
  handleIncoming,
  openMatchSession,
  type LibrarySong,
  type MatchSession,
  type Participant,
} from '../bot/matchSession.ts';
import type { Button, Incoming, Outgoing, OutgoingMessage, UserId } from '../bot/protocol.ts';
import { buildQualifierBracket, findMatch, playedMatches, qualified } from '../domain/bracket/bracket.ts';
import { formatPoints, type Ruleset } from '../domain/match/ruleset.ts';
import { acceptedSongs, type IntakeRules } from '../domain/submission/intake.ts';
import type { Sender, StampedEvent, TournamentEvent } from './events.ts';

// Оркестратор турнира (docs/telegram-integration.md, разделы 2, 4, 6): одно состояние на весь
// турнир, этапы сбор → отбор → финал → архив. Чистая функция (состояние, событие) → (состояние,
// сообщения); время приходит в событии, поэтому повтор журнала восстанавливает то же состояние.
//
// Маршрутизация: у каждой кнопки и каждого slot префикс контекста — один человек может быть
// игроком своего матча и судьёй чужого, а организатор — ещё и участником.
//   r: регистрация · i: сбор · o: организатор · d: жеребьёвка и карточки · m:<матч>: матч
//   f: финал · x: споры

// Внутри сессий организатор — отдельный «пользователь»: так его панель не путается с его же
// чатом участника. При отправке подменяется на настоящий Telegram ID.
export const ORG = '@org';

export interface TournamentConfig {
  code: string;
  title: string;
  organizerId: UserId;
  // Могут выполнять команды организатора; панели приходят только организатору.
  adminIds: UserId[];
  botUsername: string;
  finalists: number;
  seed: number;
  // Срок круга отбора в днях от жеребьёвки.
  roundDays: number;
  intakeRules: IntakeRules;
  finalPoolTarget: number;
  qualifierRuleset: Ruleset;
  finalRuleset: Ruleset;
}

export type Phase = 'intake' | 'qualifiers' | 'final' | 'archive';

export interface Person {
  id: UserId;
  name: string;
  username?: string;
  // Номер внутри турнира — по нему организатор указывает игрока в командах.
  number: number;
  registeredAt: number;
}

interface PendingRegistration {
  step: 'name' | 'rules';
  name?: string;
  suggested: string;
  username?: string;
  // Что открыть после регистрации: приглашение судьи и т. п.
  payload?: string;
}

export interface MatchRuntime {
  session: MatchSession;
  // Номер переигровки: входит в slot, чтобы новый матч не правил сообщения старого.
  attempt: number;
  trackStartedAt?: number;
  trackReminded: boolean;
  decidedAt?: number;
  confirmEscalated: boolean;
  dispute?: { by: UserId; at: number };
  // Результат внесён в сетку или матч снят организатором.
  closed: boolean;
}

export interface TournamentState {
  config: TournamentConfig;
  phase: Phase;
  people: Record<UserId, Person>;
  nextNumber: number;
  registration: Record<UserId, PendingRegistration>;
  intake: IntakeSession;
  // submissionId → file_id обезличенной игровой версии.
  gameAudio: Record<string, string>;
  draw: DrawSession | null;
  matches: Record<string, MatchRuntime>;
  // Кто с какой песней познакомился в матчах: судья — при выдаче, игроки — при старте трека.
  known: Record<UserId, string[]>;
  // Круг → срок, о котором уже напомнили; перенос срока даёт новое напоминание.
  remindedDeadlines: Record<number, string>;
  overdueReported: Record<number, string>;
  finalJudge: Participant | null;
  final: FinalSession | null;
  journal: string[];
}

export interface Step {
  state: TournamentState;
  out: Outgoing[];
}

const TRACK_REMINDER_MS = 60_000;
const CONFIRM_ESCALATION_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export function createTournament(config: TournamentConfig): Step {
  const opened = openIntakeSession({
    participants: [],
    background: [],
    organizer: { id: ORG, name: 'Организатор' },
    rules: config.intakeRules,
    finalPoolTarget: config.finalPoolTarget,
    finalists: config.finalists,
    seed: config.seed,
  });
  const state: TournamentState = {
    config,
    phase: 'intake',
    people: {},
    nextNumber: 1,
    registration: {},
    intake: opened.session,
    gameAudio: {},
    draw: null,
    matches: {},
    known: {},
    remindedDeadlines: {},
    overdueReported: {},
    finalJudge: null,
    final: null,
    journal: [],
  };
  return { state, out: [...scope(state, opened.out, 'i:'), ...renderExtras(state)] };
}

export function handleEvent(state: TournamentState, { at, event }: StampedEvent): Step {
  const before = renderExtras(state);
  const step = dispatch(state, event, at);
  const synced = syncMatches(step.state, at);
  const after = renderExtras(synced.state);
  return { state: synced.state, out: [...step.out, ...synced.out, ...diff(before, after)] };
}

function dispatch(state: TournamentState, event: TournamentEvent, at: number): Step {
  switch (event.kind) {
    case 'command':
      return handleCommand(state, event.from, event.command, event.payload, at);
    case 'text':
      return handleText(state, event.from, event.text, at);
    case 'files':
      if (state.phase === 'intake' && isParticipant(state, event.from.id)) {
        return intakeStep(state, { kind: 'files', from: event.from.id, files: event.files });
      }
      return say(state, event.from.id, 'Сейчас песни не принимаются.');
    case 'worker': {
      const gameAudio = { ...state.gameAudio };
      for (const r of event.results) if (r.ok && r.gameFileId) gameAudio[r.submissionId] = r.gameFileId;
      return intakeStep({ ...state, gameAudio }, { kind: 'worker', results: event.results });
    }
    case 'button':
      return handleButton(state, event.from, event.data, at);
    case 'tick':
      return tick(state, at);
  }
}

// --- Команды и регистрация -------------------------------------------------------

function handleCommand(state: TournamentState, from: Sender, command: string, payload: string, at: number): Step {
  if (command === 'start') return handleStart(state, from, payload, at);
  if (command === 'help') return say(state, from.id, helpText(state, from.id));
  if (command === 'panel' && isOrganizer(state, from.id)) return resendPanels(state);
  if (command === 'status') return say(state, from.id, statusText(state, from.id));
  if (command === 'tech' && canAdmin(state, from.id)) return technicalResult(state, from.id, payload);
  if (command === 'broadcast' && canAdmin(state, from.id)) return broadcast(state, from.id, payload);
  return say(state, from.id, 'Не знаю такой команды. /help — что я умею.');
}

function handleStart(state: TournamentState, from: Sender, payload: string, at: number): Step {
  const registered = state.people[from.id];
  const invite = payload === `t_${state.config.code}`;
  const judgeLink = /^judge_(r\d+-\d+)$/.exec(payload);
  const finalJudgeLink = payload === `fjudge_${state.config.code}`;

  if (!registered) {
    if (invite || judgeLink || finalJudgeLink) return startRegistration(state, from, invite ? undefined : payload);
    if (isOrganizer(state, from.id)) return resendPanels(state);
    return say(state, from.id, 'Это бот музыкального турнира. Чтобы участвовать, открой ссылку-приглашение от организатора.');
  }
  if (judgeLink) return judgeInvite(state, from.id, judgeLink[1]!);
  if (finalJudgeLink) return assignFinalJudge(state, from.id, at);
  const panels = isOrganizer(state, from.id) ? resendPanels(state).out : [];
  return { state, out: [message(from.id, `Ты в турнире: №${registered.number}, ${registered.name}.\n/help — что я умею.`), ...panels] };
}

function startRegistration(state: TournamentState, from: Sender, payload?: string): Step {
  const pending: PendingRegistration = { step: 'name', suggested: from.name, username: from.username, payload };
  const next = { ...state, registration: { ...state.registration, [from.id]: pending } };
  return { state: next, out: [registrationMessage(state, from.id, pending)] };
}

function registrationMessage(state: TournamentState, to: UserId, pending: PendingRegistration, bump = false): OutgoingMessage {
  if (pending.step === 'name') {
    return {
      kind: 'message',
      to,
      slot: 'r:reg',
      bump,
      text: [
        `Привет! Это бот турнира «${state.config.title}».`,
        '',
        'Как тебя записать? Это имя увидят соперники и судьи. Пришли его одним сообщением или возьми имя из Telegram.',
      ].join('\n'),
      buttons: [[{ label: `👤 ${pending.suggested}`, data: 'r:name' }]],
    };
  }
  return {
    kind: 'message',
    to,
    slot: 'r:reg',
    bump,
    text: [
      `Имя: ${pending.name}`,
      '',
      'Правила коротко:',
      '• Отбор — очные матчи один на один, судья включает трек со своего телефона.',
      '• Исполнитель — 0,9 балла, название — 1,2. Свои песни тебе не выпадут.',
      '• Результат подтверждают судья и оба игрока; спор решает организатор.',
      '• Судить можно чужие матчи; песни, которые услышишь как судья, тебе потом не выпадут.',
      '',
      'Telegram ID используется только внутри турнира.',
    ].join('\n'),
    buttons: [
      [{ label: '✅ Принимаю правила', data: 'r:accept' }],
      [{ label: '✏️ Другое имя', data: 'r:rename' }],
    ],
  };
}

function registrationButton(state: TournamentState, from: Sender, data: string, at: number): Step {
  const pending = state.registration[from.id];
  if (!pending) return toast(state, from.id, 'Регистрация уже завершена');
  const setPending = (p: PendingRegistration): Step => ({
    state: { ...state, registration: { ...state.registration, [from.id]: p } },
    out: [registrationMessage(state, from.id, p)],
  });
  if (data === 'name' && pending.step === 'name') return setPending({ ...pending, step: 'rules', name: pending.suggested });
  if (data === 'rename') return setPending({ ...pending, step: 'name' });
  if (data === 'accept' && pending.step === 'rules') return register(state, from, pending, at);
  return toast(state, from.id, 'Сейчас это действие недоступно');
}

function registrationText(state: TournamentState, from: Sender, text: string): Step {
  const pending = state.registration[from.id]!;
  const name = text.trim().replace(/\s+/g, ' ');
  if (pending.step !== 'name') return { state, out: [registrationMessage(state, from.id, pending, true)] };
  if (name.length < 2 || name.length > 32 || name.startsWith('/')) {
    return say(state, from.id, 'Имя должно быть от 2 до 32 символов. Пришли ещё раз.');
  }
  const next: PendingRegistration = { ...pending, step: 'rules', name };
  return {
    state: { ...state, registration: { ...state.registration, [from.id]: next } },
    out: [registrationMessage(state, from.id, next, true)],
  };
}

function register(state: TournamentState, from: Sender, pending: PendingRegistration, at: number): Step {
  const person: Person = {
    id: from.id,
    name: pending.name!,
    username: pending.username,
    number: state.nextNumber,
    registeredAt: at,
  };
  const { [from.id]: _, ...registration } = state.registration;
  let next: TournamentState = {
    ...state,
    people: { ...state.people, [person.id]: person },
    nextNumber: state.nextNumber + 1,
    registration,
    journal: [...state.journal, `Регистрация: №${person.number} ${person.name}`],
  };
  const out: Outgoing[] = [
    {
      kind: 'message',
      to: person.id,
      slot: 'r:reg',
      text: `✅ Ты в турнире «${state.config.title}»: №${person.number}, ${person.name}.`,
    },
  ];

  if (next.phase === 'intake' && !next.intake.closed && !pending.payload) {
    const joined = joinIntake(next.intake, { id: person.id, name: person.name });
    next = { ...next, intake: joined.session };
    out.push(...scope(next, joined.out, 'i:'));
  } else {
    if (next.draw) {
      const added = registerPerson(next.draw, { id: person.id, name: person.name }, person.username);
      next = { ...next, draw: added.session };
      out.push(...scope(next, added.out, 'd:'));
    }
    if (!pending.payload) out.push(message(person.id, 'Сбор песен уже закрыт, поэтому сыграть не получится, но тебя могут позвать судить матчи.'));
  }

  if (pending.payload) {
    const judge = /^judge_(r\d+-\d+)$/.exec(pending.payload);
    const step = judge ? judgeInvite(next, person.id, judge[1]!) : assignFinalJudge(next, person.id, at);
    return { state: step.state, out: [...out, ...step.out] };
  }
  return { state: next, out };
}

function judgeInvite(state: TournamentState, userId: UserId, matchId: string): Step {
  if (!state.draw?.bracket) return say(state, userId, 'Это приглашение пока неактуально: жеребьёвки ещё не было.');
  const step = inviteByLink(state.draw, matchId, userId);
  return { state: { ...state, draw: step.session }, out: scope(state, step.out, 'd:') };
}

function assignFinalJudge(state: TournamentState, userId: UserId, at: number): Step {
  if (state.phase !== 'final' || state.final) return say(state, userId, 'Назначить судью финала сейчас нельзя.');
  if (finalistIds(state).includes(userId)) return say(state, userId, 'Финалист не может судить финал.');
  const person = state.people[userId]!;
  const next = {
    ...state,
    finalJudge: { id: person.id, name: person.name },
    journal: [...state.journal, `Судья финала: ${person.name} (${new Date(at).toISOString().slice(0, 10)})`],
  };
  return say(next, userId, '⚖️ Ты судья финала. Панель судьи придёт, когда организатор откроет финал.');
}

// --- Текст и кнопки --------------------------------------------------------------

function handleText(state: TournamentState, from: Sender, text: string, at: number): Step {
  if (state.registration[from.id]) return registrationText(state, from, text);
  if (state.phase === 'intake' && isParticipant(state, from.id)) {
    return intakeStep(state, { kind: 'text', from: from.id, text });
  }
  if (!state.people[from.id] && !isOrganizer(state, from.id)) {
    return say(state, from.id, 'Чтобы участвовать, открой ссылку-приглашение от организатора.');
  }
  void at;
  return { state, out: [] };
}

function handleButton(state: TournamentState, from: Sender, data: string, at: number): Step {
  const colon = data.indexOf(':');
  const prefix = colon === -1 ? data : data.slice(0, colon);
  const rest = colon === -1 ? '' : data.slice(colon + 1);

  switch (prefix) {
    case 'r':
      return registrationButton(state, from, rest, at);
    case 'i':
      if (state.phase !== 'intake') return toast(state, from.id, 'Сбор уже закрыт');
      return intakeStep(state, { kind: 'button', from: from.id, data: rest });
    case 'o':
      if (!isOrganizer(state, from.id)) return toast(state, from.id, 'Это действие доступно только организатору');
      return organizerButton(state, rest, at);
    case 'd': {
      if (!state.draw) return toast(state, from.id, 'Жеребьёвки ещё не было');
      const step = handleDraw(state.draw, { kind: 'button', from: from.id, data: rest });
      return { state: { ...state, draw: step.session }, out: scope(state, step.out, 'd:') };
    }
    case 'm': {
      const separator = rest.indexOf(':');
      const matchId = rest.slice(0, separator);
      return matchStep(state, matchId, { kind: 'button', from: from.id, data: rest.slice(separator + 1) }, at);
    }
    case 'f': {
      if (!state.final) return toast(state, from.id, 'Финал ещё не начался');
      const step = handleFinal(state.final, { kind: 'button', from: from.id, data: rest });
      return { state: { ...state, final: step.session }, out: scope(state, step.out, 'f:') };
    }
    case 'x': {
      const dispute = /^dispute:(.+)$/.exec(rest);
      if (dispute) return openDispute(state, from.id, dispute[1]!, at);
      return toast(state, from.id, 'Кнопка устарела');
    }
    default:
      return toast(state, from.id, 'Кнопка устарела');
  }
}

function organizerButton(state: TournamentState, data: string, at: number): Step {
  const organizer = state.config.organizerId;
  if (data === 'toDraw') return openDraw(state, at);
  if (data === 'toFinal') {
    if (state.phase !== 'qualifiers' || !state.draw || !qualifiersDone(state.draw)) return toast(state, organizer, 'Отбор ещё не закончен');
    const finalists = finalistIds(state);
    const out = finalists.map((id) => message(id, '🏆 Ты в финале! Организатор сообщит дату и место.'));
    return { state: { ...state, phase: 'final', journal: [...state.journal, 'Отбор завершён, финалисты определены'] }, out };
  }
  if (data === 'openFinal') return openFinal(state);
  if (data === 'archive') return archive(state);
  const decision = /^(keep|replay):(.+)$/.exec(data);
  if (decision) return decision[1] === 'keep' ? keepResult(state, decision[2]!) : replayMatch(state, decision[2]!);

  const input: Incoming = { kind: 'button', from: ORG, data };
  if (state.phase === 'intake') return intakeStep(state, input);
  if (state.phase === 'qualifiers' && state.draw) {
    const step = handleDraw(state.draw, input);
    return { state: { ...state, draw: step.session }, out: scope(state, step.out, 'd:') };
  }
  if (state.phase === 'final' && state.final) {
    const step = handleFinal(state.final, input);
    return { state: { ...state, final: step.session }, out: scope(state, step.out, 'f:') };
  }
  return toast(state, organizer, 'Сейчас это действие недоступно');
}

function intakeStep(state: TournamentState, input: Incoming): Step {
  const step = handleIntake(state.intake, input);
  return { state: { ...state, intake: step.session }, out: scope(state, step.out, 'i:') };
}

// --- Переходы этапов ---------------------------------------------------------------

function openDraw(state: TournamentState, at: number): Step {
  const { config } = state;
  if (state.phase !== 'intake' || !readyForDraw(state.intake)) {
    return toast(state, config.organizerId, 'Сначала закройте сбор и решите по недобравшим');
  }
  const players = admittedPlayers(state.intake);
  if (players.length < config.finalists) {
    return toast(state, config.organizerId, `Игроков ${players.length}, а финалистов должно быть ${config.finalists}`);
  }
  const rounds = buildQualifierBracket(
    players.map((p) => p.id),
    config.finalists,
    config.seed,
  ).rounds.length;
  const deadlines = Array.from({ length: rounds }, (_, i) => isoDate(at + (i + 1) * config.roundDays * DAY_MS));
  const people = Object.values(state.people);
  const opened = openDrawSession({
    players,
    registered: people.map((p) => ({ id: p.id, name: p.name })),
    usernames: Object.fromEntries(people.filter((p) => p.username).map((p) => [p.id, `@${p.username}`])),
    organizer: { id: ORG, name: 'Организатор' },
    finalists: config.finalists,
    seed: config.seed,
    deadlines,
    botUsername: config.botUsername,
  });
  const next: TournamentState = {
    ...state,
    phase: 'qualifiers',
    draw: opened.session,
    journal: [...state.journal, `Сбор закрыт: ${players.length} игроков допущено`],
  };
  return { state: next, out: scope(next, opened.out, 'd:') };
}

function openFinal(state: TournamentState): Step {
  const organizer = state.config.organizerId;
  if (state.phase !== 'final' || state.final) return toast(state, organizer, 'Финал уже открыт');
  if (!state.finalJudge) return toast(state, organizer, 'Сначала назначьте судью финала');
  const split = state.intake.closed!.split;
  const opened = openFinalSession({
    finalists: finalistIds(state).map((id) => participant(state, id)),
    judge: state.finalJudge,
    organizer: { id: ORG, name: 'Организатор' },
    library: libraryOf(state, split.final),
    ruleset: state.config.finalRuleset,
    seed: state.config.seed + 7,
  });
  const next = { ...state, final: opened.session, journal: [...state.journal, 'Финал открыт'] };
  return { state: next, out: scope(next, opened.out, 'f:') };
}

function archive(state: TournamentState): Step {
  const champion = state.final && qualified(state.final.bracket, state.final.results)[0];
  if (!champion) return toast(state, state.config.organizerId, 'Финал ещё не сыгран');
  const name = participant(state, champion).name;
  const next: TournamentState = { ...state, phase: 'archive', journal: [...state.journal, `Турнир завершён, победитель ${name}`] };
  const out = Object.keys(state.people).map((id) => message(id, `🏁 Турнир «${state.config.title}» завершён. Победитель — ${name}! Спасибо за игру.`));
  return { state: next, out };
}

export function finalistIds(state: TournamentState): UserId[] {
  const draw = state.draw;
  if (!draw?.bracket) return [];
  // Игроков не больше числа финалистов — отбор не нужен, в финал проходят все.
  if (draw.bracket.rounds.length === 0) return draw.config.players.map((p) => p.id);
  return qualifiedIds(draw);
}

// Песни пула для матча: id — музыкальная идентичность, авторы — все, кто её присылал.
function libraryOf(state: TournamentState, keys: readonly string[]): LibrarySong[] {
  const songs = new Map(acceptedSongs(state.intake.intake).map((s) => [s.key, s]));
  return keys.flatMap((key) => {
    const song = songs.get(key);
    if (!song) return [];
    const audioFileId = song.submissionIds.map((id) => state.gameAudio[id]).find(Boolean);
    return [{ id: key, artist: song.meta.artist, title: song.meta.title, ownerIds: song.knownBy, audioFileId }];
  });
}

// --- Отборочные матчи ------------------------------------------------------------

// Открывает матчи, у которых определились оба игрока и подтверждён судья.
function syncMatches(state: TournamentState, at: number): Step {
  const draw = state.draw;
  if (state.phase !== 'qualifiers' || !draw?.bracket) return { state, out: [] };
  let next = state;
  const out: Outgoing[] = [];
  playedMatches(draw.bracket).forEach((match, index) => {
    if (next.matches[match.id] || draw.results[match.id]) return;
    const judge = confirmedJudge(draw, match.id);
    const players = matchPlayers(draw, match.id);
    if (!judge || !players) return;
    const opened = openMatch(next, match.id, index + 1, players, judge, 0);
    next = opened.state;
    out.push(...opened.out);
  });
  void at;
  return { state: next, out };
}

function openMatch(
  state: TournamentState,
  matchId: string,
  matchNo: number,
  players: [UserId, UserId],
  judge: UserId,
  attempt: number,
): Step {
  const opened = openMatchSession({
    stage: 'qualifier',
    matchNo,
    players: [participant(state, players[0]), participant(state, players[1])],
    judge: participant(state, judge),
    library: libraryOf(state, state.intake.closed!.split.main),
    ruleset: state.config.qualifierRuleset,
    seed: state.config.seed + hash(matchId) * 31 + attempt,
    knownByPlayers: knownBy(state, players),
  });
  const runtime: MatchRuntime = { session: opened.session, attempt, trackReminded: false, confirmEscalated: false, closed: false };
  const next = {
    ...state,
    matches: { ...state.matches, [matchId]: runtime },
    journal: [...state.journal, `Матч ${matchTitle(state, matchId)} открыт${attempt ? ` (переигровка ${attempt})` : ''}`],
  };
  return { state: next, out: scopeMatch(next, matchId, attempt, opened.out) };
}

function matchStep(state: TournamentState, matchId: string, input: Incoming, at: number): Step {
  const runtime = state.matches[matchId];
  const from = input.kind === 'worker' ? '' : input.from;
  if (!runtime || runtime.closed) return toast(state, from, 'Этот матч уже завершён');

  // Знакомство могло пополниться, пока матч шёл: судья этого матча судил чужой и т. п.
  const config = runtime.session.config;
  const session = { ...runtime.session, config: { ...config, knownByPlayers: knownBy(state, [config.players[0].id, config.players[1].id]) } };
  const step = handleIncoming(session, input);
  const updated = trackTimers(runtime, step.session, at);
  let next: TournamentState = {
    ...state,
    matches: { ...state.matches, [matchId]: updated },
    known: expose(state.known, step.session),
  };
  const out = scopeMatch(next, matchId, runtime.attempt, step.out);

  const { phase } = step.session.match;
  if (phase.kind === 'finished' && !updated.dispute) {
    const finished = closeWithResult(next, matchId, step.session.config.players[phase.winner].id);
    return { state: finished.state, out: [...out, ...finished.out] };
  }
  return { state: next, out };
}

function trackTimers(runtime: MatchRuntime, session: MatchSession, at: number): MatchRuntime {
  const before = runtime.session.match.phase;
  const after = session.match.phase;
  let next: MatchRuntime = { ...runtime, session };
  const startedBefore = before.kind === 'track' && before.track.started;
  if (after.kind === 'track' && after.track.started && !startedBefore) next = { ...next, trackStartedAt: at, trackReminded: false };
  if (after.kind !== 'track') next = { ...next, trackStartedAt: undefined };
  if (after.kind === 'decided' && before.kind !== 'decided') next = { ...next, decidedAt: at, confirmEscalated: false };
  return next;
}

function expose(known: Record<UserId, string[]>, session: MatchSession): Record<UserId, string[]> {
  const { match, config, issued } = session;
  const started = [...match.closedTracks.map((t) => t.songId), ...match.cancelledTracks.map((t) => t.songId)];
  if (match.phase.kind === 'track' && match.phase.track.started) started.push(match.phase.track.songId);
  const add = (map: Record<UserId, string[]>, userId: UserId, songs: string[]) => {
    const current = map[userId] ?? [];
    const merged = [...new Set([...current, ...songs])];
    return merged.length === current.length ? map : { ...map, [userId]: merged };
  };
  let next = add(known, config.judge.id, issued.map((t) => t.songId));
  for (const player of config.players) next = add(next, player.id, started);
  return next;
}

function knownBy(state: TournamentState, userIds: readonly UserId[]): string[] {
  return [...new Set(userIds.flatMap((id) => state.known[id] ?? []))];
}

function closeWithResult(state: TournamentState, matchId: string, winner: UserId, note?: string): Step {
  const draw = state.draw!;
  const runtime = state.matches[matchId];
  const recorded = recordResult(draw, matchId, winner, note);
  const matches = runtime ? { ...state.matches, [matchId]: { ...runtime, closed: true } } : state.matches;
  const next = { ...state, draw: recorded.session, matches };
  return { state: next, out: scope(next, recorded.out, 'd:') };
}

// --- Споры, переигровки, технические результаты ------------------------------------

function openDispute(state: TournamentState, from: UserId, matchId: string, at: number): Step {
  const runtime = state.matches[matchId];
  if (!runtime || runtime.closed || runtime.dispute) return toast(state, from, 'Спорить уже не о чем');
  const { phase } = runtime.session.match;
  const slot = runtime.session.config.players.findIndex((p) => p.id === from);
  if (slot === -1) return toast(state, from, 'Это не твой матч');
  if (phase.kind !== 'decided' || phase.playersConfirmed[slot]) return toast(state, from, 'Результат уже подтверждён');
  const next = {
    ...state,
    matches: { ...state.matches, [matchId]: { ...runtime, dispute: { by: from, at } } },
    journal: [...state.journal, `Спор: ${participant(state, from).name}, матч ${matchTitle(state, matchId)}`],
  };
  return toast(next, from, 'Спор передан организатору');
}

function keepResult(state: TournamentState, matchId: string): Step {
  const runtime = state.matches[matchId];
  const organizer = state.config.organizerId;
  if (!runtime || runtime.closed) return toast(state, organizer, 'Матч уже закрыт');
  const { phase } = runtime.session.match;
  if (phase.kind !== 'decided' && phase.kind !== 'finished') return toast(state, organizer, 'Победитель ещё не определён');
  const winner = runtime.session.config.players[phase.winner].id;
  const resolved = { ...state, journal: [...state.journal, `Организатор: результат ${matchTitle(state, matchId)} оставлен`] };
  return closeWithResult(resolved, matchId, winner, 'решение организатора');
}

function replayMatch(state: TournamentState, matchId: string): Step {
  const runtime = state.matches[matchId];
  const organizer = state.config.organizerId;
  if (!runtime || runtime.closed) return toast(state, organizer, 'Матч уже закрыт');
  const { config } = runtime.session;
  const closed = { ...state, matches: { ...state.matches, [matchId]: { ...runtime, closed: true } } };
  const notices = [config.judge, ...config.players].map((p) =>
    message(p.id, `🔁 Организатор назначил переигровку матча №${config.matchNo}. Новая панель — ниже; уже прозвучавшие песни не повторятся.`),
  );
  const reopened = openMatch(closed, matchId, config.matchNo, [config.players[0].id, config.players[1].id], config.judge.id, runtime.attempt + 1);
  return { state: reopened.state, out: [...notices, ...reopened.out] };
}

// /tech 1.3 <номер игрока> <причина> — неявка, снятие: технический результат без статистики.
function technicalResult(state: TournamentState, from: UserId, payload: string): Step {
  const parsed = /^(\d+)\.(\d+)\s+(\d+)\s*(.*)$/s.exec(payload.trim());
  if (!parsed || !state.draw?.bracket) {
    return say(state, from, 'Формат: /tech <матч, напр. 1.3> <номер победителя> <причина>');
  }
  const matchId = `r${parsed[1]}-${parsed[2]}`;
  const winner = Object.values(state.people).find((p) => p.number === Number(parsed[3]));
  const players = matchPlayers(state.draw, matchId);
  if (!players || !winner || !players.includes(winner.id) || state.draw.results[matchId]) {
    return say(state, from, 'Не нашёл такой открытый матч с этим игроком.');
  }
  const reason = parsed[4]!.trim() || 'без причины';
  const note = `технический результат: ${reason}`;
  const runtime = state.matches[matchId];
  const people = runtime ? [runtime.session.config.judge.id, ...players] : players;
  const closed = closeWithResult(
    { ...state, journal: [...state.journal, `Организатор: ${matchTitle(state, matchId)} — ${note}`] },
    matchId,
    winner.id,
    note,
  );
  const notices = people.map((id) => message(id, `Матч ${matchTitle(state, matchId)} закрыт организатором: ${note}. Проходит ${winner.name}.`));
  return { state: closed.state, out: [...closed.out, ...notices, message(from, 'Готово.')] };
}

function broadcast(state: TournamentState, from: UserId, text: string): Step {
  if (!text.trim()) return say(state, from, 'Формат: /broadcast <текст>');
  const out = Object.keys(state.people).map((id) => message(id, `📣 ${text.trim()}`));
  return { state, out: [...out, message(from, `Отправлено: ${out.length}`)] };
}

// --- Напоминания ------------------------------------------------------------------

function tick(state: TournamentState, at: number): Step {
  let next = state;
  const out: Outgoing[] = [];

  for (const [matchId, runtime] of Object.entries(state.matches)) {
    if (runtime.closed) continue;
    const { phase } = runtime.session.match;
    const { config } = runtime.session;
    let updated = runtime;
    if (phase.kind === 'track' && runtime.trackStartedAt !== undefined && !runtime.trackReminded && at - runtime.trackStartedAt >= TRACK_REMINDER_MS) {
      out.push(message(config.judge.id, `⏱ Трек идёт больше минуты — отметьте угаданное и закройте трек (матч №${config.matchNo}).`));
      updated = { ...updated, trackReminded: true };
    }
    if (phase.kind === 'decided' && runtime.decidedAt !== undefined && !runtime.confirmEscalated && at - runtime.decidedAt >= CONFIRM_ESCALATION_MS) {
      const pending = [
        !phase.judgeConfirmed && config.judge.id,
        !phase.playersConfirmed[0] && config.players[0].id,
        !phase.playersConfirmed[1] && config.players[1].id,
      ].filter((id): id is string => Boolean(id));
      for (const id of pending) out.push(message(id, `⏳ Подтвердите результат матча №${config.matchNo} — кнопка в сообщении матча выше.`));
      updated = { ...updated, confirmEscalated: true };
      next = { ...next, journal: [...next.journal, `Матч ${matchTitle(state, matchId)}: результат не подтверждён 10 минут, передано организатору`] };
    }
    if (updated !== runtime) next = { ...next, matches: { ...next.matches, [matchId]: updated } };
  }

  const draw = next.draw;
  if (next.phase === 'qualifiers' && draw?.bracket) {
    draw.deadlines.forEach((iso, index) => {
      const round = index + 1;
      const deadline = deadlineMoment(iso);
      const open = draw.bracket!.rounds[index]!.filter((m) => !m.isBye && !draw.results[m.id]);
      if (open.length === 0) return;
      if (at >= deadline - DAY_MS && at < deadline && next.remindedDeadlines[round] !== iso) {
        for (const match of open) {
          const players = matchPlayers(draw, match.id) ?? [];
          const judge = confirmedJudge(draw, match.id);
          for (const id of [...players, ...(judge ? [judge] : [])]) {
            out.push(message(id, `📅 Завтра последний день для матча ${matchLabel(match)}. Если не успеваете — напишите организатору.`));
          }
        }
        next = { ...next, remindedDeadlines: { ...next.remindedDeadlines, [round]: iso } };
      }
      if (at >= deadline && next.overdueReported[round] !== iso) {
        const list = open.map((m) => `• ${matchTitle(next, m.id)}`).join('\n');
        out.push(
          message(
            next.config.organizerId,
            `⌛ Срок ${round}-го круга истёк. Без результата:\n${list}\n\nПеренесите срок кнопкой в панели или оформите неявку: /tech <матч> <номер победителя> <причина>.`,
          ),
        );
        next = { ...next, overdueReported: { ...next.overdueReported, [round]: iso } };
      }
    });
  }
  return { state: next, out };
}

// Срок «до 15 октября» включительно: конец дня по Москве и Тбилиси (UTC+3/+4) — 21:00 UTC.
function deadlineMoment(iso: string): number {
  return Date.parse(`${iso}T21:00:00Z`);
}

// --- Рендер служебных сообщений --------------------------------------------------

// Сообщения, которые рисует сам оркестратор: панель этапа у организатора, споры.
// Отправляются только изменившиеся.
function renderExtras(state: TournamentState): OutgoingMessage[] {
  const out: OutgoingMessage[] = [phasePanel(state)];
  for (const [matchId, runtime] of Object.entries(state.matches)) {
    if (runtime.decidedAt === undefined) continue;
    const { config, match } = runtime.session;
    const { phase } = match;
    config.players.forEach((player, slot) => {
      const confirmed = (phase.kind === 'decided' && phase.playersConfirmed[slot]) || phase.kind === 'finished';
      let text: string;
      let buttons: Button[][] | undefined;
      if (runtime.dispute) text = runtime.dispute.by === player.id ? '⚠️ Спор передан организатору.' : '⚠️ Соперник оспорил результат — решает организатор.';
      else if (runtime.closed || confirmed) text = `Матч №${config.matchNo}: результат зафиксирован.`;
      else {
        text = `Не согласен с результатом матча №${config.matchNo}? Организатор разберётся.`;
        buttons = [[{ label: '⚠️ Оспорить', data: `x:dispute:${matchId}` }]];
      }
      out.push({ kind: 'message', to: player.id, slot: `x:${matchId}#${runtime.attempt}`, text, buttons });
    });
    if (runtime.dispute || runtime.confirmEscalated) out.push(issuePanel(state, matchId, runtime));
  }
  return out;
}

function issuePanel(state: TournamentState, matchId: string, runtime: MatchRuntime): OutgoingMessage {
  const { config, match } = runtime.session;
  const { phase } = match;
  const title = matchTitle(state, matchId);
  const score = scoreLine(runtime);
  const lines = [runtime.dispute ? `⚠️ Спор по матчу ${title}` : `⏳ Результат матча ${title} не подтверждён 10 минут`, score];
  if (runtime.dispute) lines.push(`Оспорил: ${participant(state, runtime.dispute.by).name}. Судья: ${config.judge.name}.`);
  let buttons: Button[][] | undefined;
  if (runtime.closed) lines.push('', '✅ Решено.');
  else if (phase.kind === 'decided' || phase.kind === 'finished') {
    lines.push('', `По протоколу побеждает ${config.players[phase.winner].name}.`);
    buttons = [
      [{ label: '✅ Оставить результат', data: `o:keep:${matchId}` }],
      [{ label: '🔁 Переиграть матч', data: `o:replay:${matchId}` }],
    ];
  }
  return { kind: 'message', to: state.config.organizerId, slot: `o:issue:${matchId}#${runtime.attempt}`, text: lines.join('\n'), buttons };
}

function phasePanel(state: TournamentState): OutgoingMessage {
  const { config } = state;
  const people = Object.values(state.people);
  const lines = [`📣 ${config.title}`, ''];
  const buttons: Button[][] = [];
  switch (state.phase) {
    case 'intake': {
      lines.push(
        'Этап: регистрация и сбор песен',
        `Ссылка-приглашение: https://t.me/${config.botUsername}?start=t_${config.code}`,
        `Зарегистрировано: ${people.length}`,
      );
      if (readyForDraw(state.intake)) {
        lines.push('', `Допущено к жеребьёвке: ${admittedPlayers(state.intake).length}, финалистов: ${config.finalists}`);
        buttons.push([{ label: '🎲 К жеребьёвке', data: 'o:toDraw' }]);
      }
      break;
    }
    case 'qualifiers': {
      const draw = state.draw!;
      const total = draw.bracket ? playedMatches(draw.bracket).length : 0;
      const played = Object.keys(draw.results).length;
      lines.push('Этап: отбор', draw.bracket ? `Сыграно матчей: ${played} из ${total}` : 'Жеребьёвка ещё не проведена');
      const live = Object.entries(state.matches).filter(([, m]) => !m.closed);
      for (const [matchId, runtime] of live) lines.push(`🎤 ${matchTitle(state, matchId)} · ${scoreLine(runtime)}`);
      lines.push('', 'Команды: /tech — технический результат, /broadcast — сообщение всем.');
      if (draw.bracket && qualifiersDone(draw)) buttons.push([{ label: '🏆 Отбор завершён — к финалу', data: 'o:toFinal' }]);
      break;
    }
    case 'final': {
      lines.push('Этап: финал', `Финалисты: ${finalistIds(state).map((id) => participant(state, id).name).join(', ')}`);
      if (!state.final) {
        lines.push(
          state.finalJudge
            ? `Судья финала: ${state.finalJudge.name}`
            : `Судья финала не назначен. Отправьте ему ссылку: https://t.me/${config.botUsername}?start=fjudge_${config.code}`,
        );
        if (state.finalJudge) buttons.push([{ label: '▶️ Открыть финал', data: 'o:openFinal' }]);
      } else if (qualified(state.final.bracket, state.final.results)[0]) {
        buttons.push([{ label: '🏁 Завершить турнир', data: 'o:archive' }]);
      }
      break;
    }
    case 'archive':
      lines.push('🏁 Турнир завершён.');
      break;
  }
  return { kind: 'message', to: config.organizerId, slot: 'o:phase', text: lines.join('\n'), buttons: buttons.length ? buttons : undefined };
}

// Организатор потерял панели в ленте — присылаем их заново внизу.
function resendPanels(state: TournamentState): Step {
  const own = (messages: OutgoingMessage[], prefix: string) => scope(state, messages.filter((m) => m.to === ORG), prefix);
  let panels: Outgoing[] = [];
  if (state.phase === 'intake') panels = own(renderIntake(state.intake), 'i:');
  else if (state.phase === 'qualifiers' && state.draw) panels = own(renderDraw(state.draw), 'd:');
  else if (state.phase === 'final' && state.final) panels = scope(state, [renderFinalOrganizer(state.final)], 'f:');
  const all = [...panels, phasePanel(state)].map((m) => (m.kind === 'message' ? { ...m, bump: true } : m));
  return { state, out: all };
}

function diff(before: OutgoingMessage[], after: OutgoingMessage[]): OutgoingMessage[] {
  const previous = new Map(before.map((m) => [`${m.to}/${m.slot}`, JSON.stringify(m)]));
  return after.filter((m) => previous.get(`${m.to}/${m.slot}`) !== JSON.stringify(m));
}

// --- Помощники --------------------------------------------------------------------

// Префикс контекста для slot и callback_data; сообщения организатора уходят ему с префиксом o:.
function scope(state: TournamentState, out: readonly Outgoing[], prefix: string, slotPrefix = prefix): Outgoing[] {
  return out.map((o) => {
    const toOrganizer = o.to === ORG;
    const to = toOrganizer ? state.config.organizerId : o.to;
    if (o.kind === 'toast') return { ...o, to };
    const buttonPrefix = toOrganizer ? 'o:' : prefix;
    const slotScope = toOrganizer ? 'o:' : slotPrefix;
    return {
      ...o,
      to,
      slot: o.slot === undefined ? undefined : `${slotScope}${o.slot}`,
      buttons: o.buttons?.map((row) => row.map((b) => ({ ...b, data: `${buttonPrefix}${b.data}` }))),
    };
  });
}

function scopeMatch(state: TournamentState, matchId: string, attempt: number, out: readonly Outgoing[]): Outgoing[] {
  return scope(state, out, `m:${matchId}:`, `m:${matchId}#${attempt}:`);
}

function say(state: TournamentState, to: UserId, text: string): Step {
  return { state, out: [message(to, text)] };
}

function toast(state: TournamentState, to: UserId, text: string): Step {
  return { state, out: [{ kind: 'toast', to, text }] };
}

function message(to: UserId, text: string): OutgoingMessage {
  return { kind: 'message', to, text };
}

function participant(state: TournamentState, id: UserId): Participant {
  const person = state.people[id];
  return { id, name: person?.name ?? id };
}

function isParticipant(state: TournamentState, id: UserId): boolean {
  return state.intake.config.participants.some((p) => p.id === id);
}

function isOrganizer(state: TournamentState, id: UserId): boolean {
  return state.config.organizerId === id;
}

function canAdmin(state: TournamentState, id: UserId): boolean {
  return isOrganizer(state, id) || state.config.adminIds.includes(id);
}

function matchTitle(state: TournamentState, matchId: string): string {
  const match = state.draw?.bracket && findMatch(state.draw.bracket, matchId);
  if (!match) return matchId;
  const players = state.draw && matchPlayers(state.draw, matchId);
  const names = players ? `: ${players.map((id) => participant(state, id).name).join(' — ')}` : '';
  return `${matchLabel(match)}${names}`;
}

function scoreLine(runtime: MatchRuntime): string {
  const { match, config } = runtime.session;
  const total: [number, number] = [0, 0];
  for (const { awards } of match.closedTracks) {
    if (awards.artist !== null) total[awards.artist] += config.ruleset.artistPoints;
    if (awards.title !== null) total[awards.title] += config.ruleset.titlePoints;
  }
  return `${config.players[0].name} ${formatPoints(total[0])} : ${formatPoints(total[1])} ${config.players[1].name}`;
}

function helpText(state: TournamentState, id: UserId): string {
  const lines = ['Я веду турнир: сбор песен, жеребьёвку, матчи и финал. Все действия — кнопками в сообщениях.', '', '/status — где ты сейчас'];
  if (canAdmin(state, id)) {
    lines.push(
      '',
      'Организатору:',
      '/panel — прислать панели заново',
      '/tech <матч> <номер победителя> <причина> — технический результат (неявка, снятие)',
      '/broadcast <текст> — сообщение всем участникам',
    );
  }
  return lines.join('\n');
}

function statusText(state: TournamentState, id: UserId): string {
  const person = state.people[id];
  const phase: Record<Phase, string> = { intake: 'сбор песен', qualifiers: 'отбор', final: 'финал', archive: 'турнир завершён' };
  const lines = [`Турнир «${state.config.title}» · этап: ${phase[state.phase]}`];
  lines.push(person ? `Ты: №${person.number}, ${person.name}` : 'Ты не зарегистрирован.');
  if (canAdmin(state, id)) lines.push(`Участников: ${Object.keys(state.people).length}`);
  return lines.join('\n');
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function hash(text: string): number {
  let h = 0;
  for (const char of text) h = (h * 31 + char.charCodeAt(0)) % 1_000_003;
  return h;
}
