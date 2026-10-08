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
import { formatPoints, regularTracks, type Ruleset } from '../domain/match/ruleset.ts';
import { eligibleSongs, pickLeastUsed, type PoolSong } from '../domain/selection/pickSong.ts';
import { seededRandom } from '../shared/random.ts';
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
}

export interface MatchSessionConfig {
  stage: 'qualifier' | 'final';
  matchNo: number;
  players: [Participant, Participant];
  judge: Participant;
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

const ERROR_TEXT: Record<MatchError, string> = {
  paused: 'Матч на паузе',
  not_paused: 'Матч не на паузе',
  wrong_phase: 'Сейчас это действие недоступно',
  already_ready: 'Готовность уже отмечена',
  track_not_started: 'Сначала нажмите «Начать трек»',
  track_already_started: 'Трек уже начат',
  component_taken: 'Этот ответ уже присуждён',
  nothing_to_undo: 'Нечего отменять',
  awards_present: 'Есть присуждённые ответы — закройте трек',
  judge_must_confirm_first: 'Сначала результат подтверждает судья',
  already_confirmed: 'Результат уже подтверждён',
};

const COMPONENT_LABEL: Record<Component, string> = { artist: 'Исполнитель', title: 'Название' };

// Запас на основную часть матча и несколько дополнительных треков при ничьей.
export function minSongsForMatch(ruleset: Ruleset): number {
  return regularTracks(ruleset.format) + 5;
}

export function openMatchSession(config: MatchSessionConfig): SessionStep {
  const session: MatchSession = { config, match: createMatch(config.ruleset), issued: [] };
  return { session, out: render(session) };
}

export function handleIncoming(session: MatchSession, input: Incoming): SessionStep {
  // Во время матча бот реагирует только на кнопки.
  if (input.kind !== 'button') return { session, out: [] };
  const actor = actorOf(session.config, input.from);
  if (actor === undefined) return reply(session, input.from, 'Вы не участник этого матча');
  if (input.data === NOOP) return { session, out: [] };

  const [action, versionTag] = input.data.split('|');
  if (actor === 'judge') {
    // Устаревшая кнопка не применяется: судья видит актуальную панель.
    if (versionTag !== `v${session.match.version}`) {
      return reply(session, input.from, 'Панель устарела — показываю актуальную');
    }
    return judgeAction(session, action!);
  }

  if (action === 'ready') return apply(session, { type: 'markReady', who: actor }, input.from);
  if (action === 'confirm') return apply(session, { type: 'confirmResult', who: actor }, input.from);
  return reply(session, input.from, 'Это действие доступно только судье');
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

  return reply(session, judgeId, 'Неизвестное действие');
}

function apply(session: MatchSession, command: MatchCommand, from: UserId): SessionStep {
  const result = applyCommand(session.match, command);
  if (!result.ok) return reply(session, from, ERROR_TEXT[result.error]);

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
  const { match, issued, config } = session;
  const drafts: Draft[] = [
    message('panel:lobby', lobbyText(session), issued.length === 0 ? currentButtons(session) : undefined),
  ];

  issued.forEach((track, index) => {
    const song = config.library.find((s) => s.id === track.songId)!;
    const isCurrent = index === issued.length - 1;
    drafts.push({
      kind: 'message',
      slot: `audio:${index}`,
      text: '',
      audio: { title: `Трек ${track.number}`, performer: 'Музыкальный турнир', url: song.audioUrl },
    });
    drafts.push(message(`answers:${index}`, answersText(track.number, song)));
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

function lobbyText(session: MatchSession): string {
  const { config, match } = session;
  const { ruleset } = config;
  const [p0, p1] = config.players;
  const lines = [
    `${config.stage === 'final' ? 'Финал' : 'Отбор'} · матч №${config.matchNo} · вы судья`,
    `${p0.name} — ${p1.name}`,
    '',
    ...formatLines(ruleset),
    `Исполнитель ${formatPoints(ruleset.artistPoints)} · Название ${formatPoints(ruleset.titlePoints)}`,
  ];
  const { phase } = match;
  if (phase.kind === 'lobby') {
    lines.push(
      '',
      `Готовность: судья ${mark(phase.judgeReady)}, ${p0.name} ${mark(phase.playersReady[0])}, ${p1.name} ${mark(phase.playersReady[1])}`,
    );
    const available = eligibleForMatch(session).length;
    const needed = minSongsForMatch(ruleset);
    if (available < needed) {
      lines.push(`⚠️ Подходящих песен ${available}, нужно минимум ${needed}. Сообщите организатору.`);
    }
  } else if (phase.kind === 'suspended' && session.issued.length === 0) {
    lines.push('', SUSPENDED_TEXT);
  } else {
    lines.push('', 'Все на месте ✅');
  }
  if (match.paused && session.issued.length === 0) lines.push('', '⏸ Пауза');
  return lines.join('\n');
}

const SUSPENDED_TEXT = '⛔ Подходящие песни закончились. Матч остановлен до решения организатора.';

export function formatLines(ruleset: Ruleset): string[] {
  const { format } = ruleset;
  if (format.kind === 'fixed') {
    return [`${format.tracks} треков, побеждает тот, у кого больше очков`, 'При равенстве — по одному треку до разрыва'];
  }
  return [
    `Победа: ${formatPoints(format.winThreshold)} после закрытия трека при преимуществе`,
    `Лимит: ${format.trackLimit} треков, при равенстве — по одному треку до разрыва`,
  ];
}

function answersText(number: number, song: LibrarySong): string {
  const lines = [`🔒 Ответы · трек ${number}`, `Исполнитель: ${song.artist}`, `Название: ${song.title}`];
  if (song.acceptedAnswers?.length) lines.push(`Также принимается: ${song.acceptedAnswers.join('; ')}`);
  return lines.join('\n');
}

function scoreLine(session: MatchSession, score: [number, number]): string {
  const [p0, p1] = session.config.players;
  return `${p0.name} ${formatPoints(score[0])} : ${formatPoints(score[1])} ${p1.name}`;
}

function awardsLine(session: MatchSession, awards: { artist: PlayerSlot | null; title: PlayerSlot | null }): string {
  const name = (slot: PlayerSlot | null) => (slot === null ? '—' : session.config.players[slot].name);
  return `Исполнитель: ${name(awards.artist)} · Название: ${name(awards.title)}`;
}

function pastTrackText(session: MatchSession, index: number): string {
  const track = session.issued[index]!;
  const cancelled = session.match.cancelledTracks.find((t) => t.songId === track.songId);
  if (cancelled) return `Трек ${track.number} — технически отменён (ошибка аудио)`;
  const closedIndex = session.match.closedTracks.findIndex((t) => t.songId === track.songId);
  const closed = session.match.closedTracks[closedIndex]!;
  const scoreAfter = scoreOf(session.match.closedTracks.slice(0, closedIndex + 1), session.config.ruleset);
  return [`Трек ${track.number} закрыт`, awardsLine(session, closed.awards), scoreLine(session, scoreAfter)].join(
    '\n',
  );
}

function currentPanelText(session: MatchSession): string {
  const { match, config } = session;
  const { phase } = match;
  const lines: string[] = [];
  const last = session.issued.at(-1)!;

  if (phase.kind === 'track') {
    lines.push(
      phase.track.started ? `▶️ Трек ${last.number} идёт` : `Трек ${last.number} выдан`,
      scoreLine(session, liveScore(match)),
    );
    if (phase.track.started) {
      lines.push(awardsLine(session, phase.track.awards));
    } else {
      lines.push('', 'Аудио и ответы выше. Включите трек и нажмите «Начать трек».');
    }
  } else {
    lines.push(pastTrackText(session, session.issued.length - 1));
    const played = match.closedTracks.length;
    const regular = regularTracks(config.ruleset.format);
    if (phase.kind === 'between_tracks') {
      lines.push(
        played < regular
          ? `Сыграно ${played} из ${regular}`
          : `Равенство — дополнительный трек ${played - regular + 1}`,
      );
    }
    lines.push(...outcomeLines(session));
  }
  if (match.paused) lines.push('', '⏸ Пауза');
  return lines.join('\n');
}

function outcomeLines(session: MatchSession): string[] {
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
        `🏁 Победа: ${session.config.players[phase.winner].name}`,
        scoreLine(session, score),
        phase.judgeConfirmed ? `Ждём подтверждения: ${pending.join(', ')}` : 'Подтвердите результат матча.',
      ];
    }
    case 'finished':
      return ['', `✅ Результат подтверждён. Победа: ${session.config.players[phase.winner].name}`];
    case 'suspended':
      return ['', SUSPENDED_TEXT];
    default:
      return [];
  }
}

function currentButtons(session: MatchSession): Button[][] {
  const { match, config } = session;
  const v = `|v${match.version}`;
  const button = (label: string, action: string): Button => ({ label, data: `${action}${v}` });

  if (match.paused) return [[button('▶️ Продолжить', 'resume')]];

  const { phase } = match;
  switch (phase.kind) {
    case 'lobby':
      return phase.judgeReady ? [] : [[button('Все на месте', 'ready')]];
    case 'between_tracks':
      return [[button(`Выдать трек ${match.closedTracks.length + 1}`, 'issue')], [button('⏸ Пауза', 'pause')]];
    case 'track': {
      const { track } = phase;
      if (!track.started) {
        return [[button('▶️ Начать трек', 'start')], [button('⚠️ Ошибка аудио', 'audioError'), button('⏸ Пауза', 'pause')]];
      }
      const componentRow = (component: Component, code: string, points: number): Button[] =>
        ([0, 1] as const).map((slot) => {
          const owner = track.awards[component];
          if (owner === null) return button(`${COMPONENT_LABEL[component]} +${formatPoints(points)}`, `aw:${code}:${slot}`);
          return { label: owner === slot ? `✅ ${COMPONENT_LABEL[component]}` : '—', data: NOOP };
        });
      const nothingAwarded = track.awards.artist === null && track.awards.title === null;
      const rows: Button[][] = [
        config.players.map((p) => ({ label: p.name, data: NOOP })),
        componentRow('artist', 'a', config.ruleset.artistPoints),
        componentRow('title', 't', config.ruleset.titlePoints),
      ];
      if (track.awardOrder.length > 0) rows.push([button('↩️ Отменить последнее', 'undo')]);
      rows.push([nothingAwarded ? button('Никто не угадал', 'none') : button('✅ Закрыть трек', 'close')]);
      rows.push([button('⏸ Пауза', 'pause'), button('⚠️ Ошибка аудио', 'audioError')]);
      return rows;
    }
    case 'decided':
      return phase.judgeConfirmed ? [] : [[button('Подтвердить результат', 'confirm')]];
    default:
      return [];
  }
}

function renderPlayerStatus(session: MatchSession, slot: PlayerSlot): Draft {
  const { config, match } = session;
  const opponent = config.players[slot === 0 ? 1 : 0];
  const header = `Матч №${config.matchNo} · соперник: ${opponent.name} · судья: ${config.judge.name}`;
  const score = scoreLine(session, scoreOf(match.closedTracks, config.ruleset));
  const { phase } = match;
  const paused = match.paused ? '\n⏸ Пауза' : '';

  switch (phase.kind) {
    case 'lobby':
      return phase.playersReady[slot]
        ? message('status', `${header}\n\n✅ Вы готовы, ждём остальных${paused}`)
        : message('status', `${header}\n\nКогда будете на месте, подтвердите готовность.${paused}`, [
            [{ label: 'Я на месте', data: 'ready' }],
          ]);
    case 'between_tracks':
    case 'track':
      return message('status', `${header}\n\nСыграно треков: ${match.closedTracks.length}\n${score}${paused}`);
    case 'decided': {
      const result = `${header}\n\n🏁 Победа: ${config.players[phase.winner].name}\n${score}`;
      if (!phase.judgeConfirmed) return message('status', `${result}\nЖдём подтверждения судьи.`);
      if (phase.playersConfirmed[slot]) return message('status', `${result}\n✅ Вы подтвердили результат.`);
      return message('status', result, [[{ label: 'Подтверждаю результат', data: 'confirm' }]]);
    }
    case 'finished':
      return message('status', `${header}\n\n✅ Матч завершён. Победа: ${config.players[phase.winner].name}\n${score}`);
    case 'suspended':
      return message('status', `${header}\n\n⛔ Матч остановлен: закончились подходящие песни. Ждём решения организатора.\n${score}`);
  }
}

function mark(ready: boolean): string {
  return ready ? '✅' : '⏳';
}
