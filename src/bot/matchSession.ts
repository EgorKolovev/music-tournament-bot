import {
  applyCommand,
  createMatch,
  liveScore,
  scoreOf,
  usedSongIds,
  type Actor,
  type Component,
  type MatchCommand,
  type MatchError,
  type MatchState,
  type PlayerSlot,
} from '../domain/match/match.ts';
import { formatPoints, minLeadOf, regularTracks, type Ruleset } from '../domain/match/ruleset.ts';
import { eligibleSongs, pickLeastUsed, type PoolSong } from '../domain/selection/pickSong.ts';
import { seededRandom } from '../shared/random.ts';
import { formatClock } from '../shared/text.ts';
import { textsOf, type Texts } from '../texts/index.ts';
import { NOOP, type Button, type Incoming, type Outgoing, type OutgoingMessage, type UserId } from './protocol.ts';

// Сессия одного отборочного матча в памяти: превращает нажатия кнопок в команды ядра и рендерит
// сообщения судье и игрокам. Хранение в PostgreSQL и Telegram-адаптер подключаются поверх позже.

export interface Participant {
  id: UserId;
  name: string;
}

export interface LibrarySong extends PoolSong {
  artist: string;
  title: string;
  acceptedAnswers?: string[];
  audioUrl?: string;
  // file_id игровой версии в Telegram — его выдаёт worker после обработки.
  audioFileId?: string;
  // Начало, заданное автором. Игровая версия уже нарезана с него; без неё судья включает песню сам.
  startSec?: number;
}

export interface MatchSessionConfig {
  stage: 'qualifier' | 'final';
  // Номер для людей: в отборе «1.4», как в сетке и карточках; в финале — порядковый.
  matchNo: string;
  players: [Participant, Participant];
  judge: Participant;
  // Стиль текстов участника (src/texts); нет — основной.
  styles?: Record<UserId, string>;
  library: LibrarySong[];
  ruleset: Ruleset;
  seed: number;
  // Песни, которые игроки уже знают (судили, слышали ответы), — им не выдаются.
  knownByPlayers?: string[];
  // Финал: песни, уже прозвучавшие в финале, не выдаются никому.
  excludedSongIds?: string[];
  // Финал: общая очередь с зафиксированным seed; берётся первая подходящая песня.
  queue?: string[];
}

interface IssuedTrack {
  songId: string;
  number: number;
}

export interface MatchSession {
  config: MatchSessionConfig;
  match: MatchState;
  // Порядок выдачи, включая технически отменённые треки: по нему строится история в чате судьи.
  issued: IssuedTrack[];
}

export interface SessionStep {
  session: MatchSession;
  out: Outgoing[];
}

function errorText(texts: Texts['match'], error: MatchError): string {
  const { toast } = texts;
  const byError: Record<MatchError, string> = {
    paused: toast.paused,
    not_paused: toast.notPaused,
    wrong_phase: toast.wrongPhase,
    already_ready: toast.alreadyReady,
    track_not_started: toast.trackNotStarted,
    track_already_started: toast.trackStarted,
    component_taken: toast.componentTaken,
    nothing_to_undo: toast.nothingToUndo,
    awards_present: toast.awardsPresent,
    judge_must_confirm_first: toast.judgeFirst,
    already_confirmed: toast.alreadyConfirmed,
  };
  return byError[error];
}

// Тексты матча для участника — в его стиле.
function tx(session: MatchSession, userId: UserId): Texts['match'] {
  return textsOf(session.config.styles, userId).match;
}

// Запас на основную часть матча и дополнительные треки. С отрывом матч заметно длиннее: в симуляции
// 20 тыс. матчей равных игроков, угадывающих каждый компонент с вероятностью 15–35 %, при отрыве 2,0
// 90 % матчей укладываются в 9–15 треков против 5–6 при прежнем правиле, а у слабых пар 1 % матчей
// доходит примерно до 30 треков (docs/decisions/2026-10-15-qualifier-lead.md). Порог — нижняя граница,
// ниже которой судья видит предупреждение, а не гарантия: при отрыве 2,0 примерно каждый десятый матч
// слабой пары выходит за этот запас. +10 подобрано под 2,0; при 3,0 запас занижен.
export function minSongsForMatch(ruleset: Ruleset): number {
  return regularTracks(ruleset.format) + (minLeadOf(ruleset.format) > 0 ? 10 : 5);
}

export function openMatchSession(config: MatchSessionConfig): SessionStep {
  const session: MatchSession = { config, match: createMatch(config.ruleset), issued: [] };
  return { session, out: render(session) };
}

export function handleIncoming(session: MatchSession, input: Incoming): SessionStep {
  // Во время матча бот реагирует только на кнопки.
  if (input.kind !== 'button') return { session, out: [] };
  const actor = actorOf(session.config, input.from);
  if (actor === undefined) return reply(session, input.from, tx(session, input.from).toast.stranger);
  if (input.data === NOOP) return { session, out: [] };

  const [action, versionTag] = input.data.split('|');
  if (actor === 'judge') {
    // Устаревшая кнопка не применяется: судья видит актуальную панель.
    if (versionTag !== `v${session.match.version}`) {
      return reply(session, input.from, tx(session, input.from).toast.stalePanel);
    }
    return judgeAction(session, action!);
  }

  if (action === 'ready') return apply(session, { type: 'markReady', who: actor }, input.from);
  if (action === 'confirm') return apply(session, { type: 'confirmResult', who: actor }, input.from);
  return reply(session, input.from, tx(session, input.from).toast.judgeOnly);
}

function judgeAction(session: MatchSession, action: string): SessionStep {
  const judgeId = session.config.judge.id;
  const simple: Record<string, MatchCommand> = {
    ready: { type: 'markReady', who: 'judge' },
    start: { type: 'startTrack' },
    undo: { type: 'undo' },
    close: { type: 'closeTrack' },
    none: { type: 'nobodyGuessed' },
    audioError: { type: 'cancelTrack', reason: 'audio_error' },
    pause: { type: 'pause' },
    resume: { type: 'resume' },
    confirm: { type: 'confirmResult', who: 'judge' },
  };
  const command = simple[action];
  if (command) return apply(session, command, judgeId);

  const award = /^aw:([at]):([01])$/.exec(action);
  if (award) {
    const component: Component = award[1] === 'a' ? 'artist' : 'title';
    return apply(session, { type: 'award', component, player: Number(award[2]) as PlayerSlot }, judgeId);
  }

  if (action === 'issue') {
    const song = pickSong(session);
    // Остановка матча — только при реальном исчерпании подходящих песен.
    if (!song) return apply(session, { type: 'suspend', reason: 'songs_exhausted' }, judgeId);
    return apply(session, { type: 'issueTrack', songId: song.id }, judgeId);
  }

  return reply(session, judgeId, tx(session, judgeId).toast.unknown);
}

function apply(session: MatchSession, command: MatchCommand, from: UserId): SessionStep {
  const result = applyCommand(session.match, command);
  if (!result.ok) return reply(session, from, errorText(tx(session, from), result.error));

  const issued =
    command.type === 'issueTrack'
      ? [...session.issued, { songId: command.songId, number: session.match.closedTracks.length + 1 }]
      : session.issued;
  const next: MatchSession = { ...session, match: result.state, issued };
  return { session: next, out: diffRender(render(session), render(next)) };
}

function reply(session: MatchSession, to: UserId, text: string): SessionStep {
  return { session, out: [{ kind: 'toast', to, text }] };
}

function actorOf(config: MatchSessionConfig, userId: UserId): Actor | undefined {
  if (userId === config.judge.id) return 'judge';
  if (userId === config.players[0].id) return 0;
  if (userId === config.players[1].id) return 1;
  return undefined;
}

export function eligibleForMatch(session: MatchSession): LibrarySong[] {
  const { config } = session;
  return eligibleSongs(config.library, {
    playerIds: config.players.map((p) => p.id),
    usedInMatch: new Set([...usedSongIds(session.match), ...(config.excludedSongIds ?? [])]),
    knownByPlayers: new Set(config.knownByPlayers ?? []),
  });
}

function pickSong(session: MatchSession): LibrarySong | undefined {
  const { queue } = session.config;
  if (queue) {
    // Финал: детерминированная очередь, одинаковая онлайн и на бумаге.
    const eligible = new Set(eligibleForMatch(session).map((s) => s.id));
    const id = queue.find((songId) => eligible.has(songId));
    return session.config.library.find((s) => s.id === id);
  }
  // Отдельный поток случайности на каждую выдачу: повтор сценария даёт те же песни.
  const random = seededRandom(session.config.seed + session.issued.length * 7919);
  return pickLeastUsed(eligibleForMatch(session), new Map(), random);
}

// --- Рендер ---------------------------------------------------------------

// Отправляем только изменившиеся сообщения: Telegram отвергает правку без изменений.
function diffRender(before: OutgoingMessage[], after: OutgoingMessage[]): OutgoingMessage[] {
  const previous = new Map(before.map((m) => [`${m.to}/${m.slot}`, JSON.stringify(m)]));
  return after.filter((m) => previous.get(`${m.to}/${m.slot}`) !== JSON.stringify(m));
}

export function render(session: MatchSession): OutgoingMessage[] {
  const { judge, players } = session.config;
  return [
    ...renderJudge(session).map((m) => ({ ...m, to: judge.id })),
    ...players.map((player, slot) => ({
      ...renderPlayerStatus(session, slot as PlayerSlot),
      to: player.id,
    })),
  ];
}

type Draft = Omit<OutgoingMessage, 'to'>;

function message(slot: string, text: string, buttons?: Button[][]): Draft {
  return buttons && buttons.length > 0 ? { kind: 'message', slot, text, buttons } : { kind: 'message', slot, text };
}

function renderJudge(session: MatchSession): Draft[] {
  const { issued, config } = session;
  const drafts: Draft[] = [
    message('panel:lobby', lobbyText(session), issued.length === 0 ? currentButtons(session) : undefined),
  ];

  issued.forEach((track, index) => {
    const song = config.library.find((s) => s.id === track.songId)!;
    const isCurrent = index === issued.length - 1;
    const startHint = !song.audioFileId && song.startSec ? judgeTexts(session).startAt({ start: formatClock(song.startSec) }) : '';
    drafts.push({
      kind: 'message',
      slot: `audio:${index}`,
      text: startHint,
      audio: { title: `Трек ${track.number}`, performer: 'Музыкальный турнир', url: song.audioUrl, fileId: song.audioFileId },
    });
    drafts.push(message(`answers:${index}`, answersText(session, track.number, song)));
    drafts.push(
      message(
        `panel:${index}`,
        isCurrent ? currentPanelText(session) : pastTrackText(session, index),
        isCurrent ? currentButtons(session) : [],
      ),
    );
  });

  return drafts;
}

// Тексты судьи — в его стиле.
function judgeTexts(session: MatchSession): Texts['match']['judge'] {
  return tx(session, session.config.judge.id).judge;
}

function lobbyText(session: MatchSession): string {
  const { config, match } = session;
  const { ruleset } = config;
  const [p0, p1] = config.players;
  const texts = judgeTexts(session);
  const lines = [
    texts.title({ final: config.stage === 'final', match: config.matchNo }),
    `${p0.name} — ${p1.name}`,
    '',
    ...formatLines(texts, ruleset),
    texts.points({ artist: formatPoints(ruleset.artistPoints), title: formatPoints(ruleset.titlePoints) }),
  ];
  const { phase } = match;
  if (phase.kind === 'lobby') {
    lines.push(
      '',
      texts.whoIsHere({
        judge: mark(phase.judgeReady),
        p0: `${p0.name} ${mark(phase.playersReady[0])}`,
        p1: `${p1.name} ${mark(phase.playersReady[1])}`,
      }),
    );
    const available = eligibleForMatch(session).length;
    const needed = minSongsForMatch(ruleset);
    if (available < needed) lines.push(texts.fewSongs({ available, needed }));
  } else if (phase.kind === 'suspended' && session.issued.length === 0) {
    lines.push('', texts.suspended);
  } else {
    lines.push('', texts.allHere);
  }
  if (match.paused && session.issued.length === 0) lines.push('', texts.paused({ n: 0 }));
  return lines.join('\n');
}

function formatLines(texts: Texts['match']['judge'], ruleset: Ruleset): string[] {
  const { format } = ruleset;
  if (format.kind === 'first_to') return [texts.firstTo({ points: formatPoints(format.winThreshold) }), texts.limit({ tracks: format.trackLimit })];
  // Без отрыва (турниры прошлых версий или «любой») — прежняя строка про ничью.
  const lead = minLeadOf(format);
  return [texts.fixed({ tracks: format.tracks }), lead > 0 ? texts.fixedLead({ lead: formatPoints(lead) }) : texts.fixedTie];
}

function answersText(session: MatchSession, number: number, song: LibrarySong): string {
  const texts = judgeTexts(session);
  const lines = [texts.answers({ n: number }), texts.artist({ artist: song.artist }), texts.songTitle({ title: song.title })];
  if (song.acceptedAnswers?.length) lines.push(texts.alsoAccepted({ answers: song.acceptedAnswers.join('; ') }));
  return lines.join('\n');
}

function scoreLine(session: MatchSession, score: [number, number]): string {
  const [p0, p1] = session.config.players;
  return `${p0.name} ${formatPoints(score[0])} : ${formatPoints(score[1])} ${p1.name}`;
}

function awardsLine(session: MatchSession, awards: { artist: PlayerSlot | null; title: PlayerSlot | null }): string {
  const name = (slot: PlayerSlot | null) => (slot === null ? '—' : session.config.players[slot].name);
  return judgeTexts(session).awards({ artist: name(awards.artist), title: name(awards.title) });
}

// progress — строки хода матча («Сыграно 2 из 3», «Отрыв меньше 2,0 — дополнительный трек 1») для
// текущей панели: они идут до слова о неугаданном треке, чтобы оно (а в стиле «Диско» — голос) стояло в конце.
function pastTrackText(session: MatchSession, index: number, progress: string[] = []): string {
  const track = session.issued[index]!;
  const texts = judgeTexts(session);
  const cancelled = session.match.cancelledTracks.find((t) => t.songId === track.songId);
  if (cancelled) return [texts.cancelled({ n: track.number }), ...progress].join('\n');
  const closedIndex = session.match.closedTracks.findIndex((t) => t.songId === track.songId);
  const closed = session.match.closedTracks[closedIndex]!;
  const scoreAfter = scoreOf(session.match.closedTracks.slice(0, closedIndex + 1), session.config.ruleset);
  const lines = [texts.closed({ n: track.number }), awardsLine(session, closed.awards), scoreLine(session, scoreAfter), ...progress];
  const nobody = closed.awards.artist === null && closed.awards.title === null && texts.nobody({ n: track.number });
  if (nobody) lines.push(nobody);
  return lines.join('\n');
}

function currentPanelText(session: MatchSession): string {
  const { match, config } = session;
  const { phase } = match;
  const lines: string[] = [];
  const last = session.issued.at(-1)!;
  const texts = judgeTexts(session);

  if (phase.kind === 'track') {
    lines.push(
      phase.track.started ? texts.playing({ n: last.number }) : texts.ready({ n: last.number }),
      scoreLine(session, liveScore(match)),
    );
    if (phase.track.started) {
      lines.push(awardsLine(session, phase.track.awards));
    } else {
      lines.push('', texts.startHint({ n: last.number }));
    }
  } else {
    const played = match.closedTracks.length;
    const regular = regularTracks(config.ruleset.format);
    const lead = minLeadOf(config.ruleset.format);
    // После основной части с отрывом счёт может быть и неравным — тогда это не «ничья».
    const extra = (n: number) => (lead > 0 ? texts.extraLead({ n, lead: formatPoints(lead) }) : texts.extra({ n }));
    const progress =
      phase.kind === 'between_tracks'
        ? [played < regular ? texts.played({ played, of: regular }) : extra(played - regular + 1)]
        : [];
    lines.push(pastTrackText(session, session.issued.length - 1, progress));
    lines.push(...outcomeLines(session));
  }
  if (match.paused) lines.push('', texts.paused({ n: session.issued.length }));
  return lines.join('\n');
}

function outcomeLines(session: MatchSession): string[] {
  const texts = judgeTexts(session);
  const { phase } = session.match;
  const [p0, p1] = session.config.players;
  const score = scoreOf(session.match.closedTracks, session.config.ruleset);
  switch (phase.kind) {
    case 'decided': {
      const pending = [
        !phase.playersConfirmed[0] && p0.name,
        !phase.playersConfirmed[1] && p1.name,
      ].filter(Boolean);
      return [
        '',
        texts.winner({ name: session.config.players[phase.winner].name }),
        scoreLine(session, score),
        phase.judgeConfirmed ? texts.waitConfirm({ names: pending.join(', ') }) : texts.confirm({ match: session.config.matchNo }),
      ];
    }
    case 'finished':
      return ['', texts.confirmed({ name: session.config.players[phase.winner].name })];
    case 'suspended':
      return ['', texts.suspended];
    default:
      return [];
  }
}

function currentButtons(session: MatchSession): Button[][] {
  const { match, config } = session;
  const v = `|v${match.version}`;
  const button = (label: string, action: string): Button => ({ label, data: `${action}${v}` });
  const texts = tx(session, config.judge.id).buttons;

  if (match.paused) return [[button(texts.resume, 'resume')]];

  const { phase } = match;
  switch (phase.kind) {
    case 'lobby':
      return phase.judgeReady ? [] : [[button(texts.allHere, 'ready')]];
    case 'between_tracks':
      return [[button(texts.issue({ n: match.closedTracks.length + 1 }), 'issue')], [button(texts.pause, 'pause')]];
    case 'track': {
      const { track } = phase;
      if (!track.started) {
        return [[button(texts.start, 'start')], [button(texts.audioError, 'audioError'), button(texts.pause, 'pause')]];
      }
      const labels: Record<Component, { open: (p: { points: string }) => string; done: string }> = {
        artist: { open: texts.artist, done: texts.artistDone },
        title: { open: texts.title, done: texts.titleDone },
      };
      const componentRow = (component: Component, code: string, points: number): Button[] =>
        ([0, 1] as const).map((slot) => {
          const owner = track.awards[component];
          if (owner === null) return button(labels[component].open({ points: formatPoints(points) }), `aw:${code}:${slot}`);
          return { label: owner === slot ? labels[component].done : '—', data: NOOP };
        });
      const nothingAwarded = track.awards.artist === null && track.awards.title === null;
      const rows: Button[][] = [
        config.players.map((p) => ({ label: p.name, data: NOOP })),
        componentRow('artist', 'a', config.ruleset.artistPoints),
        componentRow('title', 't', config.ruleset.titlePoints),
      ];
      if (track.awardOrder.length > 0) rows.push([button(texts.undo, 'undo')]);
      rows.push([nothingAwarded ? button(texts.nobody, 'none') : button(texts.close, 'close')]);
      rows.push([button(texts.pause, 'pause'), button(texts.audioError, 'audioError')]);
      return rows;
    }
    case 'decided':
      return phase.judgeConfirmed ? [] : [[button(texts.confirm, 'confirm')]];
    default:
      return [];
  }
}

function renderPlayerStatus(session: MatchSession, slot: PlayerSlot): Draft {
  const { config, match } = session;
  const opponent = config.players[slot === 0 ? 1 : 0];
  const { player: texts, buttons } = tx(session, config.players[slot].id);
  const header = texts.header({ match: config.matchNo, opponent: opponent.name, judge: config.judge.name });
  const score = scoreLine(session, scoreOf(match.closedTracks, config.ruleset));
  const { phase } = match;
  const paused = match.paused ? `\n${texts.paused}` : '';

  switch (phase.kind) {
    case 'lobby':
      return phase.playersReady[slot]
        ? message('status', `${header}\n\n${texts.here({ match: config.matchNo })}${paused}`)
        : message('status', `${header}\n\n${texts.comeIn({ match: config.matchNo })}${paused}`, [[{ label: buttons.here, data: 'ready' }]]);
    case 'between_tracks':
    case 'track':
      return message('status', `${header}\n\n${texts.played({ count: match.closedTracks.length })}\n${score}${paused}`);
    case 'decided': {
      const result = `${header}\n\n${texts.winner({ name: config.players[phase.winner].name })}\n${score}`;
      if (!phase.judgeConfirmed) return message('status', `${result}\n${texts.waitJudge}`);
      if (phase.playersConfirmed[slot]) return message('status', `${result}\n${texts.confirmed}`);
      return message('status', result, [[{ label: buttons.confirmPlayer, data: 'confirm' }]]);
    }
    case 'finished': {
      const cheer = (phase.winner === slot ? texts.won : texts.lost)({ match: config.matchNo });
      const lines = [`${header}\n\n${texts.finished({ name: config.players[phase.winner].name })}\n${score}`, ...(cheer ? [cheer] : [])];
      return message('status', lines.join('\n\n'));
    }
    case 'suspended':
      return message('status', `${header}\n\n${texts.suspended}\n${score}`);
  }
}

function mark(ready: boolean): string {
  return ready ? '✅' : '⏳';
}
