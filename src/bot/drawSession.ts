import {
  buildQualifierBracket,
  findMatch,
  playedMatches,
  resolveSlot,
  type Bracket,
  type BracketMatch,
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
  // Кто действует в симуляторе; остальным сообщения не рендерятся.
  interactive: UserId[];
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
  proposedBy: UserId;
  candidate: UserId;
  accepted: boolean;
  confirmedBy: UserId[];
}

type Mode = { kind: 'idle' } | { kind: 'pickJudge' };

export interface DrawSession {
  config: DrawSessionConfig;
  bracket: Bracket | null;
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

  const next = result.session;
  const previous = new Map(before.map((m) => [`${m.to}/${m.slot}`, JSON.stringify(m)]));
  const changed = render(next).filter((m) => previous.get(`${m.to}/${m.slot}`) !== JSON.stringify(m));
  return { session: { ...next, notifications: [] }, out: [...changed, ...next.notifications] };
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
        if (!id || !config.interactive.includes(id)) continue;
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
    const accepted = !session.config.interactive.includes(candidate);
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
    .map((slot) => resolveSlot(session.bracket!, {}, slot))
    .filter((id): id is string => id !== undefined);
}

// Ближайший матч игрока в первом открытом круге.
export function currentMatch(session: DrawSession, userId: UserId): BracketMatch | undefined {
  return playedMatches(session.bracket!).find((m) => playersIn(session, m).length === 2 && playersIn(session, m).includes(userId));
}

function byeOf(session: DrawSession, userId: UserId): BracketMatch | undefined {
  return session.bracket!.rounds[0]!.find((m) => m.isBye && resolveSlot(session.bracket!, {}, m.slots[0]) === userId);
}

// Судья — не игрок этого матча и не судит другой матч. Первыми идут гости, затем свободные
// в этом круге: им знакомство с песнями меньше всего мешает в собственной игре.
export function judgeCandidates(session: DrawSession, match: BracketMatch): Participant[] {
  const busy = new Set(
    Object.entries(session.judges)
      .filter(([id]) => id !== match.id)
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
  const cards = session.config.interactive.flatMap((id) => renderPlayer(session, id));
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
  if (match) messages.push(matchCard(session, userId, match));
  else if (bye) messages.push(byeCard(session, userId, bye));

  // Приглашения судить чужой матч.
  for (const [matchId, assignment] of Object.entries(session.judges)) {
    if (assignment.candidate !== userId) continue;
    const judged = findMatch(bracket, matchId)!;
    const [a, b] = playersIn(session, judged).map((id) => nameOf(session, id));
    const deadline = formatDate(session.deadlines[judged.round - 1]!);
    if (!assignment.accepted) {
      messages.push({
        kind: 'message',
        to: userId,
        slot: `invite:${matchId}`,
        text: [
          `⚖️ ${nameOf(session, assignment.proposedBy)} зовёт тебя судить матч ${matchLabel(judged)}: ${a} — ${b}.`,
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
          ? `⚖️ Ты судья матча ${matchLabel(judged)}: ${a} — ${b}, до ${deadline}.\nКогда соберётесь, открой панель судьи — бот выдаст первый трек.`
          : `⚖️ Согласие отправлено: матч ${matchLabel(judged)}, ${a} — ${b}. Ждём подтверждения второго игрока.`,
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
        lines.push(`⚖️ ${nameOf(session, assignment.proposedBy)} предлагает судью: ${judgeName}. Согласие судьи получено.`);
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
    const byes = preview.rounds[0]!.filter((m) => m.isBye).length;
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
      lines.push(`  ${matchLabel(match)}: ${describeSlot(session, match.slots[0])} — ${describeSlot(session, match.slots[1])}${judgeMark}`);
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
  return `победитель ${matchLabel(source)}`;
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
