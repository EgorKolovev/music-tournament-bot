import { confirmedJudge, matchLabel, matchPlayers, recordResult } from '../bot/drawSession.ts';
import { handleIncoming, openMatchSession, type MatchSession } from '../bot/matchSession.ts';
import type { Incoming, Outgoing, UserId } from '../bot/protocol.ts';
import { playedMatches } from '../domain/bracket/bracket.ts';
import { hashText } from '../shared/random.ts';
import { matchTitle, message, participant, scope, scopeMatch, stylesOf, textsTo, toast } from './helpers.ts';
import { libraryOf } from './stages.ts';
import type { MatchRuntime, Step, TournamentState } from './state.ts';

// Отборочные матчи: открытие по готовности пары и судьи, ход матча, результат в сетку, споры.

// Открывает матчи, у которых определились оба игрока и подтверждён судья.
export function syncMatches(state: TournamentState): Step {
  const draw = state.draw;
  if (state.phase !== 'qualifiers' || !draw?.bracket) return { state, out: [] };
  let next = state;
  const out: Outgoing[] = [];
  playedMatches(draw.bracket).forEach((match) => {
    if (next.matches[match.id] || draw.results[match.id]) return;
    const judge = confirmedJudge(draw, match.id);
    const players = matchPlayers(draw, match.id);
    if (!judge || !players) return;
    const opened = openMatch(next, match.id, matchLabel(match).slice(1), players, judge, 0);
    next = opened.state;
    out.push(...opened.out);
  });
  return { state: next, out };
}

function openMatch(
  state: TournamentState,
  matchId: string,
  matchNo: string,
  players: [UserId, UserId],
  judge: UserId,
  attempt: number,
): Step {
  const opened = openMatchSession({
    stage: 'qualifier',
    matchNo,
    players: [participant(state, players[0]), participant(state, players[1])],
    judge: participant(state, judge),
    styles: stylesOf(state),
    library: libraryOf(state, state.intake.closed!.split.main),
    ruleset: state.config.qualifierRuleset,
    seed: state.config.seed + hashText(matchId) * 31 + attempt,
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

export function matchStep(state: TournamentState, matchId: string, input: Incoming, at: number): Step {
  const runtime = state.matches[matchId];
  const from = input.kind === 'worker' ? '' : input.from;
  if (!runtime || runtime.closed) return toast(state, from, textsTo(state, from).events.matchClosed);

  // Знакомство могло пополниться, пока матч шёл: судья этого матча судил чужой и т. п.
  const config = runtime.session.config;
  const session = { ...runtime.session, config: { ...config, knownByPlayers: knownBy(state, [config.players[0].id, config.players[1].id]) } };
  const step = handleIncoming(session, input);
  const updated = trackTimers(runtime, step.session, at);
  const next: TournamentState = {
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

export function closeWithResult(state: TournamentState, matchId: string, winner: UserId, note?: string): Step {
  const draw = state.draw!;
  const runtime = state.matches[matchId];
  const recorded = recordResult(draw, matchId, winner, note);
  const matches = runtime ? { ...state.matches, [matchId]: { ...runtime, closed: true } } : state.matches;
  const next = { ...state, draw: recorded.session, matches };
  return { state: next, out: scope(next, recorded.out, 'd:') };
}

export function openDispute(state: TournamentState, from: UserId, matchId: string, at: number): Step {
  const runtime = state.matches[matchId];
  const texts = textsTo(state, from).events.dispute;
  if (!runtime || runtime.closed || runtime.dispute) return toast(state, from, texts.nothing);
  const { phase } = runtime.session.match;
  const slot = runtime.session.config.players.findIndex((p) => p.id === from);
  if (slot === -1) return toast(state, from, texts.notYours);
  if (phase.kind !== 'decided' || phase.playersConfirmed[slot]) return toast(state, from, texts.confirmed);
  const next = {
    ...state,
    matches: { ...state.matches, [matchId]: { ...runtime, dispute: { by: from, at } } },
    journal: [...state.journal, `Спор: ${participant(state, from).name}, матч ${matchTitle(state, matchId)}`],
  };
  return toast(next, from, texts.sent);
}

export function keepResult(state: TournamentState, matchId: string): Step {
  const runtime = state.matches[matchId];
  const organizer = state.config.organizerId;
  if (!runtime || runtime.closed) return toast(state, organizer, 'Матч уже закрыт');
  const { phase } = runtime.session.match;
  if (phase.kind !== 'decided' && phase.kind !== 'finished') return toast(state, organizer, 'Победитель ещё не определён');
  const winner = runtime.session.config.players[phase.winner].id;
  const resolved = { ...state, journal: [...state.journal, `Организатор: результат ${matchTitle(state, matchId)} оставлен`] };
  return closeWithResult(resolved, matchId, winner, 'решение организатора');
}

export function replayMatch(state: TournamentState, matchId: string): Step {
  const runtime = state.matches[matchId];
  const organizer = state.config.organizerId;
  if (!runtime || runtime.closed) return toast(state, organizer, 'Матч уже закрыт');
  const { config } = runtime.session;
  const closed = { ...state, matches: { ...state.matches, [matchId]: { ...runtime, closed: true } } };
  const notices = [config.judge, ...config.players].map((p) =>
    message(p.id, textsTo(state, p.id).events.replay({ match: config.matchNo })),
  );
  const reopened = openMatch(closed, matchId, config.matchNo, [config.players[0].id, config.players[1].id], config.judge.id, runtime.attempt + 1);
  return { state: reopened.state, out: [...notices, ...reopened.out] };
}
