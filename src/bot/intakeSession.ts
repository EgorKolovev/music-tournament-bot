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
import { textsOf } from '../texts/index.ts';
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
  // Стиль текстов участника (src/texts); нет — основной.
  styles?: Record<UserId, string>;
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

// Тексты сбора для участника — в его стиле.
function tx(session: IntakeSession, userId: UserId) {
  return textsOf(session.config.styles, userId).intake;
}

// Почему песня не подошла; лимит песен — из настроек турнира.
function rejectText(session: IntakeSession, userId: UserId, reason: RejectReason): string {
  const { reject } = tx(session, userId);
  const texts: Record<RejectReason, string> = {
    too_large: reject.tooLarge,
    bad_format: reject.badFormat,
    corrupt: reject.corrupt,
    duplicate_own: reject.duplicateOwn,
    quota_full: reject.quotaFull({ max: session.config.rules.maxSubmissions }),
  };
  return texts[reason];
}

// Запас подходящих песен на один короткий отборочный матч (раздел 4 пересмотра механики).
const MIN_SONGS_PER_QUALIFIER = 10;


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
  return { session, out: render(session) };
}

// Вводное к сбору — от лица организаторов («мы»), в отличие от остальных сообщений бота;
// что делает бот, рассказано о нём в третьем лице.
// Лимит песен и длина фрагмента — из настроек: поменял их организатор — сообщение правится
// на месте, как и список песен.
function welcomeMessage(session: IntakeSession, p: Participant): OutgoingMessage {
  const { rules, fragmentSec } = session.config;
  const { welcome } = tx(session, p.id);
  const lines = [
    welcome.hello({ name: p.name }),
    '',
    welcome.send({ max: rules.maxSubmissions }),
    '',
    welcome.titles,
    '',
    welcome.fragment({ sec: fragmentSec }),
    '',
    welcome.pools,
  ];
  if (isSongsOnly(session, p.id)) lines.push('', welcome.songsOnly);
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
      if (session.closed) return { session, out: [{ kind: 'toast', to: input.from, text: tx(session, input.from).toast.closed }] };
      const result = handleButton(session, input.from, input.data);
      if ('toast' in result) return { session, out: [{ kind: 'toast', to: input.from, text: result.toast }] };
      next = result.session;
    } else {
      if (session.closed) {
        next = setUi(session, input.from, { notice: tx(session, input.from).notice.closed });
      } else {
        next = input.kind === 'files' ? handleFiles(session, input.from, input.files) : handleText(session, input.from, input.text);
      }
      next = setUi(next, input.from, { activity: ui.activity + 1 });
    }
  }

  const author = input.kind === 'text' || input.kind === 'files' ? input.from : undefined;
  return emit(next, before, author);
}

// Участник зарегистрировался в боте во время сбора: получает вводное и пустой список.
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
  return emit(next, before);
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
  const notice = tx(session, userId).notice.left;
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
  const { notice: texts } = tx(session, from);
  const thanks = added.length > 0 && !rejected ? texts.thanks({ total: submissionsOf(intake, from).length }) : '';
  const notice = [texts.received({ count: added.length, rejected }), thanks].filter(Boolean).join(' ');
  return setUi({ ...session, intake }, from, { notice, mode: { kind: 'idle' } });
}

function handleText(session: IntakeSession, from: UserId, text: string): IntakeSession {
  const { mode } = session.ui[from]!;
  if (mode.kind === 'awaitStart') return handleStartText(session, from, mode.submissionId, text);
  const target = titleTarget(session, from);
  const { notice: texts } = tx(session, from);
  if (!target) return setUi(session, from, { notice: texts.editHint });
  const meta = fromText(text);
  if (!meta) return setUi(session, from, { notice: texts.badTitle({ text }) });

  const intake = setTitle(session.intake, target.id, meta);
  const updated = intake.submissions.find((s) => s.id === target.id)!;
  const label = `${meta.artist} — ${meta.title}`;
  const notice = updated.rejection
    ? texts.titleRejected({ label, reason: rejectText(session, from, updated.rejection) })
    : texts.titleSaved({ label });
  return setUi({ ...session, intake }, from, { notice, mode: { kind: 'idle' } });
}

type ButtonResult = { session: IntakeSession } | { toast: string };

function handleButton(session: IntakeSession, from: UserId, data: string): ButtonResult {
  const { notice: texts, toast } = tx(session, from);
  if (data === 'cancel') return { session: setUi(session, from, { mode: { kind: 'idle' }, notice: null }) };
  if (data === 'randomAll') return randomAll(session, from);
  if (data === 'role:songs' || data === 'role:play') {
    const songsOnly = data === 'role:songs';
    const notice = songsOnly ? texts.songsOnly : texts.playing;
    return { session: setUi(setSongsOnly(session, from, songsOnly), from, { mode: { kind: 'idle' }, notice }) };
  }

  const shift = /^shift:(\w+):(-?\d+)$/.exec(data);
  if (shift) {
    const target = session.intake.submissions.find((s) => s.id === shift[1] && s.owner === from && !s.rejection);
    if (!target) return { toast: toast.gone };
    const startSec = shiftStart(target, Number(shift[2]), session.config.fragmentSec);
    if (startSec === target.startSec) return { toast: toast.noFurther };
    const intake = setStart(session.intake, target.id, startSec);
    return { session: setUi({ ...session, intake }, from, { preview: target.id, previewDone: false }) };
  }

  const done = /^done:(\w+)$/.exec(data);
  if (done) {
    if (session.ui[from]!.preview !== done[1]) return { toast: toast.stalePreview };
    return { session: setUi(session, from, { previewDone: true }) };
  }

  const roll = /^random:(\w+)$/.exec(data);
  if (roll) {
    const target = session.intake.submissions.find((s) => s.id === roll[1] && s.owner === from && !s.rejection);
    if (!target) return { toast: toast.gone };
    return randomStart(session, from, target);
  }

  const pick = /^pick:(edit|remove|start|listen)$/.exec(data);
  if (pick) {
    const action = pick[1] as PickAction;
    if (candidates(session, from, action).length === 0) return { toast: toast.nothing };
    return { session: setUi(session, from, { mode: { kind: 'pick', action }, notice: null }) };
  }

  const chosen = /^n:(\w+)$/.exec(data);
  const submission = chosen && session.intake.submissions.find((s) => s.id === chosen[1] && s.owner === from);
  if (!submission) return { toast: toast.gone };
  const { mode } = session.ui[from]!;
  if (mode.kind !== 'pick') return { toast: toast.pickFirst };

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
    session: setUi({ ...session, intake }, from, { mode: { kind: 'idle' }, notice: texts.removed({ label: labelOf(session, from, submission) }) }),
  };
}

// --- Начало фрагмента -------------------------------------------------------

function handleStartText(session: IntakeSession, from: UserId, submissionId: string, text: string): IntakeSession {
  const target = session.intake.submissions.find((s) => s.id === submissionId);
  const { notice: texts } = tx(session, from);
  if (!target || target.rejection) return setUi(session, from, { mode: { kind: 'idle' }, notice: texts.gone });
  const startSec = parseClock(text);
  if (startSec === null) return setUi(session, from, { notice: texts.badStart({ text }) });
  const { fragmentSec } = session.config;
  const latest = latestStart(target, fragmentSec);
  if (startSec > latest) {
    const duration = formatClock(target.file.durationSec!);
    return setUi(session, from, { notice: texts.tooLate({ duration, sec: fragmentSec, latest: formatClock(latest) }) });
  }
  const intake = setStart(session.intake, target.id, startSec);
  return setUi({ ...session, intake }, from, {
    mode: { kind: 'idle' },
    notice: texts.start({ n: numberOf(session, from, target.id), start: formatClock(startSec) }),
    preview: target.id,
    previewPostedAt: -1,
    previewDone: false,
  });
}

// Случайное начало одной песни: из подсказки «⏱ Начало» или из-под фрагмента.
function randomStart(session: IntakeSession, from: UserId, target: Submission): ButtonResult {
  const { notice: texts, toast } = tx(session, from);
  if (target.file.durationSec === undefined) return { toast: toast.noDuration };
  const ui = session.ui[from]!;
  const roll = rollStart(target, session.config.fragmentSec, session.config.seed, ui.rolls);
  if (!roll) return { toast: toast.tooShort };
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
        notice: texts.randomStart({ n: numberOf(session, from, target.id), start: formatClock(startSec) }),
        previewPostedAt: -1,
      }),
    }),
  };
}

// Случайное начало всем песням участника разом — для тех, кому выбирать незачем.
function randomAll(session: IntakeSession, from: UserId): ButtonResult {
  const songs = ordered(session, from).filter((s) => !s.rejection);
  const { notice: texts, toast } = tx(session, from);
  if (songs.length === 0) return { toast: toast.nothing };
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
  if (changed === 0) return { toast: toast.allTooShort };
  const notice = texts.randomAll({ changed, kept: songs.length - changed });
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
  return { toast: 'Сейчас эта кнопка не работает' };
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
  const own = participants.flatMap((p) => [welcomeMessage(session, p), renderList(session, p.id)]);
  return [...own, ...previews, renderOrganizer(session)];
}

function renderList(session: IntakeSession, userId: UserId): OutgoingMessage {
  const { maxSubmissions: max } = session.config.rules;
  const { list: texts } = tx(session, userId);
  const ui = session.ui[userId]!;
  const list = ordered(session, userId);
  const number = new Map(list.map((s, i) => [s.id, i + 1]));
  const accepted = acceptedCount(session, userId);
  const lines: string[] = [];

  const songsOnly = isSongsOnly(session, userId);
  if (session.closed) lines.push(texts.closed({ accepted, max }), songsOnly ? texts.closedSongsOnly : texts.closedPlaying);
  else if (songsOnly) lines.push(texts.songsOnly({ accepted, max }), texts.songsOnlyHint);
  else if (accepted === max) lines.push(texts.full({ max }), texts.fullHint);
  else lines.push(texts.progress({ accepted, max }), texts.progressHint);

  const active = list.filter((s) => !s.rejection);
  if (active.length > 0) lines.push('');
  const label = (s: Submission) => labelOf(session, userId, s);
  for (const s of active) lines.push(texts.song({ n: number.get(s.id)!, label: label(s), mark: statusMark(s), start: formatClock(s.startSec) }));
  const rejected = list.filter((s) => s.rejection);
  if (rejected.length > 0) {
    lines.push('', texts.rejectedTitle);
    for (const s of rejected) lines.push(texts.rejected({ n: number.get(s.id)!, label: label(s), reason: rejectText(session, userId, s.rejection!) }));
  }

  const footer: string[] = [];
  if (ui.notice) footer.push(ui.notice);
  const target = session.closed ? undefined : titleTarget(session, userId);
  const { mode } = ui;
  if (target && mode.kind !== 'pick' && mode.kind !== 'awaitStart') {
    const n = number.get(target.id)!;
    footer.push(
      mode.kind === 'awaitTitle'
        ? texts.askTitle({ n, label: label(target) })
        : texts.noTitle({ n, file: target.file.fileName ?? texts.noName }),
    );
  }
  if (mode.kind === 'awaitStart') {
    const song = list.find((s) => s.id === mode.submissionId);
    if (song) {
      footer.push(texts.askStart({ n: number.get(song.id)!, start: formatClock(song.startSec) }));
    }
  }
  if (mode.kind === 'pick') footer.push(texts.pick[mode.action]);
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
  const { buttons: texts } = tx(session, userId);
  const cancel: Button = { label: texts.cancel, data: 'cancel' };
  if (mode.kind === 'pick') {
    const items = candidates(session, userId, mode.action);
    const rows: Button[][] = [];
    for (let i = 0; i < items.length; i += 5) {
      rows.push(items.slice(i, i + 5).map((s) => ({ label: String(number.get(s.id)), data: `n:${s.id}` })));
    }
    return [...rows, [cancel]];
  }
  if (mode.kind === 'awaitStart') return [[{ label: texts.random, data: `random:${mode.submissionId}` }, cancel]];
  if (mode.kind === 'awaitTitle') return [[cancel]];
  const role: Button = isSongsOnly(session, userId) ? { label: texts.play, data: 'role:play' } : { label: texts.songsOnly, data: 'role:songs' };
  if (list.length === 0) return [[role]];
  return [
    [
      { label: texts.edit, data: 'pick:edit' },
      { label: texts.remove, data: 'pick:remove' },
    ],
    [
      { label: texts.start, data: 'pick:start' },
      { label: texts.listen, data: 'pick:listen' },
    ],
    [{ label: texts.randomAll, data: 'randomAll' }],
    [role],
  ];
}

// Фрагмент песни так, как его услышит судья, и кнопки сдвига начала.
function renderPreview(session: IntakeSession, userId: UserId): OutgoingMessage | undefined {
  const { preview, previewDone } = session.ui[userId]!;
  const list = ordered(session, userId);
  const song = list.find((s) => s.id === preview);
  if (!song || song.rejection) return undefined;
  const { preview: texts, buttons } = tx(session, userId);
  const n = numberOf(session, userId, song.id);
  const label = labelOf(session, userId, song);
  const audio: OutgoingMessage['audio'] = song.gameFileId
    ? { title: 'Трек', performer: 'Музыкальный турнир', fileId: song.gameFileId }
    : undefined;

  if (previewDone) {
    return {
      kind: 'message',
      to: userId,
      slot: 'preview',
      text: texts.done({ n, label, start: formatClock(song.startSec) }),
      audio,
    };
  }

  const status = song.processing === 'pending' ? texts.cutting : song.gameFileId ? texts.ready : texts.noCut;
  const lines = [texts.title({ n, label }), texts.start({ start: formatClock(song.startSec), sec: session.config.fragmentSec }), status];
  if (!session.closed) lines.push(texts.shift);

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
            { label: buttons.random, data: `random:${song.id}` },
            { label: buttons.done, data: `done:${song.id}` },
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
  const lines = [closed ? '🔒 Сбор закрыт' : '📥 Сбор песен', ''];

  const who = donors.length > 0 ? ` (играют ${playing.length}, только песни ${donors.length})` : '';
  lines.push(
    `Участников: ${people.length}${who} · сдали все ${maxSubmissions}: ${full}`,
    `Принято песен: ${acceptedTotal} · разных: ${songs.length}` +
      (acceptedTotal > songs.length ? ` (одинаковых склеено: ${acceptedTotal - songs.length})` : ''),
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
      const mark = decision === 'admit' ? '✅ играет' : decision === 'exclude' ? '✖ не играет' : '⏳ ждёт решения';
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
    `Песни разделены (seed ${split.seed}):`,
    `${finalOk ? '✅' : '⚠️'} Финал: ${split.final.length} из нужных ~${split.finalTarget}`,
    `${mainOk ? '✅' : '⚠️'} Отбор: ${split.main.length} ${plural(split.main.length, 'песня', 'песни', 'песен')} на ${qualifierMatches} ${plural(qualifierMatches, 'матч', 'матча', 'матчей')} — на матч нужно ~${MIN_SONGS_PER_QUALIFIER} подходящих, у разных пар песни могут повторяться`,
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

function labelOf(session: IntakeSession, userId: UserId, s: Submission): string {
  return s.meta ? `${s.meta.artist} — ${s.meta.title}` : (s.file.fileName ?? tx(session, userId).list.noName);
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
