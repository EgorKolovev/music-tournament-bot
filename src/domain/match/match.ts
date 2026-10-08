import { regularTracks, type Ruleset } from './ruleset.ts';

// Чистое ядро отборочного матча: состояние + команда → новое состояние или ошибка.
// Ничего не знает о Telegram, базе и выборе песен (docs/architecture.md, разделы 1, 3, 8).

export type PlayerSlot = 0 | 1;
export type Component = 'artist' | 'title';
export type Actor = 'judge' | PlayerSlot;

export interface TrackAwards {
  artist: PlayerSlot | null;
  title: PlayerSlot | null;
}

export interface ClosedTrack {
  songId: string;
  awards: TrackAwards;
}

export interface CancelledTrack {
  songId: string;
  reason: string;
}

export interface CurrentTrack {
  songId: string;
  started: boolean;
  awards: TrackAwards;
  // Порядок присуждений для «Отменить последнее действие».
  awardOrder: Component[];
}

export type MatchPhase =
  | { kind: 'lobby'; judgeReady: boolean; playersReady: [boolean, boolean] }
  | { kind: 'between_tracks' }
  | { kind: 'track'; track: CurrentTrack }
  | { kind: 'decided'; winner: PlayerSlot; judgeConfirmed: boolean; playersConfirmed: [boolean, boolean] }
  | { kind: 'finished'; winner: PlayerSlot }
  // Матч остановлен: подходящие песни закончились. Ничья сама по себе матч не останавливает.
  | { kind: 'suspended'; reason: SuspendReason };

export type SuspendReason = 'songs_exhausted';

export interface MatchState {
  ruleset: Ruleset;
  phase: MatchPhase;
  paused: boolean;
  closedTracks: ClosedTrack[];
  cancelledTracks: CancelledTrack[];
  // Растёт с каждой успешной командой; кнопки панели несут версию, устаревшие отклоняются.
  version: number;
}

export type MatchCommand =
  | { type: 'markReady'; who: Actor }
  | { type: 'issueTrack'; songId: string }
  | { type: 'startTrack' }
  | { type: 'award'; component: Component; player: PlayerSlot }
  | { type: 'undo' }
  | { type: 'closeTrack' }
  | { type: 'nobodyGuessed' }
  | { type: 'cancelTrack'; reason: string }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'suspend'; reason: SuspendReason }
  | { type: 'confirmResult'; who: Actor };

export type MatchError =
  | 'paused'
  | 'not_paused'
  | 'wrong_phase'
  | 'already_ready'
  | 'track_not_started'
  | 'track_already_started'
  | 'component_taken'
  | 'nothing_to_undo'
  | 'awards_present'
  | 'judge_must_confirm_first'
  | 'already_confirmed';

export type MatchResult = { ok: true; state: MatchState } | { ok: false; error: MatchError };

export function createMatch(ruleset: Ruleset): MatchState {
  return {
    ruleset,
    phase: { kind: 'lobby', judgeReady: false, playersReady: [false, false] },
    paused: false,
    closedTracks: [],
    cancelledTracks: [],
    version: 0,
  };
}

export function scoreOf(tracks: readonly { awards: TrackAwards }[], ruleset: Ruleset): [number, number] {
  const score: [number, number] = [0, 0];
  for (const { awards } of tracks) {
    if (awards.artist !== null) score[awards.artist] += ruleset.artistPoints;
    if (awards.title !== null) score[awards.title] += ruleset.titlePoints;
  }
  return score;
}

// Счёт с учётом черновых присуждений текущего трека — для панели судьи.
export function liveScore(state: MatchState): [number, number] {
  const tracks: { awards: TrackAwards }[] = [...state.closedTracks];
  if (state.phase.kind === 'track') tracks.push(state.phase.track);
  return scoreOf(tracks, state.ruleset);
}

export function usedSongIds(state: MatchState): string[] {
  const ids = [...state.closedTracks.map((t) => t.songId), ...state.cancelledTracks.map((t) => t.songId)];
  if (state.phase.kind === 'track') ids.push(state.phase.track.songId);
  return ids;
}

export function isPausable(phase: MatchPhase): boolean {
  return phase.kind === 'lobby' || phase.kind === 'between_tracks' || phase.kind === 'track';
}

export function applyCommand(state: MatchState, command: MatchCommand): MatchResult {
  if (state.paused && command.type !== 'resume') return fail('paused');

  const next = (patch: Partial<MatchState>): MatchResult => ({
    ok: true,
    state: { ...state, ...patch, version: state.version + 1 },
  });
  const { phase } = state;

  switch (command.type) {
    case 'pause':
      return isPausable(phase) ? next({ paused: true }) : fail('wrong_phase');

    case 'resume':
      return state.paused ? next({ paused: false }) : fail('not_paused');

    case 'suspend':
      if (phase.kind !== 'between_tracks') return fail('wrong_phase');
      return next({ phase: { kind: 'suspended', reason: command.reason } });

    case 'markReady': {
      if (phase.kind !== 'lobby') return fail('wrong_phase');
      const lobby = {
        ...phase,
        playersReady: [...phase.playersReady] as [boolean, boolean],
      };
      if (command.who === 'judge') {
        if (lobby.judgeReady) return fail('already_ready');
        lobby.judgeReady = true;
      } else {
        if (lobby.playersReady[command.who]) return fail('already_ready');
        lobby.playersReady[command.who] = true;
      }
      const everyoneReady = lobby.judgeReady && lobby.playersReady[0] && lobby.playersReady[1];
      return next({ phase: everyoneReady ? { kind: 'between_tracks' } : lobby });
    }

    case 'issueTrack':
      if (phase.kind !== 'between_tracks') return fail('wrong_phase');
      return next({
        phase: {
          kind: 'track',
          track: { songId: command.songId, started: false, awards: { artist: null, title: null }, awardOrder: [] },
        },
      });

    case 'startTrack':
      if (phase.kind !== 'track') return fail('wrong_phase');
      if (phase.track.started) return fail('track_already_started');
      return next({ phase: { kind: 'track', track: { ...phase.track, started: true } } });

    case 'award': {
      if (phase.kind !== 'track') return fail('wrong_phase');
      const { track } = phase;
      if (!track.started) return fail('track_not_started');
      // Компонент, присуждённый одному игроку, блокируется для второго; другой компонент остаётся доступным.
      if (track.awards[command.component] !== null) return fail('component_taken');
      return next({
        phase: {
          kind: 'track',
          track: {
            ...track,
            awards: { ...track.awards, [command.component]: command.player },
            awardOrder: [...track.awardOrder, command.component],
          },
        },
      });
    }

    case 'undo': {
      if (phase.kind !== 'track') return fail('wrong_phase');
      const { track } = phase;
      const last = track.awardOrder.at(-1);
      if (last === undefined) return fail('nothing_to_undo');
      return next({
        phase: {
          kind: 'track',
          track: { ...track, awards: { ...track.awards, [last]: null }, awardOrder: track.awardOrder.slice(0, -1) },
        },
      });
    }

    case 'nobodyGuessed':
      if (phase.kind === 'track' && (phase.track.awards.artist !== null || phase.track.awards.title !== null)) {
        return fail('awards_present');
      }
      return closeTrack(state, next);

    case 'closeTrack':
      return closeTrack(state, next);

    case 'cancelTrack':
      if (phase.kind !== 'track') return fail('wrong_phase');
      // Присуждения технически отменённого трека не засчитываются, и трек не тратит лимит матча.
      return next({
        phase: { kind: 'between_tracks' },
        cancelledTracks: [...state.cancelledTracks, { songId: phase.track.songId, reason: command.reason }],
      });

    case 'confirmResult': {
      if (phase.kind !== 'decided') return fail('wrong_phase');
      const decided = { ...phase, playersConfirmed: [...phase.playersConfirmed] as [boolean, boolean] };
      if (command.who === 'judge') {
        if (decided.judgeConfirmed) return fail('already_confirmed');
        decided.judgeConfirmed = true;
      } else {
        if (!decided.judgeConfirmed) return fail('judge_must_confirm_first');
        if (decided.playersConfirmed[command.who]) return fail('already_confirmed');
        decided.playersConfirmed[command.who] = true;
      }
      const allConfirmed = decided.playersConfirmed[0] && decided.playersConfirmed[1];
      return next({ phase: allConfirmed ? { kind: 'finished', winner: decided.winner } : decided });
    }
  }
}

function closeTrack(state: MatchState, next: (patch: Partial<MatchState>) => MatchResult): MatchResult {
  const { phase } = state;
  if (phase.kind !== 'track') return fail('wrong_phase');
  if (!phase.track.started) return fail('track_not_started');

  // Оба компонента фиксируются одной операцией; неугаданный остаётся без очков.
  const closedTracks = [...state.closedTracks, { songId: phase.track.songId, awards: phase.track.awards }];
  return next({ closedTracks, phase: resolveAfterClose(closedTracks, state.ruleset) });
}

// Итог проверяется только после закрытия всего трека: порядок кнопок не влияет на результат.
export function resolveAfterClose(closedTracks: readonly ClosedTrack[], ruleset: Ruleset): MatchPhase {
  const [a, b] = scoreOf(closedTracks, ruleset);
  const leader: PlayerSlot | null = a > b ? 0 : b > a ? 1 : null;
  if (leader === null) return { kind: 'between_tracks' };

  const decided: MatchPhase = { kind: 'decided', winner: leader, judgeConfirmed: false, playersConfirmed: [false, false] };
  const { format } = ruleset;
  if (format.kind === 'first_to' && Math.max(a, b) >= format.winThreshold) return decided;
  // После основной части, включая дополнительные треки, первый неравный счёт завершает матч.
  if (closedTracks.length >= regularTracks(format)) return decided;
  return { kind: 'between_tracks' };
}

function fail(error: MatchError): MatchResult {
  return { ok: false, error };
}
