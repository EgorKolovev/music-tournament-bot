import { matchLabel, matchPlayers } from '../bot/drawSession.ts';
import { handleIntake } from '../bot/intakeSession.ts';
import type { MatchSession, Participant } from '../bot/matchSession.ts';
import type { Incoming, Outgoing, OutgoingMessage, UserId } from '../bot/protocol.ts';
import { findMatch } from '../domain/bracket/bracket.ts';
import { formatPoints } from '../domain/match/ruleset.ts';
import { textsFor, type Texts } from '../texts/index.ts';
import { ORG, type Step, type TournamentState } from './state.ts';

// Общие помощники оркестратора: адресация сообщений, префиксы контекста, имена и счёт.

export const DAY_MS = 24 * 60 * 60_000;
// Москва — UTC+3 круглый год; по ней считаются сроки кругов и время бэкапа.
export const MSK_OFFSET_MS = 3 * 3_600_000;

// Панели этапов, которые сессии рисуют для организатора. Отдельными сообщениями они больше
// не уходят: панель админа показывает их как разделы «Сбор», «Сетка» и «Финал».
const SESSION_PANELS = new Set(['intake', 'draw', 'final']);

export function intakeStep(state: TournamentState, input: Incoming, actor?: UserId): Step {
  const step = handleIntake(state.intake, input);
  return { state: { ...state, intake: step.session }, out: scope(state, step.out, 'i:', 'i:', actor) };
}

// Префикс контекста для slot и callback_data; сообщения организатора уходят ему с префиксом o:.
// actor — админ, нажавший кнопку: ему, а не организатору, уходят ответы сессии.
export function scope(state: TournamentState, out: readonly Outgoing[], prefix: string, slotPrefix = prefix, actor?: UserId): Outgoing[] {
  return out.flatMap((o): Outgoing[] => {
    const toOrganizer = o.to === ORG;
    if (toOrganizer && o.kind === 'message' && o.slot !== undefined && SESSION_PANELS.has(o.slot)) return [];
    const to = toOrganizer ? (actor ?? state.config.organizerId) : o.to;
    if (o.kind === 'toast') return [{ ...o, to }];
    const buttonPrefix = toOrganizer ? 'o:' : prefix;
    const slotScope = toOrganizer ? 'o:' : slotPrefix;
    return [
      {
        ...o,
        to,
        slot: o.slot === undefined ? undefined : `${slotScope}${o.slot}`,
        buttons: o.buttons?.map((row) => row.map((b) => ({ ...b, data: `${buttonPrefix}${b.data}` }))),
      },
    ];
  });
}

export function scopeMatch(state: TournamentState, matchId: string, attempt: number, out: readonly Outgoing[]): Outgoing[] {
  return scope(state, out, `m:${matchId}:`, `m:${matchId}#${attempt}:`);
}

export function say(state: TournamentState, to: UserId, text: string): Step {
  return { state, out: [message(to, text)] };
}

export function toast(state: TournamentState, to: UserId, text: string): Step {
  return { state, out: [{ kind: 'toast', to, text }] };
}

// Тексты для человека — в его стиле (src/texts); незарегистрированному — основной.
export function textsTo(state: TournamentState, id: UserId): Texts {
  return textsFor(state.people[id]?.style);
}

// Стили участников для сессий: только выбранные, остальным — основной.
export function stylesOf(state: TournamentState): Record<UserId, string> {
  return Object.fromEntries(Object.values(state.people).flatMap((p) => (p.style ? [[p.id, p.style]] : [])));
}

export function message(to: UserId, text: string): OutgoingMessage {
  return { kind: 'message', to, text };
}

export function participant(state: TournamentState, id: UserId): Participant {
  const person = state.people[id];
  return { id, name: person?.name ?? id };
}

export function isParticipant(state: TournamentState, id: UserId): boolean {
  return state.intake.config.participants.some((p) => p.id === id);
}

export function isOrganizer(state: TournamentState, id: UserId): boolean {
  return state.config.organizerId === id;
}

// Вышел из турнира сам (/leave), а не снят организатором. В снимках прошлых версий поля нет.
export function hasLeft(state: TournamentState, id: UserId): boolean {
  return state.left?.includes(id) ?? false;
}

export function canAdmin(state: TournamentState, id: UserId): boolean {
  return isOrganizer(state, id) || state.config.adminIds.includes(id);
}

// Кто получает панель админа: организатор и админы из окружения.
export function panelHolders(state: TournamentState): UserId[] {
  const { organizerId, adminIds } = state.config;
  return [organizerId, ...adminIds.filter((id) => id !== organizerId)];
}

// Имя в турнире человек вводит сам, поэтому рядом — ник в Telegram, а без ника — имя из профиля.
export function whoIs(state: TournamentState, id: UserId): string {
  const person = state.people[id];
  if (!person) return id;
  if (person.username) return `${person.name} @${person.username}`;
  return person.profileName ? `${person.name} (без ника, в Telegram — ${person.profileName})` : `${person.name} (без ника)`;
}

export function matchTitle(state: TournamentState, matchId: string): string {
  const match = state.draw?.bracket && findMatch(state.draw.bracket, matchId);
  if (!match) return matchId;
  const players = state.draw && matchPlayers(state.draw, matchId);
  const names = players ? `: ${players.map((id) => participant(state, id).name).join(' — ')}` : '';
  return `${matchLabel(match)}${names}`;
}

export function scoreLine(session: MatchSession): string {
  const { match, config } = session;
  const total: [number, number] = [0, 0];
  for (const { awards } of match.closedTracks) {
    if (awards.artist !== null) total[awards.artist] += config.ruleset.artistPoints;
    if (awards.title !== null) total[awards.title] += config.ruleset.titlePoints;
  }
  return `${config.players[0].name} ${formatPoints(total[0])} : ${formatPoints(total[1])} ${config.players[1].name}`;
}

export function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// Дата по Москве: жеребьёвка в час ночи — это уже новый день, хотя по UTC ещё вчера.
export function moscowDate(ms: number): string {
  return isoDate(ms + MSK_OFFSET_MS);
}
