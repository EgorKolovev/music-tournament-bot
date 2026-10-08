import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  createMatch,
  liveScore,
  type MatchCommand,
  type MatchState,
  type PlayerSlot,
  type TrackAwards,
} from './match.ts';
import { FINAL_RULESET, QUALIFIER_RULESET, type Ruleset } from './ruleset.ts';

function run(state: MatchState, ...commands: MatchCommand[]): MatchState {
  for (const command of commands) {
    const result = applyCommand(state, command);
    if (!result.ok) throw new Error(`${command.type}: ${result.error}`);
    state = result.state;
  }
  return state;
}

function readyMatch(ruleset: Ruleset = FINAL_RULESET): MatchState {
  return run(
    createMatch(ruleset),
    { type: 'markReady', who: 'judge' },
    { type: 'markReady', who: 0 },
    { type: 'markReady', who: 1 },
  );
}

let songCounter = 0;

function playTrack(state: MatchState, awards: Partial<TrackAwards>): MatchState {
  const commands: MatchCommand[] = [{ type: 'issueTrack', songId: `s${++songCounter}` }, { type: 'startTrack' }];
  if (awards.artist != null) commands.push({ type: 'award', component: 'artist', player: awards.artist });
  if (awards.title != null) commands.push({ type: 'award', component: 'title', player: awards.title });
  commands.push({ type: 'closeTrack' });
  return run(state, ...commands);
}

function playTracks(state: MatchState, count: number, awards: Partial<TrackAwards>): MatchState {
  for (let i = 0; i < count; i++) state = playTrack(state, awards);
  return state;
}

function winnerOf(state: MatchState): PlayerSlot | undefined {
  return state.phase.kind === 'decided' || state.phase.kind === 'finished' ? state.phase.winner : undefined;
}

describe('лобби', () => {
  it('матч начинается, только когда готовы судья и оба игрока', () => {
    let state = run(createMatch(FINAL_RULESET), { type: 'markReady', who: 0 }, { type: 'markReady', who: 'judge' });
    expect(state.phase.kind).toBe('lobby');
    state = run(state, { type: 'markReady', who: 1 });
    expect(state.phase.kind).toBe('between_tracks');
  });
});

describe('присуждение компонентов', () => {
  it('нельзя присуждать до старта трека', () => {
    const state = run(readyMatch(), { type: 'issueTrack', songId: 'x' });
    expect(applyCommand(state, { type: 'award', component: 'artist', player: 0 })).toEqual({
      ok: false,
      error: 'track_not_started',
    });
  });

  it('взятый компонент блокируется для второго игрока, другой остаётся доступным', () => {
    const state = run(
      readyMatch(),
      { type: 'issueTrack', songId: 'x' },
      { type: 'startTrack' },
      { type: 'award', component: 'artist', player: 0 },
    );
    expect(applyCommand(state, { type: 'award', component: 'artist', player: 1 })).toEqual({
      ok: false,
      error: 'component_taken',
    });
    const after = run(state, { type: 'award', component: 'title', player: 1 });
    expect(liveScore(after)).toEqual([9, 12]);
  });

  it('отмена снимает последнее присуждение текущего трека', () => {
    let state = run(
      readyMatch(),
      { type: 'issueTrack', songId: 'x' },
      { type: 'startTrack' },
      { type: 'award', component: 'title', player: 0 },
      { type: 'award', component: 'artist', player: 1 },
      { type: 'undo' },
    );
    expect(liveScore(state)).toEqual([12, 0]);
    state = run(state, { type: 'award', component: 'artist', player: 0 });
    expect(liveScore(state)).toEqual([21, 0]);
  });

  it('«Никто не угадал» недоступно при присуждённом компоненте', () => {
    const state = run(
      readyMatch(),
      { type: 'issueTrack', songId: 'x' },
      { type: 'startTrack' },
      { type: 'award', component: 'title', player: 0 },
    );
    expect(applyCommand(state, { type: 'nobodyGuessed' })).toEqual({ ok: false, error: 'awards_present' });
  });

  it('технически отменённый трек не даёт очков и не тратит лимит', () => {
    const state = run(
      readyMatch(),
      { type: 'issueTrack', songId: 'broken' },
      { type: 'startTrack' },
      { type: 'award', component: 'title', player: 0 },
      { type: 'cancelTrack', reason: 'audio_error' },
    );
    expect(liveScore(state)).toEqual([0, 0]);
    expect(state.closedTracks).toHaveLength(0);
    expect(state.cancelledTracks).toEqual([{ songId: 'broken', reason: 'audio_error' }]);
  });
});

describe('завершение матча', () => {
  it('победа после закрытия трека, когда лидер набрал 9,0', () => {
    let state = playTracks(readyMatch(), 4, { artist: 0, title: 0 });
    expect(state.phase.kind).toBe('between_tracks');
    state = playTrack(state, { artist: 0, title: 0 });
    expect(liveScore(state)).toEqual([105, 0]);
    expect(winnerOf(state)).toBe(0);
  });

  it('пересечение порога вничью 9,3 : 9,3 продолжает матч', () => {
    // 8,4 : 8,1 — пример из docs/architecture.md, раздел 1.
    let state = playTracks(readyMatch(), 4, { artist: 0, title: 0 });
    state = playTracks(state, 9, { artist: 1 });
    expect(liveScore(state)).toEqual([84, 81]);

    state = playTrack(state, { artist: 0, title: 1 });
    expect(liveScore(state)).toEqual([93, 93]);
    expect(state.phase.kind).toBe('between_tracks');

    state = playTrack(state, { title: 1 });
    expect(winnerOf(state)).toBe(1);
  });

  it('после 20 треков без порога побеждает лидер по счёту', () => {
    let state = playTrack(readyMatch(), { artist: 1 });
    state = playTracks(state, 19, {});
    expect(state.closedTracks).toHaveLength(20);
    expect(winnerOf(state)).toBe(1);
  });

  it('равенство после 20 треков даёт дополнительные треки до первого неравного счёта', () => {
    let state = playTracks(readyMatch(), 20, {});
    expect(state.phase.kind).toBe('between_tracks');
    // Паузы после серии ничьих нет: матч идёт, пока счёт не разойдётся.
    state = playTracks(state, 12, {});
    expect(state.phase.kind).toBe('between_tracks');
    state = playTrack(state, { artist: 0 });
    expect(winnerOf(state)).toBe(0);
  });

  it('результат подтверждает сначала судья, затем оба игрока', () => {
    let state = playTracks(readyMatch(), 5, { artist: 0, title: 0 });
    expect(applyCommand(state, { type: 'confirmResult', who: 0 })).toEqual({
      ok: false,
      error: 'judge_must_confirm_first',
    });
    state = run(state, { type: 'confirmResult', who: 'judge' }, { type: 'confirmResult', who: 1 });
    expect(state.phase.kind).toBe('decided');
    state = run(state, { type: 'confirmResult', who: 0 });
    expect(state.phase).toEqual({ kind: 'finished', winner: 0 });
  });
});

describe('короткий отбор на N треков', () => {
  it('матч не заканчивается досрочно, даже при большом отрыве', () => {
    let state = playTracks(readyMatch(QUALIFIER_RULESET), 4, { artist: 0, title: 0 });
    expect(liveScore(state)).toEqual([84, 0]);
    expect(state.phase.kind).toBe('between_tracks');
    state = playTrack(state, {});
    expect(winnerOf(state)).toBe(0);
  });

  it('ничья 2,1 : 2,1 после N треков решается дополнительными треками', () => {
    // 0,9 + 1,2 против 1,2 + 0,9 — пример из разбора механики.
    let state = playTrack(readyMatch(QUALIFIER_RULESET), { artist: 0, title: 1 });
    state = playTrack(state, { artist: 1, title: 0 });
    state = playTracks(state, 3, {});
    expect(liveScore(state)).toEqual([21, 21]);
    expect(state.phase.kind).toBe('between_tracks');
    state = playTracks(state, 2, {});
    state = playTrack(state, { title: 1 });
    expect(state.closedTracks).toHaveLength(8);
    expect(winnerOf(state)).toBe(1);
  });
});

describe('нехватка песен', () => {
  it('матч останавливается только между треками и только по исчерпанию песен', () => {
    const state = readyMatch(QUALIFIER_RULESET);
    expect(applyCommand(run(state, { type: 'issueTrack', songId: 'x' }), { type: 'suspend', reason: 'songs_exhausted' })).toEqual({
      ok: false,
      error: 'wrong_phase',
    });
    expect(run(state, { type: 'suspend', reason: 'songs_exhausted' }).phase).toEqual({
      kind: 'suspended',
      reason: 'songs_exhausted',
    });
  });
});

describe('пауза', () => {
  it('во время паузы разрешено только продолжение', () => {
    const state = run(readyMatch(), { type: 'issueTrack', songId: 'x' }, { type: 'pause' });
    expect(applyCommand(state, { type: 'startTrack' })).toEqual({ ok: false, error: 'paused' });
    expect(run(state, { type: 'resume' }, { type: 'startTrack' }).phase.kind).toBe('track');
  });
});
