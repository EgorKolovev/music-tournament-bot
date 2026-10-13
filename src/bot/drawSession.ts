import {
  buildQualifierBracket,
  findMatch,
  playedMatches,
  qualified,
  resolveSlot,
  type Bracket,
  type BracketMatch,
  type Results,
  type Slot,
} from '../domain/bracket/bracket.ts';
import { plural } from '../shared/text.ts';
import type { Participant } from './matchSession.ts';
import type { Button, Incoming, Outgoing, OutgoingMessage, UserId } from './protocol.ts';

// Жеребьёвка и подготовка пар (docs/decisions/2026-10-08-mechanics-revision.md, разделы 7–8):
// карточка пары сразу показывает соперника с контактом, судью игроки выбирают из уже
// зарегистрированных, сроки админ сдвигает командой в боте с записью в журнал.

export interface DrawSessionConfig {
  players: Participant[];
  // Симулятор: кто действует в колонках; остальным сообщения не рендерятся, а их согласие
  // судить ставится само. В боте не задаётся — все люди настоящие.
  interactive?: UserId[];
  // Зарегистрированные в боте, кого можно позвать судьёй (игроки, выбывшие, гости).
  registered: Participant[];
  usernames: Record<UserId, string>;
  organizer: Participant;
  finalists: number;
  seed: number;
  // Сроки кругов отбора, ISO-даты.
  deadlines: string[];
  botUsername: string;
}

interface JudgeAssignment {
  // Не задан, если судья пришёл по ссылке-приглашению.
  proposedBy?: UserId;
  candidate: UserId;
  accepted: boolean;
  confirmedBy: UserId[];
}

type Mode = { kind: 'idle' } | { kind: 'pickJudge' };

export interface DrawSession {
  config: DrawSessionConfig;
  bracket: Bracket | null;
  // Подтверждённые результаты матчей отбора: matchId → победитель.
  results: Results;
  deadlines: string[];
  judges: Record<string, JudgeAssignment>;
  modes: Record<UserId, Mode>;
  journal: string[];
  // Разовые уведомления, отправляемые новыми сообщениями (не правкой карточки).
  notifications: OutgoingMessage[];
}

export interface DrawStep {
  session: DrawSession;
  out: Outgoing[];
}

const MAX_JUDGE_SUGGESTIONS = 6;

export function openDrawSession(config: DrawSessionConfig): DrawStep {
  const session: DrawSession = {
    config,
    bracket: null,
    results: {},
    deadlines: config.deadlines,
    judges: {},
    modes: {},
    journal: [],
    notifications: [],
  };
  return { session, out: render(session) };
}

export function handleDraw(session: DrawSession, input: Incoming): DrawStep {
  if (input.kind !== 'button') return { session, out: [] };
  const before = render(session);
  const result =
    input.from === session.config.organizer.id
      ? handleOrganizer(session, input.data)
      : handlePlayer(session, input.from, input.data);
  if ('toast' in result) return { session, out: [{ kind: 'toast', to: input.from, text: result.toast }] };

  return emit(result.session, before);
}

function emit(next: DrawSession, before: OutgoingMessage[]): DrawStep {
  const previous = new Map(before.map((m) => [`${m.to}/${m.slot}`, JSON.stringify(m)]));
  const changed = render(next).filter((m) => previous.get(`${m.to}/${m.slot}`) !== JSON.stringify(m));
  return { session: { ...next, notifications: [] }, out: [...changed, ...next.notifications] };
}

// Результат подтверждённого матча (или технический результат организатора) двигает сетку.
export function recordResult(session: DrawSession, matchId: string, winner: UserId, note?: string): DrawStep {
  const before = render(session);
  const match = session.bracket && findMatch(session.bracket, matchId);
  if (!match || !playersIn(session, match).includes(winner)) return { session, out: [] };
  const journal = [...session.journal, `${matchLabel(match)}: победа ${nameOf(session, winner)}${note ? ` (${note})` : ''}`];
  return emit({ ...session, results: { ...session.results, [matchId]: winner }, journal }, before);
}

// Человек зарегистрировался после жеребьёвки — его можно звать судьёй.
export function registerPerson(session: DrawSession, person: Participant, username?: string): DrawStep {
  if (session.config.registered.some((p) => p.id === person.id)) return { session, out: [] };
  const before = render(session);
  const config = {
    ...session.config,
    registered: [...session.config.registered, person],
    usernames: username ? { ...session.config.usernames, [person.id]: `@${username}` } : session.config.usernames,
  };
  return emit({ ...session, config }, before);
}

// Игрок вышел до жеребьёвки: в сетку не попадёт, его карточка ожидания пары меняется.
export function removePlayer(session: DrawSession, userId: UserId): DrawStep {
  if (session.bracket) return { session, out: [] };
  const before = render(session);
  const players = session.config.players.filter((p) => p.id !== userId);
  const step = emit({ ...session, config: { ...session.config, players } }, before);
  const card: OutgoingMessage = { kind: 'message', to: userId, slot: 'card', text: '🚪 Ты вышел из турнира — в жеребьёвку не попадёшь.' };
  return { session: step.session, out: [...step.out, card] };
}

// Ссылка t.me/<бот>?start=judge_<matchId>: открывший её получает приглашение; согласие
// судьи и подтверждение обоих игроков всё равно нужны — знание ссылки прав не даёт.
export function inviteByLink(session: DrawSession, matchId: string, userId: UserId): DrawStep {
  const notice = (text: string): DrawStep => ({ session, out: [{ kind: 'message', to: userId, text }] });
  const match = session.bracket && findMatch(session.bracket, matchId);
  if (!match || match.isBye || session.results[matchId]) return notice('Это приглашение уже неактуально.');
  if (playersIn(session, match).includes(userId)) return notice('Это твой собственный матч — судить его нельзя.');
  const current = session.judges[matchId];
  if (current?.candidate === userId) return emit(session, []);
  if (current?.accepted) return notice('У этого матча уже есть судья.');
  if (!judgeCandidates(session, match).some((p) => p.id === userId)) {
    return notice('Сейчас ты не можешь судить этот матч: судья ведёт один матч за раз.');
  }
  const before = render(session);
  const assignment: JudgeAssignment = { candidate: userId, accepted: false, confirmedBy: [] };
  const journal = [...session.journal, `${nameOf(session, userId)} открыл ссылку судьи ${matchLabel(match)}`];
  return emit({ ...session, judges: { ...session.judges, [matchId]: assignment }, journal }, before);
}

// Судья матча, подтверждённый согласием и обоими игроками.
export function confirmedJudge(session: DrawSession, matchId: string): UserId | undefined {
  const assignment = session.judges[matchId];
  return assignment?.accepted && assignment.confirmedBy.length === 2 ? assignment.candidate : undefined;
}

export function matchPlayers(session: DrawSession, matchId: string): [UserId, UserId] | undefined {
  const match = session.bracket && findMatch(session.bracket, matchId);
  if (!match || match.isBye) return undefined;
  const players = playersIn(session, match);
  return players.length === 2 ? (players as [UserId, UserId]) : undefined;
}

function isInteractive(session: DrawSession, userId: UserId): boolean {
  return session.config.interactive?.includes(userId) ?? true;
}

type Result = { session: DrawSession } | { toast: string };

function handleOrganizer(session: DrawSession, data: string): Result {
  const { config } = session;
  if (data === 'draw') {
    if (session.bracket) return { toast: 'Жеребьёвка уже проведена' };
    const bracket = buildQualifierBracket(
      config.players.map((p) => p.id),
      config.finalists,
      config.seed,
    );
    const journal = [...session.journal, `Жеребьёвка: ${config.players.length} игроков, seed ${config.seed}`];
    return { session: { ...session, bracket, journal } };
  }

  const shift = /^shift:(\d+)$/.exec(data);
  if (shift && session.bracket) {
    const round = Number(shift[1]);
    const before = session.deadlines[round - 1]!;
    const after = addDays(before, 2);
    const deadlines = session.deadlines.map((d, i) => (i === round - 1 ? after : d));
    const journal = [...session.journal, `Организатор: срок ${round}-го круга ${formatDate(before)} → ${formatDate(after)}`];
    // Уведомляем только затронутых: участников матчей этого круга и их судей.
    const notifications: OutgoingMessage[] = [];
    for (const match of session.bracket.rounds[round - 1] ?? []) {
      if (match.isBye) continue;
      const people = [...playersIn(session, match), session.judges[match.id]?.accepted ? session.judges[match.id]!.candidate : undefined];
      for (const id of people) {
        if (!id || !isInteractive(session, id)) continue;
        notifications.push({
          kind: 'message',
          to: id,
          text: `📅 Срок матча ${matchLabel(match)} перенесён: до ${formatDate(after)} (было ${formatDate(before)}).`,
        });
      }
    }
    return { session: { ...session, deadlines, journal, notifications } };
  }
  return { toast: 'Сейчас это действие недоступно' };
}

function handlePlayer(session: DrawSession, from: UserId, data: string): Result {
  if (!session.bracket) return { toast: 'Жеребьёвки ещё не было' };

  if (data === 'pickJudge' || data === 'cancel') {
    const match = currentMatch(session, from);
    if (!match) return { toast: 'У тебя сейчас нет матча' };
    const mode: Mode = data === 'pickJudge' ? { kind: 'pickJudge' } : { kind: 'idle' };
    return { session: { ...session, modes: { ...session.modes, [from]: mode } } };
  }

  const judge = /^judge:(.+)$/.exec(data);
  if (judge) {
    const match = currentMatch(session, from);
    if (!match) return { toast: 'У тебя сейчас нет матча' };
    const candidate = judge[1]!;
    if (!judgeCandidates(session, match).some((p) => p.id === candidate)) return { toast: 'Этот человек не может судить матч' };
    // В симуляторе у фоновых участников нет чата — за них приглашение принимается сразу.
    const accepted = !isInteractive(session, candidate);
    const assignment: JudgeAssignment = { proposedBy: from, candidate, accepted, confirmedBy: [from] };
    const journal = [...session.journal, `${nameOf(session, from)} зовёт судьёй ${nameOf(session, candidate)} (${matchLabel(match)})`];
    return {
      session: {
        ...session,
        judges: { ...session.judges, [match.id]: assignment },
        modes: { ...session.modes, [from]: { kind: 'idle' } },
        journal,
      },
    };
  }

  const answer = /^(accept|decline):(.+)$/.exec(data);
  if (answer) {
    const [, verdict, matchId] = answer;
    const assignment = session.judges[matchId!];
    if (!assignment || assignment.candidate !== from || assignment.accepted) return { toast: 'Приглашение уже неактуально' };
    if (verdict === 'decline') {
      const { [matchId!]: _, ...judges } = session.judges;
      const journal = [...session.journal, `Отказ судить ${matchLabel(findMatch(session.bracket!, matchId!)!)}: ${nameOf(session, from)}`];
      return { session: { ...session, judges, journal } };
    }
    return { session: { ...session, judges: { ...session.judges, [matchId!]: { ...assignment, accepted: true } } } };
  }

  const confirm = /^confirmJudge:(.+)$/.exec(data);
  if (confirm) {
    const matchId = confirm[1]!;
    const assignment = session.judges[matchId];
    const match = findMatch(session.bracket, matchId);
    if (!assignment || !match || !playersIn(session, match).includes(from)) return { toast: 'Это не твой матч' };
    if (!assignment.accepted || assignment.confirmedBy.includes(from)) return { toast: 'Подтверждение не требуется' };
    const confirmed = { ...assignment, confirmedBy: [...assignment.confirmedBy, from] };
    const journal =
      confirmed.confirmedBy.length === 2
        ? [...session.journal, `Судья ${matchLabel(match)}: ${nameOf(session, confirmed.candidate)}, подтверждение обоих игроков`]
        : session.journal;
    return { session: { ...session, judges: { ...session.judges, [matchId]: confirmed }, journal } };
  }

  return { toast: 'Сейчас это действие недоступно' };
}

// --- Правила подбора ----------------------------------------------------------

function playersIn(session: DrawSession, match: BracketMatch): UserId[] {
  return match.slots
    .map((slot) => resolveSlot(session.bracket!, session.results, slot))
    .filter((id): id is string => id !== undefined);
}

// Ближайший матч игрока в первом открытом круге.
export function currentMatch(session: DrawSession, userId: UserId): BracketMatch | undefined {
  return playedMatches(session.bracket!).find(
    (m) => !session.results[m.id] && playersIn(session, m).length === 2 && playersIn(session, m).includes(userId),
  );
}

function byeOf(session: DrawSession, userId: UserId): BracketMatch | undefined {
  return session.bracket!.rounds[0]?.find((m) => m.isBye && resolveSlot(session.bracket!, {}, m.slots[0]) === userId);
}

// Судья — не игрок этого матча и не судит другой незавершённый матч. Первыми идут гости, затем свободные
// в этом круге: им знакомство с песнями меньше всего мешает в собственной игре.
export function judgeCandidates(session: DrawSession, match: BracketMatch): Participant[] {
  const busy = new Set(
    Object.entries(session.judges)
      .filter(([id]) => id !== match.id && !session.results[id])
      .map(([, a]) => a.candidate),
  );
  const inMatch = new Set(playersIn(session, match));
  const available = session.config.registered.filter((p) => !inMatch.has(p.id) && !busy.has(p.id));
  const rank = (p: Participant) => {
    if (!session.config.players.some((x) => x.id === p.id)) return 0;
    return byeOf(session, p.id) ? 1 : 2;
  };
  return [...available].sort((a, b) => rank(a) - rank(b));
}

// --- Рендер -------------------------------------------------------------------

export function render(session: DrawSession): OutgoingMessage[] {
  const people = session.config.interactive ?? session.config.registered.map((p) => p.id);
  const cards = people.flatMap((id) => renderPlayer(session, id));
  return [...cards, renderOrganizer(session)];
}

function renderPlayer(session: DrawSession, userId: UserId): OutgoingMessage[] {
  const { config, bracket } = session;
  const messages: OutgoingMessage[] = [];
  if (!bracket) {
    if (config.players.some((p) => p.id === userId)) {
      messages.push({ kind: 'message', to: userId, slot: 'card', text: '⏳ Сбор закрыт, ждём жеребьёвку. Пару пришлю сюда.' });
    }
    return messages;
  }

  const match = currentMatch(session, userId);
  const bye = byeOf(session, userId);
  const isPlayer = config.players.some((p) => p.id === userId);
  if (match) messages.push(matchCard(session, userId, match));
  else if (isPlayer && qualifiedIds(session).includes(userId)) {
    messages.push({ kind: 'message', to: userId, slot: 'card', text: '🏆 Ты в финале! Дату и место сообщит организатор.' });
  } else if (isPlayer && eliminated(session, userId)) {
    messages.push({
      kind: 'message',
      to: userId,
      slot: 'card',
      text: 'Отбор для тебя закончился. Спасибо за игру! Тебя всё ещё могут позвать судить чужие матчи.',
    });
  } else if (bye && !session.results[bye.id]) messages.push(byeCard(session, userId, bye));
  else if (isPlayer && waitingOpponent(session, userId)) {
    messages.push({ kind: 'message', to: userId, slot: 'card', text: '⏳ Ждём, кто станет твоим следующим соперником. Пару пришлю сюда.' });
  }

  // Приглашения судить чужой матч.
  for (const [matchId, assignment] of Object.entries(session.judges)) {
    if (assignment.candidate !== userId || session.results[matchId]) continue;
    const judged = findMatch(bracket, matchId)!;
    const [a, b] = playersIn(session, judged).map((id) => nameOf(session, id));
    const deadline = formatDate(session.deadlines[judged.round - 1]!);
    if (!assignment.accepted) {
      messages.push({
        kind: 'message',
        to: userId,
        slot: `invite:${matchId}`,
        text: [
          `⚖️ ${assignment.proposedBy ? `${nameOf(session, assignment.proposedBy)} зовёт тебя` : 'Тебя зовут'} судить матч ${matchLabel(judged)}: ${a} — ${b}.`,
          `Срок: до ${deadline}. Договоритесь о времени и месте с игроками.`,
          '',
          'Песни, которые ты услышишь как судья, тебе потом не выпадут в собственных матчах.',
        ].join('\n'),
        buttons: [
          [
            { label: '✅ Соглашаюсь', data: `accept:${matchId}` },
            { label: 'Не смогу', data: `decline:${matchId}` },
          ],
        ],
      });
    } else {
      const ready = assignment.confirmedBy.length === 2;
      messages.push({
        kind: 'message',
        to: userId,
        slot: `invite:${matchId}`,
        text: ready
          ? `⚖️ Ты судья матча ${matchLabel(judged)}: ${a} — ${b}, до ${deadline}.\n${
              session.config.interactive ? 'Когда соберётесь, открой панель судьи — бот выдаст первый трек.' : 'Панель судьи — ниже. Когда соберётесь, нажми «Все на месте».'
            }`
          : `⚖️ Согласие отправлено: матч ${matchLabel(judged)}, ${a} — ${b}. Ждём подтверждения игроков.`,
      });
    }
  }
  return messages;
}

function matchCard(session: DrawSession, userId: UserId, match: BracketMatch): OutgoingMessage {
  const opponentId = playersIn(session, match).find((id) => id !== userId)!;
  const deadline = formatDate(session.deadlines[match.round - 1]!);
  const assignment = session.judges[match.id];
  const lines = [
    `🎯 Отбор · ${match.round}-й круг · матч ${matchLabel(match)}`,
    `Соперник: ${nameOf(session, opponentId)} (${session.config.usernames[opponentId] ?? 'без username'})`,
    `Срок: до ${deadline}`,
    '',
  ];
  const buttons: Button[][] = [];
  const mode = session.modes[userId] ?? { kind: 'idle' };

  if (!assignment) {
    if (mode.kind === 'pickJudge') {
      lines.push('Кого позвать судьёй? Сначала — те, кто свободен в этом круге.');
      const candidates = judgeCandidates(session, match).slice(0, MAX_JUDGE_SUGGESTIONS);
      for (let i = 0; i < candidates.length; i += 2) {
        buttons.push(candidates.slice(i, i + 2).map((p) => ({ label: p.name, data: `judge:${p.id}` })));
      }
      lines.push(`Нет в списке — отправь ссылку: t.me/${session.config.botUsername}?start=judge_${match.id}`);
      buttons.push([{ label: 'Отмена', data: 'cancel' }]);
    } else {
      lines.push('Договоритесь о времени в личке или в общем чате, потом выберите судью — он придёт с телефоном и включит треки.');
      buttons.push([{ label: '⚖️ Выбрать судью', data: 'pickJudge' }]);
    }
  } else {
    const judgeName = nameOf(session, assignment.candidate);
    if (!assignment.accepted) {
      lines.push(`⚖️ Судья: ${judgeName} — ждём согласия.`);
    } else if (assignment.confirmedBy.length < 2) {
      if (assignment.confirmedBy.includes(userId)) {
        lines.push(`⚖️ Судья: ${judgeName} — согласие есть. Ждём подтверждения соперника.`);
      } else {
        const by = assignment.proposedBy ? `${nameOf(session, assignment.proposedBy)} предлагает` : 'Пришёл по ссылке';
        lines.push(`⚖️ ${by} судью: ${judgeName}. Согласие судьи получено.`);
        buttons.push([{ label: '✅ Подтверждаю судью', data: `confirmJudge:${match.id}` }]);
      }
    } else {
      lines.push(`✅ Всё готово: судья ${judgeName}. Встречайтесь — судья откроет матч в боте.`);
    }
  }
  return { kind: 'message', to: userId, slot: 'card', text: lines.join('\n'), buttons: buttons.length ? buttons : undefined };
}

function byeCard(session: DrawSession, userId: UserId, bye: BracketMatch): OutgoingMessage {
  const next = session.bracket!.rounds[1]?.find((m) => m.slots.some((s) => s.kind === 'winnerOf' && s.matchId === bye.id));
  const other = next?.slots.find((s) => !(s.kind === 'winnerOf' && s.matchId === bye.id));
  const lines = [`🎟 Проход без игры в 1-м круге.`];
  if (next && other) {
    lines.push(`Следующий матч ${matchLabel(next)}: соперник — ${describeSlot(session, other)}.`);
    lines.push(`Срок: до ${formatDate(session.deadlines[next.round - 1]!)}`);
  }
  lines.push('', 'Пока можно судить чужие матчи — тебя могут позвать.');
  return { kind: 'message', to: userId, slot: 'card', text: lines.join('\n') };
}

function renderOrganizer(session: DrawSession): OutgoingMessage {
  const { config, bracket } = session;
  const to = config.organizer.id;
  if (!bracket) {
    const preview = buildQualifierBracket(config.players.map((p) => p.id), config.finalists, config.seed);
    // Игроков не больше, чем мест в финале: кругов нет, в финал проходят все.
    const byes = preview.rounds[0]?.filter((m) => m.isBye).length ?? 0;
    return {
      kind: 'message',
      to,
      slot: 'draw',
      text: [
        '🎲 Жеребьёвка',
        '',
        `Игроков: ${config.players.length} · сетка на ${preview.size} · проходов без игры: ${byes}`,
        `Матчей отбора до ${config.finalists} финалистов: ${playedMatches(preview).length}`,
        `Seed: ${config.seed} — сетка воспроизводима и после публикации не перемешивается.`,
      ].join('\n'),
      buttons: [[{ label: '🎲 Провести жеребьёвку', data: 'draw' }]],
    };
  }

  const lines = ['🎲 Сетка отбора опубликована', ''];
  bracket.rounds.forEach((round, r) => {
    const played = round.filter((m) => !m.isBye);
    lines.push(`${r + 1}-й круг · до ${formatDate(session.deadlines[r]!)} · ${played.length} ${plural(played.length, 'матч', 'матча', 'матчей')}`);
    for (const match of played) {
      const judge = session.judges[match.id];
      const judgeMark = !judge ? '' : judge.confirmedBy.length === 2 ? ` · ⚖️ ${nameOf(session, judge.candidate)}` : ' · ⚖️ выбирают';
      const winner = session.results[match.id];
      const result = winner ? ` · 🏅 ${nameOf(session, winner)}` : judgeMark;
      lines.push(`  ${matchLabel(match)}: ${describeSlot(session, match.slots[0])} — ${describeSlot(session, match.slots[1])}${result}`);
    }
    const byes = round.filter((m) => m.isBye);
    if (byes.length > 0) {
      lines.push(`  Без игры: ${byes.map((m) => describeSlot(session, m.slots[0])).join(', ')}`);
    }
  });
  if (session.journal.length > 0) {
    lines.push('', '🗒 Журнал:', ...session.journal.slice(-5).map((entry) => `• ${entry}`));
  }
  const buttons: Button[][] = bracket.rounds.map((_, r) => [
    { label: `📅 Срок ${r + 1}-го круга +2 дня`, data: `shift:${r + 1}` },
  ]);
  return { kind: 'message', to, slot: 'draw', text: lines.join('\n'), buttons };
}

function describeSlot(session: DrawSession, slot: Slot): string {
  if (slot.kind === 'player') return nameOf(session, slot.id);
  if (slot.kind === 'bye') return '—';
  const source = findMatch(session.bracket!, slot.matchId)!;
  if (source.isBye) return describeSlot(session, source.slots[0]);
  const winner = session.results[source.id];
  return winner ? nameOf(session, winner) : `победитель ${matchLabel(source)}`;
}

export function qualifiedIds(session: DrawSession): UserId[] {
  if (!session.bracket) return [];
  // Игроков не больше, чем мест в финале: кругов нет, в финал проходят все.
  if (session.bracket.rounds.length === 0) return session.config.players.map((p) => p.id);
  return qualified(session.bracket, session.results);
}

// Все матчи отбора сыграны: финалисты определены.
export function qualifiersDone(session: DrawSession): boolean {
  return session.bracket !== null && playedMatches(session.bracket).every((m) => session.results[m.id]);
}

export function eliminated(session: DrawSession, userId: UserId): boolean {
  return playedMatches(session.bracket!).some(
    (m) => session.results[m.id] !== undefined && session.results[m.id] !== userId && playersIn(session, m).includes(userId),
  );
}

// Свой матч выигран, следующий соперник ещё не определился.
function waitingOpponent(session: DrawSession, userId: UserId): boolean {
  return Object.values(session.results).includes(userId) || byeOf(session, userId) !== undefined;
}

export function matchLabel(match: BracketMatch): string {
  return `№${match.id.replace(/^r(\d+)-(\d+)$/, '$1.$2')}`;
}

function nameOf(session: DrawSession, userId: UserId): string {
  return session.config.registered.find((p) => p.id === userId)?.name ?? userId;
}

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

export function formatDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
