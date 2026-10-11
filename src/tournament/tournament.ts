import { handleDraw } from '../bot/drawSession.ts';
import { handleFinal } from '../bot/finalSession.ts';
import { openIntakeSession } from '../bot/intakeSession.ts';
import type { Incoming, OutgoingMessage } from '../bot/protocol.ts';
import { handleCommand } from './commands.ts';
import type { Sender, StampedEvent, TournamentEvent } from './events.ts';
import { intakeStep, isOrganizer, isParticipant, say, scope, toast } from './helpers.ts';
import { adminMenuButton, forfeitWithdrawn } from './organizer.ts';
import { renderExtras } from './panels.ts';
import { keepResult, matchStep, openDispute, replayMatch, syncMatches } from './qualifiers.ts';
import { registrationButton, registrationText } from './registration.ts';
import { tick } from './reminders.ts';
import { archive, openDraw, openFinal, toFinal } from './stages.ts';
import { ORG, type Step, type TournamentConfig, type TournamentState } from './state.ts';

// Оркестратор турнира (docs/telegram-integration.md, разделы 2, 4, 6): одно состояние на весь
// турнир, этапы сбор → отбор → финал → архив. Чистая функция (состояние, событие) → (состояние,
// сообщения); время приходит в событии, поэтому повтор журнала восстанавливает то же состояние.
//
// Маршрутизация: у каждой кнопки и каждого slot префикс контекста — один человек может быть
// игроком своего матча и судьёй чужого, а организатор — ещё и участником.
//   r: регистрация · i: сбор · o: организатор · d: жеребьёвка и карточки · m:<матч>: матч
//   f: финал · x: споры

export type { Step, TournamentConfig, TournamentState } from './state.ts';

export function createTournament(config: TournamentConfig): Step {
  const opened = openIntakeSession({
    participants: [],
    background: [],
    organizer: { id: ORG, name: 'Организатор' },
    rules: config.intakeRules,
    fragmentSec: config.fragmentSec,
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
    draw: null,
    matches: {},
    known: {},
    remindedDeadlines: {},
    overdueReported: {},
    finalJudge: null,
    final: null,
    withdrawn: [],
    adminMenu: null,
    journal: [],
  };
  return { state, out: [...scope(state, opened.out, 'i:'), ...renderExtras(state)] };
}

export function handleEvent(state: TournamentState, { at, event }: StampedEvent): Step {
  const before = renderExtras(state);
  const step = dispatch(state, event, at);
  // Снятые проигрывают новые пары до того, как для этих пар откроются матчи.
  const forfeits = forfeitWithdrawn(step.state);
  const synced = syncMatches(forfeits.state);
  const after = renderExtras(synced.state);
  return { state: synced.state, out: [...step.out, ...forfeits.out, ...synced.out, ...diff(before, after)] };
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
    case 'worker':
      return intakeStep(state, { kind: 'worker', results: event.results });
    case 'button':
      return handleButton(state, event.from, event.data, at);
    case 'tick':
      return tick(state, at);
  }
}

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
  if (data === 'toFinal') return toFinal(state);
  if (data === 'openFinal') return openFinal(state);
  if (data === 'archive') return archive(state);
  const menu = adminMenuButton(state, data);
  if (menu) return menu;
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

function diff(before: OutgoingMessage[], after: OutgoingMessage[]): OutgoingMessage[] {
  const previous = new Map(before.map((m) => [`${m.to}/${m.slot}`, JSON.stringify(m)]));
  return after.filter((m) => previous.get(`${m.to}/${m.slot}`) !== JSON.stringify(m));
}
