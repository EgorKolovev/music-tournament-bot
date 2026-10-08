import { describe, expect, it } from 'vitest';
import {
  acceptedSongs,
  activeCount,
  completeProcessing,
  createIntake,
  DEFAULT_INTAKE_RULES,
  receiveFiles,
  remove,
  setTitle,
  statusOf,
  submissionsOf,
  type AudioFile,
  type IntakeState,
} from './intake.ts';
import { fromText, songKey } from './titles.ts';

let counter = 0;

function audio(performer: string | undefined, title: string | undefined, extra: Partial<AudioFile> = {}): AudioFile {
  counter += 1;
  return {
    fileId: `f${counter}`,
    fileUniqueId: `u${counter}`,
    mimeType: 'audio/mpeg',
    sizeBytes: 5_000_000,
    performer,
    title,
    ...extra,
  };
}

function songs(count: number, prefix: string): AudioFile[] {
  return Array.from({ length: count }, (_, i) => audio(`${prefix} Artist ${i}`, `${prefix} Song ${i}`));
}

function processAll(state: IntakeState): IntakeState {
  for (const s of state.submissions) state = completeProcessing(state, s.id, true);
  return state;
}

const ANYA = 'anya';
const BORIS = 'boris';

function statuses(state: IntakeState, owner: string) {
  return submissionsOf(state, owner).map((s) => [statusOf(s), s.rejection]);
}

describe('приём пачки', () => {
  it('принимается до 10 треков, лишние не занимают квоту', () => {
    const state = receiveFiles(createIntake(DEFAULT_INTAKE_RULES), ANYA, songs(11, 'a'));
    expect(activeCount(state, ANYA)).toBe(10);
    expect(submissionsOf(state, ANYA).at(-1)?.rejection).toBe('quota_full');
  });

  it('название берётся из тегов, без тегов — из имени файла, иначе нужен ответ участника', () => {
    const state = receiveFiles(createIntake(DEFAULT_INTAKE_RULES), ANYA, [
      audio('Queen', 'Bohemian Rhapsody (Remastered 2011)'),
      audio(undefined, undefined, { fileName: '03. Сплин - Выхода нет.mp3' }),
      audio('Unknown Artist', 'audio_2023-11-02', { fileName: 'track_04.mp3' }),
    ]);
    const [queen, splin, unknown] = submissionsOf(state, ANYA);
    expect(queen?.meta).toMatchObject({ artist: 'Queen', title: 'Bohemian Rhapsody' });
    expect(splin?.meta).toMatchObject({ artist: 'Сплин', title: 'Выхода нет' });
    expect(statusOf(unknown!)).toBe('needs_title');
  });

  it('слишком большой файл и неподходящий формат отклоняются сразу', () => {
    const state = receiveFiles(createIntake(DEFAULT_INTAKE_RULES), ANYA, [
      audio('Radiohead', 'Creep', { sizeBytes: 24 * 1024 * 1024 }),
      audio('Coldplay', 'Viva la Vida', { mimeType: 'audio/ogg' }),
    ]);
    expect(statuses(state, ANYA)).toEqual([
      ['rejected', 'too_large'],
      ['rejected', 'bad_format'],
    ]);
  });

  it('файл, отмеченный worker как битый, освобождает место в квоте', () => {
    let state = receiveFiles(createIntake(DEFAULT_INTAKE_RULES), ANYA, [audio('Billie Eilish', 'Bad Guy')]);
    const [submission] = submissionsOf(state, ANYA);
    expect(statusOf(submission!)).toBe('processing');
    state = completeProcessing(state, submission!.id, false);
    expect(statuses(state, ANYA)).toEqual([['rejected', 'corrupt']]);
    expect(activeCount(state, ANYA)).toBe(0);
  });
});

describe('дубли', () => {
  it('песня другого участника принимается молча и склеивается, оба считаются знающими', () => {
    let state = receiveFiles(createIntake(DEFAULT_INTAKE_RULES), ANYA, [audio('The Beatles', 'Hey Jude')]);
    state = processAll(receiveFiles(state, BORIS, [audio('Beatles', 'Hey Jude (Remastered 2015)')]));
    expect(statuses(state, BORIS)).toEqual([['accepted', null]]);
    expect(activeCount(state, BORIS)).toBe(1);
    const library = acceptedSongs(state);
    expect(library).toHaveLength(1);
    expect(library[0]?.knownBy).toEqual([ANYA, BORIS]);
  });

  it('после удаления заявки знакомство с песней сохраняется', () => {
    let state = receiveFiles(createIntake(DEFAULT_INTAKE_RULES), ANYA, [audio('Muse', 'Uprising')]);
    state = remove(state, submissionsOf(state, ANYA)[0]!.id);
    expect(state.songs[songKey('Muse', 'Uprising')]).toEqual({ submissionIds: [], knownBy: [ANYA] });
    expect(acceptedSongs(state)).toEqual([]);
  });

  it('своя повторная песня отклоняется: и тот же файл, и та же песня в другом файле', () => {
    const file = audio('ABBA', 'Dancing Queen');
    const state = receiveFiles(createIntake(DEFAULT_INTAKE_RULES), ANYA, [
      file,
      file,
      audio('Abba', 'Dancing Queen (Remastered)'),
    ]);
    expect(statuses(state, ANYA).map((s) => s[1])).toEqual([null, 'duplicate_own', 'duplicate_own']);
  });

  it('название, введённое вручную, тоже склеивается с существующей песней', () => {
    let state = receiveFiles(createIntake(DEFAULT_INTAKE_RULES), ANYA, [audio('Би-2', 'Полковнику никто не пишет')]);
    state = receiveFiles(state, BORIS, [audio(undefined, undefined, { fileName: 'track_04.mp3' })]);
    state = processAll(setTitle(state, submissionsOf(state, BORIS)[0]!.id, fromText('Би 2 — Полковнику никто не пишет')!));
    expect(statuses(state, BORIS)).toEqual([['accepted', null]]);
    expect(acceptedSongs(state)[0]?.knownBy).toEqual([ANYA, BORIS]);
  });
});
