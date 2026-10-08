import {
  acceptedSongs,
  completeProcessing,
  createIntake,
  pendingProcessing,
  receiveFiles,
  remove,
  setTitle,
  statusOf,
  submissionsOf,
  type AudioFile,
  type IntakeRules,
  type IntakeState,
  type RejectReason,
  type Submission,
} from '../domain/submission/intake.ts';
import { splitPools, type PoolSplit } from '../domain/submission/pools.ts';
import { fromText } from '../domain/submission/titles.ts';
import { plural } from '../shared/text.ts';
import type { Participant } from './matchSession.ts';
import type { Button, Incoming, Outgoing, OutgoingMessage, UserId } from './protocol.ts';

// Сбор треков в чате с ботом (docs/decisions/2026-10-08-mechanics-revision.md, разделы 4–6).
// У участника одно живое сообщение-список: файлы пересылаются пачкой, названия берутся из тегов,
// бот спрашивает только то, что не понял сам. Пулы делит бот после закрытия сбора.

export interface IntakeSessionConfig {
  participants: Participant[];
  // Участники, которые уже сдали треки до начала демонстрации: их нет в колонках симулятора.
  background: { participant: Participant; files: AudioFile[] }[];
  organizer: Participant;
  rules: IntakeRules;
  finalPoolTarget: number;
  finalists: number;
  seed: number;
}

type Mode = { kind: 'idle' } | { kind: 'pick'; action: 'edit' | 'remove' } | { kind: 'awaitTitle'; submissionId: string };

interface UserUi {
  mode: Mode;
  // Разовая строка над списком: итог последнего действия или подсказка.
  notice: string | null;
  // Счётчики позиции: если пользователь писал после списка, список переезжает вниз.
  activity: number;
  listPostedAt: number;
}

export type AdmissionDecision = 'admit' | 'exclude';

export interface ClosedIntake {
  split: PoolSplit;
  // Решения организатора по недобравшим; без решения игрок не попадает в жеребьёвку.
  decisions: Record<UserId, AdmissionDecision>;
}

export interface IntakeSession {
  config: IntakeSessionConfig;
  intake: IntakeState;
  ui: Record<UserId, UserUi>;
  closed: ClosedIntake | null;
}

export interface IntakeStep {
  session: IntakeSession;
  out: Outgoing[];
}

const REJECT_TEXT: Record<RejectReason, string> = {
  too_large: 'больше 20 МБ',
  bad_format: 'нужен MP3 или M4A',
  corrupt: 'файл не читается',
  duplicate_own: 'уже есть в твоём списке',
  quota_full: 'сверх 10 песен',
};

// Запас подходящих песен на один короткий отборочный матч (раздел 4 пересмотра механики).
const MIN_SONGS_PER_QUALIFIER = 10;

const TITLE_FORMAT = 'Ответь сообщением в формате «Исполнитель — Название».';

export function openIntakeSession(config: IntakeSessionConfig): IntakeStep {
  const ui: Record<UserId, UserUi> = {};
  for (const p of config.participants) ui[p.id] = { mode: { kind: 'idle' }, notice: null, activity: 0, listPostedAt: 0 };

  let intake = createIntake(config.rules);
  for (const { participant, files } of config.background) intake = receiveFiles(intake, participant.id, files);
  for (const s of pendingProcessing(intake)) intake = completeProcessing(intake, s.id, true);

  const session: IntakeSession = { config, intake, ui, closed: null };
  const welcome: OutgoingMessage[] = config.participants.map((p) => ({
    kind: 'message',
    to: p.id,
    slot: 'welcome',
    text: [
      `Привет, ${p.name}! Собираем песни для турнира.`,
      '',
      `Пришли до ${config.rules.maxSubmissions} песен — пересылай пачкой, хоть все сразу, из @Music_to_you_bot или откуда удобно.`,
      'Исполнителя и название возьму из файла; если не получится — спрошу.',
      'На отбор и финал песни разделю сам после закрытия сбора.',
    ].join('\n'),
  }));
  return { session, out: [...welcome, ...render(session)] };
}

export function handleIntake(session: IntakeSession, input: Incoming): IntakeStep {
  const before = render(session);
  let next = session;

  if (input.kind === 'worker') {
    let intake = session.intake;
    for (const { submissionId, ok } of input.results) intake = completeProcessing(intake, submissionId, ok);
    next = { ...session, intake };
  } else if (input.from === session.config.organizer.id) {
    if (input.kind !== 'button') return { session, out: [] };
    const result = handleOrganizer(session, input.data);
    if ('toast' in result) return { session, out: [{ kind: 'toast', to: input.from, text: result.toast }] };
    next = result.session;
  } else {
    const ui = session.ui[input.from];
    if (!ui) return { session, out: [] };
    if (input.kind === 'button') {
      if (session.closed) return { session, out: [{ kind: 'toast', to: input.from, text: 'Сбор уже закрыт' }] };
      const result = handleButton(session, input.from, input.data);
      if ('toast' in result) return { session, out: [{ kind: 'toast', to: input.from, text: result.toast }] };
      next = result.session;
    } else {
      if (session.closed) {
        next = setUi(session, input.from, { notice: 'Сбор уже закрыт — новые песни и правки не принимаются.' });
      } else {
        next = input.kind === 'files' ? handleFiles(session, input.from, input.files) : handleText(session, input.from, input.text);
      }
      next = setUi(next, input.from, { activity: ui.activity + 1 });
    }
  }

  const author = input.kind === 'text' || input.kind === 'files' ? input.from : undefined;
  return emit(next, before, author);
}

export function pendingSubmissions(session: IntakeSession): Submission[] {
  return pendingProcessing(session.intake);
}

export function allParticipants(config: IntakeSessionConfig): Participant[] {
  return [...config.participants, ...config.background.map((b) => b.participant)];
}

export function acceptedCount(session: IntakeSession, userId: UserId): number {
  return submissionsOf(session.intake, userId).filter((s) => statusOf(s) === 'accepted').length;
}

export function underSubmitted(session: IntakeSession): Participant[] {
  const { maxSubmissions } = session.config.rules;
  return allParticipants(session.config).filter((p) => acceptedCount(session, p.id) < maxSubmissions);
}

export function admittedPlayers(session: IntakeSession): Participant[] {
  const closed = session.closed;
  if (!closed) return [];
  const short = new Set(underSubmitted(session).map((p) => p.id));
  return allParticipants(session.config).filter((p) => !short.has(p.id) || closed.decisions[p.id] === 'admit');
}

export function readyForDraw(session: IntakeSession): boolean {
  const closed = session.closed;
  return closed !== null && underSubmitted(session).every((p) => closed.decisions[p.id] !== undefined);
}

// --- Участник ---------------------------------------------------------------

function handleFiles(session: IntakeSession, from: UserId, files: AudioFile[]): IntakeSession {
  // Отклонённые ранее файлы убираем из списка: участник прислал замену.
  let intake = session.intake;
  for (const s of submissionsOf(intake, from)) if (s.rejection) intake = remove(intake, s.id);
  const known = new Set(submissionsOf(intake, from).map((s) => s.id));
  intake = receiveFiles(intake, from, files);

  const added = submissionsOf(intake, from).filter((s) => !known.has(s.id));
  const rejected = added.filter((s) => s.rejection).length;
  const word = plural(added.length, 'файл', 'файла', 'файлов');
  const notice = `Получил ${added.length} ${word}${rejected ? `, не подошло: ${rejected}` : ''}.`;
  return setUi({ ...session, intake }, from, { notice, mode: { kind: 'idle' } });
}

function handleText(session: IntakeSession, from: UserId, text: string): IntakeSession {
  const target = titleTarget(session, from);
  if (!target) {
    return setUi(session, from, { notice: 'Чтобы поправить название, нажми «✏️ Исправить» под списком.' });
  }
  const meta = fromText(text);
  if (!meta) {
    return setUi(session, from, { notice: `Не разобрал «${text}»: исполнителя и название нужно разделить тире.` });
  }

  const intake = setTitle(session.intake, target.id, meta);
  const updated = intake.submissions.find((s) => s.id === target.id)!;
  const notice = updated.rejection
    ? `«${meta.artist} — ${meta.title}»: ${REJECT_TEXT[updated.rejection]}. Пришли другую песню.`
    : `Записал: ${meta.artist} — ${meta.title}.`;
  return setUi({ ...session, intake }, from, { notice, mode: { kind: 'idle' } });
}

type ButtonResult = { session: IntakeSession } | { toast: string };

function handleButton(session: IntakeSession, from: UserId, data: string): ButtonResult {
  if (data === 'cancel') return { session: setUi(session, from, { mode: { kind: 'idle' }, notice: null }) };

  const pick = /^pick:(edit|remove)$/.exec(data);
  if (pick) {
    const action = pick[1] as 'edit' | 'remove';
    if (candidates(session, from, action).length === 0) return { toast: 'Пока нечего выбирать' };
    return { session: setUi(session, from, { mode: { kind: 'pick', action }, notice: null }) };
  }

  const chosen = /^n:(\w+)$/.exec(data);
  const submission = chosen && session.intake.submissions.find((s) => s.id === chosen[1] && s.owner === from);
  if (!submission) return { toast: 'Этой песни уже нет в списке' };
  const { mode } = session.ui[from]!;
  if (mode.kind !== 'pick') return { toast: 'Сначала выбери действие под списком' };

  if (mode.action === 'edit') {
    return { session: setUi(session, from, { mode: { kind: 'awaitTitle', submissionId: submission.id }, notice: null }) };
  }
  const intake = remove(session.intake, submission.id);
  return {
    session: setUi({ ...session, intake }, from, { mode: { kind: 'idle' }, notice: `Убрал «${labelOf(submission)}».` }),
  };
}

// --- Организатор ------------------------------------------------------------

function handleOrganizer(session: IntakeSession, data: string): ButtonResult {
  if (data === 'closeIntake') {
    if (session.closed) return { toast: 'Сбор уже закрыт' };
    const { finalPoolTarget, seed } = session.config;
    const split = splitPools(acceptedSongs(session.intake), finalPoolTarget, seed);
    return { session: { ...session, closed: { split, decisions: {} } } };
  }
  const decision = /^(admit|exclude):(.+)$/.exec(data);
  if (decision && session.closed) {
    const [, verdict, userId] = decision;
    const decisions = { ...session.closed.decisions, [userId!]: verdict as AdmissionDecision };
    return { session: { ...session, closed: { ...session.closed, decisions } } };
  }
  return { toast: 'Сейчас это действие недоступно' };
}

function setUi(session: IntakeSession, userId: UserId, patch: Partial<UserUi>): IntakeSession {
  return { ...session, ui: { ...session.ui, [userId]: { ...session.ui[userId]!, ...patch } } };
}

// Песня, для которой бот ждёт название: выбранная вручную или первая без названия.
function titleTarget(session: IntakeSession, userId: UserId): Submission | undefined {
  const { mode } = session.ui[userId]!;
  if (mode.kind === 'awaitTitle') return session.intake.submissions.find((s) => s.id === mode.submissionId);
  return ordered(session, userId).find((s) => statusOf(s) === 'needs_title');
}

function candidates(session: IntakeSession, userId: UserId, action: 'edit' | 'remove'): Submission[] {
  const list = ordered(session, userId);
  return action === 'remove' ? list : list.filter((s) => !s.rejection);
}

// Порядок в списке и номера: сначала рабочие заявки, затем не подошедшие.
function ordered(session: IntakeSession, userId: UserId): Submission[] {
  const own = submissionsOf(session.intake, userId);
  return [...own.filter((s) => !s.rejection), ...own.filter((s) => s.rejection)];
}

// --- Рендер -----------------------------------------------------------------

// Отправляем только изменившиеся сообщения. Список того, кто сам что-то написал, переотправляется
// всегда: иначе на сообщение без изменений участник не увидит реакции.
function emit(next: IntakeSession, before: OutgoingMessage[], author?: UserId): IntakeStep {
  const previous = new Map(before.map((m) => [`${m.to}/${m.slot}`, JSON.stringify(m)]));
  const out: OutgoingMessage[] = [];
  let session = next;
  for (const message of render(next)) {
    const unchanged = previous.get(`${message.to}/${message.slot}`) === JSON.stringify(message);
    if (unchanged && !(message.to === author && message.slot === 'list')) continue;
    const ui = session.ui[message.to];
    if (ui && message.slot === 'list' && ui.activity > ui.listPostedAt) {
      out.push({ ...message, bump: true });
      session = setUi(session, message.to, { listPostedAt: ui.activity });
    } else {
      out.push(message);
    }
  }
  return { session, out };
}

export function render(session: IntakeSession): OutgoingMessage[] {
  return [...session.config.participants.map((p) => renderList(session, p.id)), renderOrganizer(session)];
}

function renderList(session: IntakeSession, userId: UserId): OutgoingMessage {
  const { maxSubmissions } = session.config.rules;
  const ui = session.ui[userId]!;
  const list = ordered(session, userId);
  const number = new Map(list.map((s, i) => [s.id, i + 1]));
  const accepted = acceptedCount(session, userId);
  const lines: string[] = [];

  if (session.closed) {
    lines.push(`🔒 Сбор закрыт · принято ${accepted} из ${maxSubmissions}`, 'Дальше жеребьёвка — пару пришлю сюда.');
  } else if (accepted === maxSubmissions) {
    lines.push(`✅ Все ${maxSubmissions} песен приняты`, 'Можно менять до закрытия сбора.');
  } else {
    lines.push(
      `🎵 Твои песни · принято ${accepted} из ${maxSubmissions}`,
      'Проверь названия — по ним судья засчитывает ответы.',
    );
  }

  const active = list.filter((s) => !s.rejection);
  if (active.length > 0) lines.push('');
  for (const s of active) lines.push(`${number.get(s.id)}. ${labelOf(s)} ${statusMark(s)}`);
  const rejected = list.filter((s) => s.rejection);
  if (rejected.length > 0) {
    lines.push('', 'Не подошло — пришли замену:');
    for (const s of rejected) lines.push(`${number.get(s.id)}. ${labelOf(s)} — ${REJECT_TEXT[s.rejection!]}`);
  }

  const footer: string[] = [];
  if (ui.notice) footer.push(ui.notice);
  const target = session.closed ? undefined : titleTarget(session, userId);
  const { mode } = ui;
  if (target && mode.kind !== 'pick') {
    footer.push(
      mode.kind === 'awaitTitle'
        ? `✏️ Песня ${number.get(target.id)}: сейчас «${labelOf(target)}». ${TITLE_FORMAT}`
        : `✏️ Песня ${number.get(target.id)} (${target.file.fileName ?? 'без имени'}): не нашёл название. ${TITLE_FORMAT}`,
    );
  }
  if (mode.kind === 'pick') footer.push(mode.action === 'edit' ? 'Какую песню исправить?' : 'Какую песню убрать?');
  if (footer.length > 0) lines.push('', ...footer);

  return {
    kind: 'message',
    to: userId,
    slot: 'list',
    text: lines.join('\n'),
    buttons: session.closed ? undefined : listButtons(session, userId, list, number),
  };
}

function listButtons(
  session: IntakeSession,
  userId: UserId,
  list: Submission[],
  number: Map<string, number>,
): Button[][] | undefined {
  const { mode } = session.ui[userId]!;
  if (mode.kind === 'pick') {
    const items = candidates(session, userId, mode.action);
    const rows: Button[][] = [];
    for (let i = 0; i < items.length; i += 5) {
      rows.push(items.slice(i, i + 5).map((s) => ({ label: String(number.get(s.id)), data: `n:${s.id}` })));
    }
    return [...rows, [{ label: 'Отмена', data: 'cancel' }]];
  }
  if (mode.kind === 'awaitTitle') return [[{ label: 'Отмена', data: 'cancel' }]];
  if (list.length === 0) return undefined;
  return [
    [
      { label: '✏️ Исправить', data: 'pick:edit' },
      { label: '🗑 Убрать', data: 'pick:remove' },
    ],
  ];
}

function renderOrganizer(session: IntakeSession): OutgoingMessage {
  const { config, intake, closed } = session;
  const { maxSubmissions } = config.rules;
  const people = allParticipants(config);
  const songs = acceptedSongs(intake);
  const acceptedTotal = intake.submissions.filter((s) => statusOf(s) === 'accepted').length;
  const full = people.filter((p) => acceptedCount(session, p.id) === maxSubmissions).length;
  const short = underSubmitted(session);
  const lines = [closed ? '🔒 Сбор закрыт' : '📥 Сбор треков', ''];

  lines.push(
    `Участников: ${people.length} · сдали все ${maxSubmissions}: ${full}`,
    `Принято заявок: ${acceptedTotal} · уникальных песен: ${songs.length}` +
      (acceptedTotal > songs.length ? ` (склеено дублей: ${acceptedTotal - songs.length})` : ''),
  );

  if (!closed) {
    const pending = intake.submissions.filter((s) => statusOf(s) === 'processing').length;
    const untitled = intake.submissions.filter((s) => statusOf(s) === 'needs_title').length;
    if (pending || untitled) lines.push(`В обработке: ${pending} · без названия: ${untitled}`);
    if (short.length > 0) {
      lines.push('', `Пока меньше ${maxSubmissions}:`, ...short.map((p) => `• ${p.name} — ${acceptedCount(session, p.id)}`));
    }
    return {
      kind: 'message',
      to: config.organizer.id,
      slot: 'intake',
      text: lines.join('\n'),
      buttons: [[{ label: '🔒 Закрыть сбор', data: 'closeIntake' }]],
    };
  }

  const buttons: Button[][] = [];
  if (short.length > 0) {
    lines.push('', `Сдали меньше ${maxSubmissions} — без решения в жеребьёвку не попадут:`);
    for (const p of short) {
      const decision = closed.decisions[p.id];
      const mark = decision === 'admit' ? '✅ допущен' : decision === 'exclude' ? '✖ не допущен' : '⏳ ждёт решения';
      lines.push(`• ${p.name} — ${acceptedCount(session, p.id)} из ${maxSubmissions} · ${mark}`);
      if (!decision) {
        buttons.push([
          { label: `✅ Допустить: ${p.name}`, data: `admit:${p.id}` },
          { label: '✖ Нет', data: `exclude:${p.id}` },
        ]);
      }
    }
  }

  const { split } = closed;
  const finalOk = split.final.length >= split.finalTarget;
  const players = admittedPlayers(session).length;
  const qualifierMatches = Math.max(0, players - config.finalists);
  // Повтор песни между независимыми парами допустим, поэтому отбору хватает запаса на один матч.
  const mainOk = split.main.length >= MIN_SONGS_PER_QUALIFIER;
  lines.push(
    '',
    `Пулы разделены (seed ${split.seed}):`,
    `${finalOk ? '✅' : '⚠️'} Финал: ${split.final.length} из нужных ~${split.finalTarget}`,
    `${mainOk ? '✅' : '⚠️'} Отбор: ${split.main.length} ${plural(split.main.length, 'песня', 'песни', 'песен')} на ${qualifierMatches} ${plural(qualifierMatches, 'матч', 'матча', 'матчей')} — на матч нужно ~${MIN_SONGS_PER_QUALIFIER} подходящих, повтор между парами допустим`,
  );
  if (!finalOk) lines.push(`Финалу не хватает ${split.finalTarget - split.final.length} — нужен запас организатора.`);
  lines.push(
    '',
    readyForDraw(session) ? `Готово к жеребьёвке: ${players} игроков ✅` : 'Жеребьёвка — после решений по недобравшим.',
  );

  return {
    kind: 'message',
    to: config.organizer.id,
    slot: 'intake',
    text: lines.join('\n'),
    buttons: buttons.length ? buttons : undefined,
  };
}

function labelOf(s: Submission): string {
  return s.meta ? `${s.meta.artist} — ${s.meta.title}` : (s.file.fileName ?? 'без имени');
}

function statusMark(s: Submission): string {
  switch (statusOf(s)) {
    case 'accepted':
      return '✅';
    case 'processing':
      return '⏳';
    case 'needs_title':
      return '✏️';
    case 'rejected':
      return '⚠️';
  }
}
