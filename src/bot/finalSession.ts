import {
  buildFinalBracket,
  findMatch,
  openMatches,
  playersOf,
  qualified,
  type Bracket,
  type BracketMatch,
  type Results,
} from '../domain/bracket/bracket.ts';
import { scoreOf, usedSongIds } from '../domain/match/match.ts';
import { formatPoints, type Ruleset } from '../domain/match/ruleset.ts';
import { seededRandom, shuffled } from '../shared/random.ts';
import {
  handleIncoming,
  openMatchSession,
  type LibrarySong,
  type MatchSession,
  type Participant,
} from './matchSession.ts';
import type { Button, Incoming, Outgoing, OutgoingMessage, UserId } from './protocol.ts';

// Финал через бота (docs/decisions/2026-10-08-mechanics-revision.md, разделы 1–2): очный,
// судит не участник, пары 8 → 4 → 2 → 1. Выдача — из одной очереди с зафиксированным seed:
// каждый матч берёт следующую песню, пропуская песни двух игроков на сцене; прозвучавшее
// в финале больше не выдаётся. Та же очередь уходит в офлайн-комплект на случай пропажи сети.

export interface FinalSessionConfig {
  // В порядке посева: 1–2, 3–4, 5–6, 7–8.
  finalists: Participant[];
  judge: Participant;
  organizer: Participant;
  // Кто действует в симуляторе; за остальных финалистов готовность и подтверждения ставятся сами.
  interactive: UserId[];
  library: LibrarySong[];
  ruleset: Ruleset;
  seed: number;
}

interface CurrentMatch {
  matchId: string;
  session: MatchSession;
}

type OrganizerMode = { kind: 'idle' } | { kind: 'paperMatch' } | { kind: 'paperWinner'; matchId: string };

export interface FinalSession {
  config: FinalSessionConfig;
  bracket: Bracket;
  queue: string[];
  results: Results;
  current: CurrentMatch | null;
  // Песни, уже прозвучавшие в финале: никому больше не выдаются.
  played: string[];
  journal: string[];
  mode: OrganizerMode;
}

export interface FinalStep {
  session: FinalSession;
  out: Outgoing[];
}

export function openFinalSession(config: FinalSessionConfig): FinalStep {
  const session: FinalSession = {
    config,
    bracket: buildFinalBracket(config.finalists.map((p) => p.id)),
    queue: shuffled(
      config.library.map((s) => s.id),
      seededRandom(config.seed),
    ),
    results: {},
    current: null,
    played: [],
    journal: [`Очередь финала: ${config.library.length} песен, seed ${config.seed}`],
    mode: { kind: 'idle' },
  };
  return { session, out: [renderOrganizer(session)] };
}

export function handleFinal(session: FinalSession, input: Incoming): FinalStep {
  if (input.kind !== 'button') return { session, out: [] };
  const before = renderOrganizer(session);

  let next = session;
  let out: Outgoing[] = [];
  if (input.from === session.config.organizer.id) {
    const result = handleOrganizer(session, input.data);
    if ('toast' in result) return { session, out: [{ kind: 'toast', to: input.from, text: result.toast }] };
    ({ session: next, out } = result);
  } else if (session.current) {
    ({ session: next, out } = delegate(session, input));
  } else {
    return { session, out: [{ kind: 'toast', to: input.from, text: 'Сейчас на сцене никого нет' }] };
  }

  const settled = settle(next);
  next = settled.session;
  out = [...out, ...settled.out];
  const organizer = renderOrganizer(next);
  if (JSON.stringify(organizer) !== JSON.stringify(before)) out = [...out, organizer];
  return { session: next, out: out.filter((o) => isVisible(next, o)) };
}

type OrganizerResult = FinalStep | { toast: string };

function handleOrganizer(session: FinalSession, data: string): OrganizerResult {
  const start = /^start:(.+)$/.exec(data);
  if (start) {
    if (session.current) return { toast: 'На сцене уже идёт матч' };
    const matchId = start[1]!;
    const pair = playersOf(session.bracket, session.results, matchId);
    if (!pair || session.results[matchId]) return { toast: 'Этот матч сейчас не открыть' };
    const [a, b] = pair.map((id) => person(session, id)) as [Participant, Participant];
    const opened = openMatchSession({
      stage: 'final',
      matchNo: matchNumber(session, matchId),
      players: [a, b],
      judge: session.config.judge,
      library: session.config.library,
      ruleset: session.config.ruleset,
      seed: session.config.seed,
      excludedSongIds: session.played,
      queue: session.queue,
    });
    const current = { matchId, session: opened.session };
    const journal = [...session.journal, `На сцене: ${matchTitle(session, matchId)}`];
    return { session: { ...session, current, journal, mode: { kind: 'idle' } }, out: scoped(matchId, opened.out) };
  }

  if (data === 'kit') return { session, out: [offlineKit(session)] };

  if (data === 'paper') {
    if (openMatches(session.bracket, session.results).length === 0) return { toast: 'Нет открытых матчей' };
    return { session: { ...session, mode: { kind: 'paperMatch' } }, out: [] };
  }
  if (data === 'cancel') return { session: { ...session, mode: { kind: 'idle' } }, out: [] };

  const paperMatch = /^paper:(.+)$/.exec(data);
  if (paperMatch) return { session: { ...session, mode: { kind: 'paperWinner', matchId: paperMatch[1]! } }, out: [] };

  const paperWinner = /^winner:(.+)$/.exec(data);
  if (paperWinner && session.mode.kind === 'paperWinner') {
    const { matchId } = session.mode;
    const winner = paperWinner[1]!;
    if (!playersOf(session.bracket, session.results, matchId)?.includes(winner)) return { toast: 'Это не игрок матча' };
    const journal = [
      ...session.journal,
      `Результат с бумаги: ${matchTitle(session, matchId)} — победа ${person(session, winner).name} (внёс организатор)`,
    ];
    const current = session.current?.matchId === matchId ? null : session.current;
    return {
      session: { ...session, results: { ...session.results, [matchId]: winner }, journal, current, mode: { kind: 'idle' } },
      out: [],
    };
  }
  return { toast: 'Сейчас это действие недоступно' };
}

function delegate(session: FinalSession, input: Incoming): FinalStep {
  const current = session.current!;
  const step = handleIncoming(current.session, input);
  return { session: { ...session, current: { ...current, session: step.session } }, out: scoped(current.matchId, step.out) };
}

// Автодействия финалистов без колонки в симуляторе и фиксация завершённого матча.
function settle(session: FinalSession): FinalStep {
  const out: Outgoing[] = [];
  for (let guard = 0; guard < 4 && session.current; guard++) {
    const { match, config } = session.current.session;
    const { phase } = match;
    const background = config.players
      .map((p, slot) => ({ p, slot }))
      .filter(({ p }) => !session.config.interactive.includes(p.id));
    const pending = background.find(({ slot }) =>
      phase.kind === 'lobby'
        ? !phase.playersReady[slot]
        : phase.kind === 'decided' && phase.judgeConfirmed && !phase.playersConfirmed[slot],
    );
    if (!pending) break;
    const data = phase.kind === 'lobby' ? 'ready' : 'confirm';
    const step = delegate(session, { kind: 'button', from: pending.p.id, data });
    session = step.session;
    out.push(...step.out);
  }

  const current = session.current;
  if (current?.session.match.phase.kind === 'finished') {
    const { phase } = current.session.match;
    const winner = current.session.config.players[phase.winner].id;
    const score = scoreOf(current.session.match.closedTracks, current.session.config.ruleset);
    const journal = [
      ...session.journal,
      `${matchTitle(session, current.matchId)}: ${formatPoints(score[0])} : ${formatPoints(score[1])}, победа ${person(session, winner).name}`,
    ];
    return {
      session: {
        ...session,
        results: { ...session.results, [current.matchId]: winner },
        played: [...session.played, ...usedSongIds(current.session.match)],
        current: null,
        journal,
      },
      out,
    };
  }
  return { session, out };
}

// Сообщения разных матчей у судьи не должны править друг друга: slot получает префикс матча.
function scoped(matchId: string, out: Outgoing[]): Outgoing[] {
  return out.map((o) => (o.kind === 'message' && o.slot ? { ...o, slot: `${matchId}:${o.slot}` } : o));
}

function isVisible(session: FinalSession, o: Outgoing): boolean {
  const { config } = session;
  return o.to === config.judge.id || o.to === config.organizer.id || config.interactive.includes(o.to);
}

// --- Офлайн-комплект ------------------------------------------------------------

function offlineKit(session: FinalSession): OutgoingMessage {
  const played = new Set(session.played);
  const position = session.queue.findIndex((id) => !played.has(id)) + 1;
  const owners = (song: LibrarySong) =>
    song.ownerIds.map((id) => session.config.finalists.find((p) => p.id === id)?.name ?? 'не финалист').join(', ');
  const rows = session.queue.map((id, index) => {
    const song = session.config.library.find((s) => s.id === id)!;
    const cells = [
      String(index + 1).padStart(3, '0'),
      song.artist,
      song.title,
      (song.acceptedAnswers ?? []).join(' / '),
      owners(song),
      played.has(id) ? 'сыграна' : '',
    ];
    return cells.map((c) => `"${c.replace(/"/g, '""')}"`).join(';');
  });
  const csv = ['"№";"Исполнитель";"Название";"Допустимо";"Чья песня";"Статус"', ...rows].join('\n');
  return {
    kind: 'message',
    to: session.config.organizer.id,
    text: [
      '📦 Офлайн-комплект финала',
      '',
      `Лист судьи по очереди: ${session.queue.length} песен, продолжать с позиции ${position}.`,
      'Правило то же, что в боте: следующая по очереди, пропуская песни двух игроков на сцене и уже сыгранные.',
      'Аудио — папка пронумерованных обезличенных фрагментов в том же порядке (в демо не входит).',
      'После восстановления связи внесите результаты кнопкой «✍️ С бумаги».',
    ].join('\n'),
    document: { fileName: 'final-judge-sheet.csv', mimeType: 'text/csv', content: csv },
  };
}

// --- Рендер ---------------------------------------------------------------------

function renderOrganizer(session: FinalSession): OutgoingMessage {
  const { bracket, results, current } = session;
  const lines = ['🏆 Финал · 8 → 4 → 2 → 1', `Судья финала: ${session.config.judge.name} (не участник турнира)`, ''];
  const titles = ['Четвертьфиналы', 'Полуфиналы', 'Финал'];
  bracket.rounds.forEach((round, r) => {
    lines.push(titles[r] ?? `Круг ${r + 1}`);
    for (const match of round) {
      const winner = results[match.id];
      const pair = playersOf(bracket, results, match.id);
      const sides = pair
        ? pair.map((id) => `${person(session, id).name}${winner === id ? ' 🏅' : ''}`).join(' — ')
        : 'ждём соперников';
      const mark = current?.matchId === match.id ? ' 🎤 на сцене' : '';
      lines.push(`  ${sides}${mark}`);
    }
  });

  if (current) {
    const { match, config } = current.session;
    const score = scoreOf(match.closedTracks, config.ruleset);
    lines.push('', `🎤 Сейчас: ${config.players[0].name} ${formatPoints(score[0])} : ${formatPoints(score[1])} ${config.players[1].name}`);
  }
  const champion = qualified(bracket, results)[0];
  if (champion) lines.push('', `🏆 Победитель турнира: ${person(session, champion).name}`);

  const played = new Set(session.played);
  const position = session.queue.findIndex((id) => !played.has(id)) + 1;
  lines.push('', `Очередь песен: ${session.queue.length}, сыграно ${session.played.length}, следующая позиция ${position}`);
  lines.push('', '🗒 Журнал:', ...session.journal.slice(-4).map((entry) => `• ${entry}`));

  return { kind: 'message', to: session.config.organizer.id, slot: 'final', text: lines.join('\n'), buttons: organizerButtons(session) };
}

function organizerButtons(session: FinalSession): Button[][] | undefined {
  const { mode } = session;
  if (mode.kind === 'paperMatch') {
    const rows = openMatches(session.bracket, session.results).map((m) => [
      { label: pairTitle(session, m.id), data: `paper:${m.id}` },
    ]);
    return [...rows, [{ label: 'Отмена', data: 'cancel' }]];
  }
  if (mode.kind === 'paperWinner') {
    const pair = playersOf(session.bracket, session.results, mode.matchId) ?? [];
    return [pair.map((id) => ({ label: `🏅 ${person(session, id).name}`, data: `winner:${id}` })), [{ label: 'Отмена', data: 'cancel' }]];
  }

  const rows: Button[][] = [];
  if (!session.current) {
    const next = openMatches(session.bracket, session.results)[0];
    if (next) rows.push([{ label: `▶️ На сцену: ${pairTitle(session, next.id)}`, data: `start:${next.id}` }]);
  }
  if (qualified(session.bracket, session.results).length === 0) {
    rows.push([
      { label: '📦 Комплект', data: 'kit' },
      { label: '✍️ С бумаги', data: 'paper' },
    ]);
  }
  return rows.length ? rows : undefined;
}

function matchTitle(session: FinalSession, matchId: string): string {
  const match = findMatch(session.bracket, matchId) as BracketMatch;
  const stage = ['Четвертьфинал', 'Полуфинал', 'Финал'][match.round - 1];
  const pair = playersOf(session.bracket, session.results, matchId);
  return pair ? `${stage}: ${pair.map((id) => person(session, id).name).join(' — ')}` : (stage ?? matchId);
}

function pairTitle(session: FinalSession, matchId: string): string {
  const pair = playersOf(session.bracket, session.results, matchId) ?? [];
  return pair.map((id) => person(session, id).name).join(' — ');
}

function matchNumber(session: FinalSession, matchId: string): number {
  return session.bracket.rounds.flat().findIndex((m) => m.id === matchId) + 1;
}

function person(session: FinalSession, id: UserId): Participant {
  return session.config.finalists.find((p) => p.id === id)!;
}
