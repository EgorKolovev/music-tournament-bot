import { fromFileName, fromTags, songKey, type SongMeta } from './titles.ts';

// Сбор заявок: квота, проверка файлов, склейка дублей и учёт знакомства с песней
// (docs/decisions/2026-10-08-mechanics-revision.md, разделы 4–6). Пул игрок не выбирает:
// бот делит песни после закрытия сбора (pools.ts). Скачивание и ffmpeg — во внешнем worker,
// сюда приходит только его вердикт.

export interface IntakeRules {
  maxSubmissions: number;
  maxBytes: number;
  acceptedMimeTypes: readonly string[];
}

export const DEFAULT_INTAKE_RULES: IntakeRules = {
  maxSubmissions: 10,
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

// Чужой дубль не отклоняется: игрок не должен узнавать, что песня уже есть в библиотеке.
export type RejectReason = 'too_large' | 'bad_format' | 'corrupt' | 'duplicate_own' | 'quota_full';

export interface Submission {
  id: string;
  owner: string;
  file: AudioFile;
  meta: SongMeta | null;
  processing: 'pending' | 'ok' | 'failed';
  rejection: RejectReason | null;
}

export type SubmissionStatus = 'accepted' | 'processing' | 'needs_title' | 'rejected';

export interface SongIndexEntry {
  // Заявки, склеенные в эту песню; пусто — песню убрали из всех заявок.
  submissionIds: string[];
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

// Заявки, занимающие место в квоте: всё, кроме отклонённых.
export function activeCount(state: IntakeState, owner: string): number {
  return submissionsOf(state, owner).filter((s) => !s.rejection).length;
}

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
  else if (activeCount(state, owner) >= state.rules.maxSubmissions) submission = reject(submission, 'quota_full');

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

// Вердикт worker: файл декодируется и игровая версия собрана, либо файл битый.
export function completeProcessing(state: IntakeState, submissionId: string, ok: boolean): IntakeState {
  const current = find(state, submissionId);
  if (!current || current.processing !== 'pending' || current.rejection) return state;
  if (ok) return update(state, submissionId, { processing: 'ok' });
  state = releaseSong(state, current);
  return update(state, submissionId, { processing: 'failed', rejection: 'corrupt' });
}

export function pendingProcessing(state: IntakeState): Submission[] {
  return state.submissions.filter((s) => s.processing === 'pending' && !s.rejection);
}

// Песни библиотеки: уникальные после склейки, с принятыми заявками.
export interface LibrarySongRef {
  key: string;
  meta: SongMeta;
  submissionIds: string[];
  knownBy: string[];
}

export function acceptedSongs(state: IntakeState): LibrarySongRef[] {
  const result: LibrarySongRef[] = [];
  for (const [key, entry] of Object.entries(state.songs)) {
    const accepted = entry.submissionIds
      .map((id) => find(state, id)!)
      .filter((s) => statusOf(s) === 'accepted');
    if (accepted.length === 0) continue;
    result.push({ key, meta: accepted[0]!.meta!, submissionIds: accepted.map((s) => s.id), knownBy: entry.knownBy });
  }
  return result;
}

// Связывает заявку с музыкальной идентичностью. Чужая песня склеивается молча: заявка принята,
// оба автора записаны знающими. Своя повторная — отклоняется, утечки здесь нет.
function claimSong(state: IntakeState, submissionId: string): IntakeState {
  const submission = find(state, submissionId)!;
  if (!submission.meta) return state;
  const key = songKey(submission.meta.artist, submission.meta.title);
  const entry = state.songs[key] ?? { submissionIds: [], knownBy: [] };
  const knownBy = entry.knownBy.includes(submission.owner) ? entry.knownBy : [...entry.knownBy, submission.owner];

  const ownTwice = entry.submissionIds.some((id) => id !== submissionId && find(state, id)?.owner === submission.owner);
  if (ownTwice) return update(state, submissionId, { rejection: 'duplicate_own' });

  const submissionIds = entry.submissionIds.includes(submissionId)
    ? entry.submissionIds
    : [...entry.submissionIds, submissionId];
  return { ...state, songs: { ...state.songs, [key]: { submissionIds, knownBy } } };
}

function releaseSong(state: IntakeState, submission: Submission): IntakeState {
  if (!submission.meta) return state;
  const key = songKey(submission.meta.artist, submission.meta.title);
  const entry = state.songs[key];
  if (!entry || !entry.submissionIds.includes(submission.id)) return state;
  const submissionIds = entry.submissionIds.filter((id) => id !== submission.id);
  return { ...state, songs: { ...state.songs, [key]: { ...entry, submissionIds } } };
}

function reject(submission: Submission, reason: RejectReason): Submission {
  return { ...submission, rejection: reason };
}

function find(state: IntakeState, id: string): Submission | undefined {
  return state.submissions.find((s) => s.id === id);
}

function update(state: IntakeState, id: string, patch: Partial<Submission>): IntakeState {
  return { ...state, submissions: state.submissions.map((s) => (s.id === id ? { ...s, ...patch } : s)) };
}
