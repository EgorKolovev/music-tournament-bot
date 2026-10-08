import { fromFileName, fromTags, songKey, type SongMeta } from './titles.ts';

// Сбор заявок: квоты двух пулов, проверка файлов, дубли и учёт знакомства с песней
// (docs/architecture.md, разделы 2, 5 и 7). Скачивание и ffmpeg — во внешнем worker,
// сюда приходит только его вердикт.

export type Pool = 'main' | 'final';

export interface IntakeRules {
  quota: Record<Pool, number>;
  maxBytes: number;
  acceptedMimeTypes: readonly string[];
}

export const DEFAULT_INTAKE_RULES: IntakeRules = {
  quota: { main: 6, final: 4 },
  // Предел getFile облачного Bot API.
  maxBytes: 20 * 1024 * 1024,
  acceptedMimeTypes: ['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac'],
};

// То, что Telegram сообщает о присланном аудио или документе.
export interface AudioFile {
  fileId: string;
  // Одинаков у одного и того же файла для всех ботов и пользователей.
  fileUniqueId: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes: number;
  durationSec?: number;
  performer?: string;
  title?: string;
}

export type RejectReason = 'too_large' | 'bad_format' | 'corrupt' | 'duplicate_other' | 'duplicate_own' | 'quota_full';

export interface Submission {
  id: string;
  owner: string;
  file: AudioFile;
  // null — заявка не принята и не занимает место в квоте.
  pool: Pool | null;
  meta: SongMeta | null;
  processing: 'pending' | 'ok' | 'failed';
  rejection: RejectReason | null;
}

export type SubmissionStatus = 'accepted' | 'processing' | 'needs_title' | 'rejected';

export interface SongIndexEntry {
  // Заявка, которая сейчас представляет эту песню в библиотеке.
  submissionId: string | null;
  // Все, кто присылал песню. Факт знакомства не стирается при удалении заявки.
  knownBy: string[];
}

export interface IntakeState {
  rules: IntakeRules;
  submissions: Submission[];
  songs: Record<string, SongIndexEntry>;
  nextId: number;
}

export function createIntake(rules: IntakeRules): IntakeState {
  return { rules, submissions: [], songs: {}, nextId: 1 };
}

export function statusOf(submission: Submission): SubmissionStatus {
  if (submission.rejection) return 'rejected';
  if (!submission.meta) return 'needs_title';
  if (submission.processing === 'pending') return 'processing';
  return 'accepted';
}

export function submissionsOf(state: IntakeState, owner: string): Submission[] {
  return state.submissions.filter((s) => s.owner === owner);
}

export function poolCount(state: IntakeState, owner: string, pool: Pool): number {
  return submissionsOf(state, owner).filter((s) => s.pool === pool).length;
}

// Принимает пачку файлов; пул назначается сам: сначала отбор, потом финал.
export function receiveFiles(state: IntakeState, owner: string, files: readonly AudioFile[]): IntakeState {
  for (const file of files) state = receiveFile(state, owner, file);
  return state;
}

function receiveFile(state: IntakeState, owner: string, file: AudioFile): IntakeState {
  const id = `s${state.nextId}`;
  let submission: Submission = {
    id,
    owner,
    file,
    pool: null,
    meta: fromTags(file.performer, file.title) ?? fromFileName(file.fileName),
    processing: 'pending',
    rejection: null,
  };
  state = { ...state, nextId: state.nextId + 1 };

  const sameFile = submissionsOf(state, owner).some(
    (s) => s.file.fileUniqueId === file.fileUniqueId && s.rejection === null,
  );
  if (file.sizeBytes > state.rules.maxBytes) submission = reject(submission, 'too_large');
  else if (!file.mimeType || !state.rules.acceptedMimeTypes.includes(file.mimeType)) {
    submission = reject(submission, 'bad_format');
  } else if (sameFile) submission = reject(submission, 'duplicate_own');
  else {
    const pool = freePool(state, owner);
    submission = pool ? { ...submission, pool } : reject(submission, 'quota_full');
  }

  state = { ...state, submissions: [...state.submissions, submission] };
  return submission.rejection ? state : claimSong(state, id);
}

export function setTitle(state: IntakeState, submissionId: string, meta: SongMeta): IntakeState {
  const current = find(state, submissionId);
  if (!current || current.rejection) return state;
  state = releaseSong(state, current);
  state = update(state, submissionId, { meta });
  return claimSong(state, submissionId);
}

export function remove(state: IntakeState, submissionId: string): IntakeState {
  const current = find(state, submissionId);
  if (!current) return state;
  state = releaseSong(state, current);
  return { ...state, submissions: state.submissions.filter((s) => s.id !== submissionId) };
}

export type MoveResult = { ok: true; state: IntakeState } | { ok: false; error: 'target_full' | 'not_in_pool' };

export function moveToOtherPool(state: IntakeState, submissionId: string): MoveResult {
  const current = find(state, submissionId);
  if (!current?.pool) return { ok: false, error: 'not_in_pool' };
  const target = otherPool(current.pool);
  if (poolCount(state, current.owner, target) >= state.rules.quota[target]) return { ok: false, error: 'target_full' };
  return { ok: true, state: update(state, submissionId, { pool: target }) };
}

export function swapPools(state: IntakeState, firstId: string, secondId: string): MoveResult {
  const first = find(state, firstId);
  const second = find(state, secondId);
  if (!first?.pool || !second?.pool || first.pool === second.pool || first.owner !== second.owner) {
    return { ok: false, error: 'not_in_pool' };
  }
  state = update(state, firstId, { pool: second.pool });
  return { ok: true, state: update(state, secondId, { pool: first.pool }) };
}

// Вердикт worker: файл декодируется и игровая версия собрана, либо файл битый.
export function completeProcessing(state: IntakeState, submissionId: string, ok: boolean): IntakeState {
  const current = find(state, submissionId);
  if (!current || current.processing !== 'pending' || current.rejection) return state;
  if (ok) return update(state, submissionId, { processing: 'ok' });
  state = releaseSong(state, current);
  return update(state, submissionId, { processing: 'failed', rejection: 'corrupt', pool: null });
}

export function pendingProcessing(state: IntakeState): Submission[] {
  return state.submissions.filter((s) => s.processing === 'pending' && !s.rejection);
}

function freePool(state: IntakeState, owner: string): Pool | null {
  for (const pool of ['main', 'final'] as const) {
    if (poolCount(state, owner, pool) < state.rules.quota[pool]) return pool;
  }
  return null;
}

// Связывает заявку с музыкальной идентичностью. Песня, уже представленная другой заявкой,
// делает новую дублем, но её автор всё равно записывается в знающие.
function claimSong(state: IntakeState, submissionId: string): IntakeState {
  const submission = find(state, submissionId)!;
  if (!submission.meta) return state;
  const key = songKey(submission.meta.artist, submission.meta.title);
  const entry = state.songs[key] ?? { submissionId: null, knownBy: [] };
  const knownBy = entry.knownBy.includes(submission.owner) ? entry.knownBy : [...entry.knownBy, submission.owner];

  if (entry.submissionId !== null && entry.submissionId !== submissionId) {
    const holder = find(state, entry.submissionId)!;
    state = { ...state, songs: { ...state.songs, [key]: { ...entry, knownBy } } };
    const reason: RejectReason = holder.owner === submission.owner ? 'duplicate_own' : 'duplicate_other';
    return update(state, submissionId, { rejection: reason, pool: null });
  }
  return { ...state, songs: { ...state.songs, [key]: { submissionId, knownBy } } };
}

function releaseSong(state: IntakeState, submission: Submission): IntakeState {
  if (!submission.meta) return state;
  const key = songKey(submission.meta.artist, submission.meta.title);
  const entry = state.songs[key];
  if (!entry || entry.submissionId !== submission.id) return state;
  return { ...state, songs: { ...state.songs, [key]: { ...entry, submissionId: null } } };
}

function reject(submission: Submission, reason: RejectReason): Submission {
  return { ...submission, rejection: reason, pool: null };
}

function otherPool(pool: Pool): Pool {
  return pool === 'main' ? 'final' : 'main';
}

function find(state: IntakeState, id: string): Submission | undefined {
  return state.submissions.find((s) => s.id === id);
}

function update(state: IntakeState, id: string, patch: Partial<Submission>): IntakeState {
  return { ...state, submissions: state.submissions.map((s) => (s.id === id ? { ...s, ...patch } : s)) };
}
