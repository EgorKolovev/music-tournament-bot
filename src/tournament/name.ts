import type { MatchSession, Participant } from '../bot/matchSession.ts';
import type { OutgoingMessage, UserId } from '../bot/protocol.ts';
import type { TournamentEvent } from './events.ts';
import { say, textsTo } from './helpers.ts';
import { cleanName } from './registration.ts';
import type { Step, TournamentState } from './state.ts';
import { redrawShown } from './shown.ts';

// Смена имени участником (/name): «/name Аня К.» — сразу, «/name» — бот ждёт имя следующим сообщением.
// Новое имя видно везде, где имя показывают: показанные карточки пар, панели матча, список песен и
// панель организатора правятся на месте. Разовые сообщения и журнал остаются со старым именем,
// поэтому в журнал пишется, кто как теперь зовётся.

const SLOT = 'n:name';

export function askName(state: TournamentState, id: UserId, payload: string): Step {
  const person = state.people[id];
  const texts = textsTo(state, id).commands.name;
  if (!person) return say(state, id, texts.stranger);
  if (payload.trim()) return nameText(state, id, payload);
  return {
    state: { ...state, renaming: [...waiting(state, id), id] },
    out: [reply(id, texts.ask({ name: person.name }), [[{ label: texts.keep, data: 'n:keep' }]])],
  };
}

export function isRenaming(state: TournamentState, id: UserId): boolean {
  return state.renaming?.includes(id) ?? false;
}

// Новое имя — из /name или следующим сообщением. Не подошло — ждём ещё раз.
export function nameText(state: TournamentState, id: UserId, text: string): Step {
  const person = state.people[id]!;
  const name = cleanName(text);
  if (!name) {
    const next = { ...state, renaming: [...waiting(state, id), id] };
    return say(next, id, textsTo(state, id).registration.badName);
  }
  const done = { ...state, renaming: waiting(state, id) };
  if (name === person.name) return { state: done, out: [reply(id, textsTo(state, id).commands.name.same({ name }))] };
  const next = { ...withName(done, id, name), journal: [...done.journal, `Новое имя: №${person.number} ${person.name} → ${name}`] };
  return { state: next, out: [reply(id, textsTo(next, id).commands.name.done({ name })), ...redrawShown(state, next)] };
}

// «Оставить как есть». Кнопка из старого вопроса тоже просто закрывает его.
export function nameButton(state: TournamentState, id: UserId): Step {
  const next = { ...state, renaming: waiting(state, id) };
  return { state: next, out: [{ ...reply(id, textsTo(state, id).commands.name.kept), bump: false }] };
}

// Человек занялся другим — командой или кнопкой: имя больше не ждём, иначе следующее сообщение
// (например, название песни на сборе) стало бы именем.
export function forgetName(state: TournamentState, event: TournamentEvent): TournamentState {
  if ((event.kind !== 'command' && event.kind !== 'button') || !isRenaming(state, event.from.id)) return state;
  if (event.kind === 'command' ? event.command === 'name' : event.data.startsWith('n:')) return state;
  return { ...state, renaming: waiting(state, event.from.id) };
}

function waiting(state: TournamentState, except: UserId): UserId[] {
  return (state.renaming ?? []).filter((id) => id !== except);
}

// Ответ — в одном сообщении с вопросом: внизу чата, раз человек писал после него.
function reply(to: UserId, text: string, buttons?: OutgoingMessage['buttons']): OutgoingMessage {
  return { kind: 'message', to, slot: SLOT, bump: true, text, buttons };
}

// Имя — во все сессии, где лежат копии участника: оттуда его берут карточки, панели и списки.
function withName(state: TournamentState, id: UserId, name: string): TournamentState {
  const rename = (p: Participant): Participant => (p.id === id ? { ...p, name } : p);
  const inMatch = (session: MatchSession): MatchSession => {
    const { config } = session;
    return { ...session, config: { ...config, players: [rename(config.players[0]), rename(config.players[1])], judge: rename(config.judge) } };
  };
  const matches = Object.fromEntries(Object.entries(state.matches).map(([key, m]) => [key, { ...m, session: inMatch(m.session) }]));
  const final = state.final && {
    ...state.final,
    config: { ...state.final.config, finalists: state.final.config.finalists.map(rename), judge: rename(state.final.config.judge) },
    current: state.final.current && { ...state.final.current, session: inMatch(state.final.current.session) },
  };
  return {
    ...state,
    people: { ...state.people, [id]: { ...state.people[id]!, name } },
    intake: { ...state.intake, config: { ...state.intake.config, participants: state.intake.config.participants.map(rename) } },
    draw: state.draw && {
      ...state.draw,
      config: { ...state.draw.config, players: state.draw.config.players.map(rename), registered: state.draw.config.registered.map(rename) },
    },
    matches,
    finalJudge: state.finalJudge && rename(state.finalJudge),
    final,
  };
}
