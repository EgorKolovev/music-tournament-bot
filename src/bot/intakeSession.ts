import {
  acceptedSongs,
  completeProcessing,
  createIntake,
  pendingProcessing,
  receiveFiles,
  remove,
  setStart,
  setTitle,
  statusOf,
  submissionsOf,
  type AudioFile,
  type IntakeRules,
  type IntakeState,
  type RejectReason,
  type Submission,
} from '../domain/submission/intake.ts';
import { latestStart, rollStart, shiftStart } from '../domain/submission/fragmentStart.ts';
import { splitPools, type PoolSplit } from '../domain/submission/pools.ts';
import { fromText } from '../domain/submission/titles.ts';
import { formatClock, parseClock, plural } from '../shared/text.ts';
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
  // Длина игрового фрагмента, секунд.
  fragmentSec: number;
  finalPoolTarget: number;
  finalists: number;
  seed: number;
  // Присылают песни, но не играют: их песни идут в пулы, а сами они не попадают ни в жеребьёвку,
  // ни в недобравших. Передумать можно до закрытия сбора. В снимках прошлых версий поля нет.
  songsOnly?: UserId[];
}

type PickAction = 'edit' | 'remove' | 'start' | 'listen';

type Mode =
  | { kind: 'idle' }
  | { kind: 'pick'; action: PickAction }
  | { kind: 'awaitTitle'; submissionId: string }
  | { kind: 'awaitStart'; submissionId: string };

interface UserUi {
  mode: Mode;
  // Разовая строка над списком: итог последнего действия или подсказка.
  notice: string | null;
  // Счётчики позиции: если пользователь писал после списка, список переезжает вниз.
  activity: number;
  listPostedAt: number;
  // Песня, чей фрагмент показан отдельным сообщением под списком.
  preview: string | null;
  // То же для сообщения с фрагментом; −1 — перенести его вниз при следующей отправке.
  previewPostedAt: number;
  // Автор нажал «Готово»: фрагмент остаётся в чате итоговой строкой, без кнопок сдвига.
  previewDone: boolean;
  // Сколько раз участник выбирал случайное начало: вместе с seed даёт воспроизводимый бросок.
  rolls: number;
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
const START_FORMAT = 'Напиши время, например 1:15; 0 — с начала. Или 🎲 — случайное место.';

// Сдвиги начала кнопками под фрагментом, секунд.
const SHIFTS = [-10, -5, 5, 10];

function newUi(): UserUi {
  return {
    mode: { kind: 'idle' },
    notice: null,
    activity: 0,
    listPostedAt: 0,
    preview: null,
    previewPostedAt: 0,
    previewDone: false,
    rolls: 0,
  };
}

export function openIntakeSession(config: IntakeSessionConfig): IntakeStep {
  const ui: Record<UserId, UserUi> = {};
  for (const p of config.participants) ui[p.id] = newUi();

  let intake = createIntake(config.rules);
  for (const { participant, files } of config.background) intake = receiveFiles(intake, participant.id, files);
  for (const s of pendingProcessing(intake)) intake = completeProcessing(intake, s.id, true);

  const session: IntakeSession = { config, intake, ui, closed: null };
  const welcome = config.participants.map((p) => welcomeMessage(session, p));
  return { session, out: [...welcome, ...render(session)] };
}

function welcomeMessage(session: IntakeSession, p: Participant): OutgoingMessage {
  const lines = [
    `Привет, ${p.name}! Собираем песни для турнира.`,
    '',
    `Пришли до ${session.config.rules.maxSubmissions} песен — пересылай пачкой, хоть все сразу, из @Music_to_you_bot или откуда удобно.`,
    'Исполнителя и название возьму из файла; если не получится — спрошу.',
    `Судья услышит фрагмент до ${session.config.fragmentSec} секунд — с начала песни, с места, которое выберешь сам, или со случайного.`,
    'На отбор и финал песни разделю сам после закрытия сбора.',
  ];
  if (isSongsOnly(session, p.id)) {
    lines.push('', '🎁 Ты только присылаешь песни: в жеребьёвку не попадёшь, но тебя могут позвать судить. Передумаешь — кнопка под списком.');
  }
  return { kind: 'message', to: p.id, slot: 'welcome', text: lines.join('\n') };
}

export function handleIntake(session: IntakeSession, input: Incoming): IntakeStep {
  const before = render(session);
  let next = session;

  if (input.kind === 'worker') {
    let intake = session.intake;
    for (const r of input.results) {
      // Нарезано с прежней длиной фрагмента — по новой уже стоит задача.
      if (r.fragmentSec !== undefined && r.fragmentSec !== session.config.fragmentSec) continue;
      intake = completeProcessing(intake, r.submissionId, r.ok, { startSec: r.startSec, gameFileId: r.gameFileId });
    }
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

// Участник зарегистрировался в боте во время сбора: получает приветствие и пустой список.
export function joinIntake(session: IntakeSession, participant: Participant, songsOnly = false): IntakeStep {
  if (allParticipants(session.config).some((p) => p.id === participant.id)) return { session, out: [] };
  const before = render(session);
  const config = {
    ...session.config,
    participants: [...session.config.participants, participant],
    songsOnly: songsOnly ? [...(session.config.songsOnly ?? []), participant.id] : session.config.songsOnly,
  };
  const ui = { ...session.ui, [participant.id]: newUi() };
  const next: IntakeSession = { ...session, config, ui };
  const step = emit(next, before);
  return { session: step.session, out: [welcomeMessage(next, participant), ...step.out] };
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

export function isSongsOnly(session: IntakeSession, userId: UserId): boolean {
  return session.config.songsOnly?.includes(userId) ?? false;
}

// Кто играет: все участники сбора, кроме тех, кто только присылает песни.
export function playingParticipants(session: IntakeSession): Participant[] {
  return allParticipants(session.config).filter((p) => !isSongsOnly(session, p.id));
}

export function underSubmitted(session: IntakeSession): Participant[] {
  const { maxSubmissions } = session.config.rules;
  return playingParticipants(session).filter((p) => acceptedCount(session, p.id) < maxSubmissions);
}

export function admittedPlayers(session: IntakeSession): Participant[] {
  const closed = session.closed;
  if (!closed) return [];
  const short = new Set(underSubmitted(session).map((p) => p.id));
  return playingParticipants(session).filter((p) => !short.has(p.id) || closed.decisions[p.id] === 'admit');
}

// Участник сам вышел из игры (/leave): песни остаются в пулах, в жеребьёвку он не попадает.
// Действует и после закрытия сбора — пока жеребьёвка не началась.
export function leaveIntake(session: IntakeSession, userId: UserId): IntakeStep {
  const before = render(session);
  const notice = '🎁 Ты больше не играешь — присланные песни остаются в турнире.';
  return emit(setUi(setSongsOnly(session, userId, true), userId, { mode: { kind: 'idle' }, notice }), before);
}

// Играет или только присылает песни. Переключают до закрытия сбора участник или организатор;
// после закрытия — только выход (/leave), без возврата.
function setSongsOnly(session: IntakeSession, userId: UserId, songsOnly: boolean): IntakeSession {
  const others = (session.config.songsOnly ?? []).filter((id) => id !== userId);
  return { ...session, config: { ...session.config, songsOnly: songsOnly ? [...others, userId] : others } };
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
  const { mode } = session.ui[from]!;
  if (mode.kind === 'awaitStart') return handleStartText(session, from, mode.submissionId, text);
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
  if (data === 'randomAll') return randomAll(session, from);
  if (data === 'role:songs' || data === 'role:play') {
    const songsOnly = data === 'role:songs';
    const notice = songsOnly
      ? '🎁 Готово: присылаешь песни, но не играешь. Передумаешь — кнопка ниже.'
      : '🎤 Готово: ты снова играешь.';
    return { session: setUi(setSongsOnly(session, from, songsOnly), from, { mode: { kind: 'idle' }, notice }) };
  }

  const shift = /^shift:(\w+):(-?\d+)$/.exec(data);
  if (shift) {
    const target = session.intake.submissions.find((s) => s.id === shift[1] && s.owner === from && !s.rejection);
    if (!target) return { toast: 'Этой песни уже нет в списке' };
    const startSec = shiftStart(target, Number(shift[2]), session.config.fragmentSec);
    if (startSec === target.startSec) return { toast: 'Дальше сдвигать некуда' };
    const intake = setStart(session.intake, target.id, startSec);
    return { session: setUi({ ...session, intake }, from, { preview: target.id, previewDone: false }) };
  }

  const done = /^done:(\w+)$/.exec(data);
  if (done) {
    if (session.ui[from]!.preview !== done[1]) return { toast: 'Этот фрагмент уже не актуален' };
    return { session: setUi(session, from, { previewDone: true }) };
  }

  const roll = /^random:(\w+)$/.exec(data);
  if (roll) {
    const target = session.intake.submissions.find((s) => s.id === roll[1] && s.owner === from && !s.rejection);
    if (!target) return { toast: 'Этой песни уже нет в списке' };
    return randomStart(session, from, target);
  }

  const pick = /^pick:(edit|remove|start|listen)$/.exec(data);
  if (pick) {
    const action = pick[1] as PickAction;
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
  if (mode.action === 'start') {
    return { session: setUi(session, from, { mode: { kind: 'awaitStart', submissionId: submission.id }, notice: null }) };
  }
  if (mode.action === 'listen') {
    return {
      session: setUi(session, from, { mode: { kind: 'idle' }, notice: null, preview: submission.id, previewPostedAt: -1, previewDone: false }),
    };
  }
  const intake = remove(session.intake, submission.id);
  return {
    session: setUi({ ...session, intake }, from, { mode: { kind: 'idle' }, notice: `Убрал «${labelOf(submission)}».` }),
  };
}

// --- Начало фрагмента -------------------------------------------------------

function handleStartText(session: IntakeSession, from: UserId, submissionId: string, text: string): IntakeSession {
  const target = session.intake.submissions.find((s) => s.id === submissionId);
  if (!target || target.rejection) return setUi(session, from, { mode: { kind: 'idle' }, notice: 'Этой песни уже нет в списке.' });
  const startSec = parseClock(text);
  if (startSec === null) return setUi(session, from, { notice: `Не разобрал «${text}». ${START_FORMAT}` });
  const latest = latestStart(target, session.config.fragmentSec);
  if (startSec > latest) {
    const duration = formatClock(target.file.durationSec!);
    return setUi(session, from, {
      notice: `Песня длится ${duration}, фрагмент ${session.config.fragmentSec} с — начало не позже ${formatClock(latest)}.`,
    });
  }
  const intake = setStart(session.intake, target.id, startSec);
  return setUi({ ...session, intake }, from, {
    mode: { kind: 'idle' },
    notice: `Песня ${numberOf(session, from, target.id)} начнётся с ${formatClock(startSec)}.`,
    preview: target.id,
    previewPostedAt: -1,
    previewDone: false,
  });
}

// Случайное начало одной песни: из подсказки «⏱ Начало» или из-под фрагмента.
function randomStart(session: IntakeSession, from: UserId, target: Submission): ButtonResult {
  if (target.file.durationSec === undefined) return { toast: 'Не знаю длину песни — напиши время сам' };
  const ui = session.ui[from]!;
  const roll = rollStart(target, session.config.fragmentSec, session.config.seed, ui.rolls);
  if (!roll) return { toast: 'Песня короткая — случайное место не выбрать' };
  const { startSec, rolls } = roll;
  const intake = setStart(session.intake, target.id, startSec);
  const fromPrompt = ui.mode.kind === 'awaitStart';
  return {
    session: setUi({ ...session, intake }, from, {
      rolls,
      preview: target.id,
      previewDone: false,
      ...(fromPrompt && {
        mode: { kind: 'idle' },
        notice: `Песня ${numberOf(session, from, target.id)} начнётся с ${formatClock(startSec)} — выбрал случайно.`,
        previewPostedAt: -1,
      }),
    }),
  };
}

// Случайное начало всем песням участника разом — для тех, кому выбирать незачем.
function randomAll(session: IntakeSession, from: UserId): ButtonResult {
  const songs = ordered(session, from).filter((s) => !s.rejection);
  if (songs.length === 0) return { toast: 'Пока нечего выбирать' };
  let { intake } = session;
  let rolls = session.ui[from]!.rolls;
  let changed = 0;
  for (const song of songs) {
    const roll = rollStart(song, session.config.fragmentSec, session.config.seed, rolls);
    if (!roll) continue;
    rolls = roll.rolls;
    intake = setStart(intake, song.id, roll.startSec);
    changed++;
  }
  if (changed === 0) return { toast: 'Песни короткие или без длины — случайное начало не выбрать' };
  const kept = songs.length - changed;
  const notice =
    `🎲 Случайное начало у ${changed} ${plural(changed, 'песни', 'песен', 'песен')}` +
    (kept > 0 ? `, у ${kept} — прежнее: короткие или без длины` : '') +
    '. Послушать — «🎧 Послушать».';
  return { session: setUi({ ...session, intake }, from, { mode: { kind: 'idle' }, rolls, notice }) };
}

// --- Организатор ------------------------------------------------------------

function handleOrganizer(session: IntakeSession, data: string): ButtonResult {
  if (data === 'closeIntake') {
    if (session.closed) return { toast: 'Сбор уже закрыт' };
    const { finalPoolTarget, seed } = session.config;
    const split = splitPools(acceptedSongs(session.intake), finalPoolTarget, seed);
    return { session: { ...session, closed: { split, decisions: {} } } };
  }
  const role = /^(songsOnly|player):(.+)$/.exec(data);
  if (role) {
    if (session.closed) return { toast: 'Сбор уже закрыт' };
    if (!session.config.participants.some((p) => p.id === role[2])) return { toast: 'Этого участника нет в сборе' };
    return { session: setSongsOnly(session, role[2]!, role[1] === 'songsOnly') };
  }
  const decision = /^(admit|exclude):(.+)$/.exec(data);
  if (decision && session.closed) {
    const [, verdict, userId] = decision;
    const decisions = { ...session.closed.decisions, [userId!]: verdict as AdmissionDecision };
    return { session: { ...session, closed: { ...session.closed, decisions } } };
  }
  return { toast: 'Сейчас это действие недоступно' };
}

// --- Общее ------------------------------------------------------------------

function setUi(session: IntakeSession, userId: UserId, patch: Partial<UserUi>): IntakeSession {
  return { ...session, ui: { ...session.ui, [userId]: { ...session.ui[userId]!, ...patch } } };
}

// Песня, для которой бот ждёт название: выбранная вручную или первая без названия.
function titleTarget(session: IntakeSession, userId: UserId): Submission | undefined {
  const { mode } = session.ui[userId]!;
  if (mode.kind === 'awaitTitle') return session.intake.submissions.find((s) => s.id === mode.submissionId);
  return ordered(session, userId).find((s) => statusOf(s) === 'needs_title');
}

function candidates(session: IntakeSession, userId: UserId, action: PickAction): Submission[] {
  const list = ordered(session, userId);
  return action === 'remove' ? list : list.filter((s) => !s.rejection);
}

// Порядок в списке и номера: сначала рабочие заявки, затем не подошедшие.
function ordered(session: IntakeSession, userId: UserId): Submission[] {
  const own = submissionsOf(session.intake, userId);
  return [...own.filter((s) => !s.rejection), ...own.filter((s) => s.rejection)];
}

// Номер песни в списке участника — как он её видит.
function numberOf(session: IntakeSession, userId: UserId, submissionId: string): number {
  return ordered(session, userId).findIndex((s) => s.id === submissionId) + 1;
}

// --- Рендер -----------------------------------------------------------------

// Отправляем только изменившиеся сообщения. Список того, кто сам что-то написал, переотправляется
// всегда: иначе на сообщение без изменений участник не увидит реакции.
function emit(next: IntakeSession, before: OutgoingMessage[], author?: UserId): IntakeStep {
  const previous = new Map(before.map((m) => [`${m.to}/${m.slot}`, JSON.stringify(m)]));
  const out: OutgoingMessage[] = [];
  let session = next;
  for (const message of render(next)) {
    const ui = session.ui[message.to];
    const unchanged = previous.get(`${message.to}/${message.slot}`) === JSON.stringify(message);
    // Фрагмент, который попросили послушать ещё раз, переотправляется вниз, даже если не изменился.
    const recalled = message.slot === 'preview' && ui !== undefined && ui.previewPostedAt < 0;
    if (unchanged && !recalled && !(message.to === author && message.slot === 'list')) continue;
    if (ui && message.slot === 'list' && ui.activity > ui.listPostedAt) {
      out.push({ ...message, bump: true });
      session = setUi(session, message.to, { listPostedAt: ui.activity });
    } else if (ui && message.slot === 'preview' && ui.activity > ui.previewPostedAt) {
      out.push({ ...message, bump: true });
      session = setUi(session, message.to, { previewPostedAt: ui.activity });
    } else {
      out.push(message);
    }
  }
  return { session, out };
}

export function render(session: IntakeSession): OutgoingMessage[] {
  const { participants } = session.config;
  const previews = participants.flatMap((p) => renderPreview(session, p.id) ?? []);
  return [...participants.map((p) => renderList(session, p.id)), ...previews, renderOrganizer(session)];
}

function renderList(session: IntakeSession, userId: UserId): OutgoingMessage {
  const { maxSubmissions } = session.config.rules;
  const ui = session.ui[userId]!;
  const list = ordered(session, userId);
  const number = new Map(list.map((s, i) => [s.id, i + 1]));
  const accepted = acceptedCount(session, userId);
  const lines: string[] = [];

  const songsOnly = isSongsOnly(session, userId);
  if (session.closed) {
    lines.push(
      `🔒 Сбор закрыт · принято ${accepted} из ${maxSubmissions}`,
      songsOnly ? 'Спасибо за песни! Ты не играешь, но тебя могут позвать судить.' : 'Дальше жеребьёвка — пару пришлю сюда.',
    );
  } else if (songsOnly) {
    lines.push(
      `🎁 Твои песни · принято ${accepted} из ${maxSubmissions}`,
      'Ты только присылаешь песни — в жеребьёвку не попадёшь. Проверь названия: по ним судья засчитывает ответы.',
    );
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
  for (const s of active) lines.push(`${number.get(s.id)}. ${labelOf(s)} ${statusMark(s)} · с ${formatClock(s.startSec)}`);
  const rejected = list.filter((s) => s.rejection);
  if (rejected.length > 0) {
    lines.push('', 'Не подошло — пришли замену:');
    for (const s of rejected) lines.push(`${number.get(s.id)}. ${labelOf(s)} — ${REJECT_TEXT[s.rejection!]}`);
  }

  const footer: string[] = [];
  if (ui.notice) footer.push(ui.notice);
  const target = session.closed ? undefined : titleTarget(session, userId);
  const { mode } = ui;
  if (target && mode.kind !== 'pick' && mode.kind !== 'awaitStart') {
    footer.push(
      mode.kind === 'awaitTitle'
        ? `✏️ Песня ${number.get(target.id)}: сейчас «${labelOf(target)}». ${TITLE_FORMAT}`
        : `✏️ Песня ${number.get(target.id)} (${target.file.fileName ?? 'без имени'}): не нашёл название. ${TITLE_FORMAT}`,
    );
  }
  if (mode.kind === 'awaitStart') {
    const song = list.find((s) => s.id === mode.submissionId);
    if (song) {
      footer.push(`⏱ Песня ${number.get(song.id)}: сейчас с ${formatClock(song.startSec)}. С какого момента её играть? ${START_FORMAT}`);
    }
  }
  if (mode.kind === 'pick') footer.push(PICK_PROMPT[mode.action]);
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
  if (mode.kind === 'awaitStart') {
    return [
      [
        { label: '🎲 Случайно', data: `random:${mode.submissionId}` },
        { label: 'Отмена', data: 'cancel' },
      ],
    ];
  }
  if (mode.kind === 'awaitTitle') return [[{ label: 'Отмена', data: 'cancel' }]];
  const role: Button = isSongsOnly(session, userId)
    ? { label: '🎤 Всё-таки играю', data: 'role:play' }
    : { label: '🎁 Не играю, только песни', data: 'role:songs' };
  if (list.length === 0) return [[role]];
  return [
    [
      { label: '✏️ Исправить', data: 'pick:edit' },
      { label: '🗑 Убрать', data: 'pick:remove' },
    ],
    [
      { label: '⏱ Начало', data: 'pick:start' },
      { label: '🎧 Послушать', data: 'pick:listen' },
    ],
    [{ label: '🎲 Случайное начало всем', data: 'randomAll' }],
    [role],
  ];
}

const PICK_PROMPT: Record<PickAction, string> = {
  edit: 'Какую песню исправить?',
  remove: 'Какую песню убрать?',
  start: 'Для какой песни выбрать начало?',
  listen: 'Какую песню послушать?',
};

// Фрагмент песни так, как его услышит судья, и кнопки сдвига начала.
function renderPreview(session: IntakeSession, userId: UserId): OutgoingMessage | undefined {
  const { preview, previewDone } = session.ui[userId]!;
  const list = ordered(session, userId);
  const song = list.find((s) => s.id === preview);
  if (!song || song.rejection) return undefined;
  const audio: OutgoingMessage['audio'] = song.gameFileId
    ? { title: 'Трек', performer: 'Музыкальный турнир', fileId: song.gameFileId }
    : undefined;

  if (previewDone) {
    return {
      kind: 'message',
      to: userId,
      slot: 'preview',
      text: `✅ Песня ${numberOf(session, userId, song.id)}: ${labelOf(song)}\nНачнётся с ${formatClock(song.startSec)}.`,
      audio,
    };
  }

  const status =
    song.processing === 'pending'
      ? '⏳ Нарезаю фрагмент…'
      : song.gameFileId
        ? 'Так её услышит судья.'
        : 'Фрагменты сейчас не нарезаются — судья включит песню сам с этого места.';
  const lines = [
    `🎧 Песня ${numberOf(session, userId, song.id)}: ${labelOf(song)}`,
    `Начало ${formatClock(song.startSec)} · до ${session.config.fragmentSec} с`,
    status,
  ];
  if (!session.closed) lines.push('Сдвинуть начало или выбрать случайно:');

  return {
    kind: 'message',
    to: userId,
    slot: 'preview',
    text: lines.join('\n'),
    audio,
    buttons: session.closed
      ? undefined
      : [
          SHIFTS.map((d) => ({ label: d < 0 ? `−${-d} с` : `+${d} с`, data: `shift:${song.id}:${d}` })),
          [
            { label: '🎲 Случайно', data: `random:${song.id}` },
            { label: '✅ Готово', data: `done:${song.id}` },
          ],
        ],
  };
}

function renderOrganizer(session: IntakeSession): OutgoingMessage {
  const { config, intake, closed } = session;
  const { maxSubmissions } = config.rules;
  const people = allParticipants(config);
  const playing = playingParticipants(session);
  const donors = people.filter((p) => isSongsOnly(session, p.id));
  const songs = acceptedSongs(intake);
  const acceptedTotal = intake.submissions.filter((s) => statusOf(s) === 'accepted').length;
  const full = playing.filter((p) => acceptedCount(session, p.id) === maxSubmissions).length;
  const short = underSubmitted(session);
  const lines = [closed ? '🔒 Сбор закрыт' : '📥 Сбор треков', ''];

  const who = donors.length > 0 ? ` (играют ${playing.length}, только песни ${donors.length})` : '';
  lines.push(
    `Участников: ${people.length}${who} · сдали все ${maxSubmissions}: ${full}`,
    `Принято заявок: ${acceptedTotal} · уникальных песен: ${songs.length}` +
      (acceptedTotal > songs.length ? ` (склеено дублей: ${acceptedTotal - songs.length})` : ''),
  );
  if (donors.length > 0) {
    lines.push(`🎁 Только песни: ${donors.map((p) => `${p.name} — ${acceptedCount(session, p.id)}`).join(', ')}`);
  }

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
