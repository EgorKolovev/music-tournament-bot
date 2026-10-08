import { describe, expect, it } from 'vitest';
import {
  completeProcessing,
  createIntake,
  DEFAULT_INTAKE_RULES,
  moveToOtherPool,
  poolCount,
  receiveFiles,
  remove,
  setTitle,
  statusOf,
  submissionsOf,
  swapPools,
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

const ANYA = 'anya';
const BORIS = 'boris';

function statuses(state: IntakeState, owner: string) {
  return submissionsOf(state, owner).map((s) => [s.pool, statusOf(s), s.rejection]);
}

describe('приём пачки', () => {
  it('первые 6 идут в отбор, следующие 4 в финал, лишние не занимают квоту', () => {
    const state = receiveFiles(createIntake(DEFAULT_INTAKE_RULES), ANYA, songs(11, 'a'));
    expect(poolCount(state, ANYA, 'main')).toBe(6);
    expect(poolCount(state, ANYA, 'final')).toBe(4);
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
      [null, 'rejected', 'too_large'],
      [null, 'rejected', 'bad_format'],
    ]);
  });

  it('файл, отмеченный worker как битый, освобождает место в квоте', () => {
    let state = receiveFiles(createIntake(DEFAULT_INTAKE_RULES), ANYA, [audio('Billie Eilish', 'Bad Guy')]);
    const [submission] = submissionsOf(state, ANYA);
    expect(statusOf(submission!)).toBe('processing');
    state = completeProcessing(state, submission!.id, false);
    expect(statuses(state, ANYA)).toEqual([[null, 'rejected', 'corrupt']]);
  });
});

describe('дубли', () => {
  it('песня другого участника — дубль, но второй автор тоже считается знающим её', () => {
    let state = receiveFiles(createIntake(DEFAULT_INTAKE_RULES), ANYA, [audio('The Beatles', 'Hey Jude')]);
    state = receiveFiles(state, BORIS, [audio('Beatles', 'Hey Jude (Remastered 2015)')]);
    expect(statuses(state, BORIS)).toEqual([[null, 'rejected', 'duplicate_other']]);
    expect(state.songs[songKey('Beatles', 'Hey Jude')]?.knownBy).toEqual([ANYA, BORIS]);
  });

  it('после удаления заявки знакомство с песней сохраняется', () => {
    let state = receiveFiles(createIntake(DEFAULT_INTAKE_RULES), ANYA, [audio('Muse', 'Uprising')]);
    state = remove(state, submissionsOf(state, ANYA)[0]!.id);
    expect(state.songs[songKey('Muse', 'Uprising')]).toEqual({ submissionId: null, knownBy: [ANYA] });
    state = receiveFiles(state, BORIS, [audio('Muse', 'Uprising')]);
    expect(statusOf(submissionsOf(state, BORIS)[0]!)).toBe('processing');
  });

  it('повторная пересылка того же файла — свой дубль', () => {
    const file = audio('ABBA', 'Dancing Queen');
    const state = receiveFiles(createIntake(DEFAULT_INTAKE_RULES), ANYA, [file, file]);
    expect(statuses(state, ANYA).map((s) => s[2])).toEqual([null, 'duplicate_own']);
  });

  it('название, введённое вручную, тоже проверяется на дубль', () => {
    let state = receiveFiles(createIntake(DEFAULT_INTAKE_RULES), ANYA, [audio('Би-2', 'Полковнику никто не пишет')]);
    state = receiveFiles(state, BORIS, [audio(undefined, undefined, { fileName: 'track_04.mp3' })]);
    state = setTitle(state, submissionsOf(state, BORIS)[0]!.id, fromText('Би 2 — Полковнику никто не пишет')!);
    expect(submissionsOf(state, BORIS)[0]?.rejection).toBe('duplicate_other');
  });
});

describe('пулы', () => {
  it('перенос в пул со свободным местом', () => {
    let state = receiveFiles(createIntake(DEFAULT_INTAKE_RULES), ANYA, songs(2, 'a'));
    const result = moveToOtherPool(state, submissionsOf(state, ANYA)[0]!.id);
    expect(result.ok).toBe(true);
    if (result.ok) state = result.state;
    expect(poolCount(state, ANYA, 'final')).toBe(1);
  });

  it('при заполненных пулах треки меняются местами', () => {
    let state = receiveFiles(createIntake(DEFAULT_INTAKE_RULES), ANYA, songs(10, 'a'));
    const [first] = submissionsOf(state, ANYA);
    const last = submissionsOf(state, ANYA).at(-1)!;
    expect(moveToOtherPool(state, first!.id)).toEqual({ ok: false, error: 'target_full' });
    const result = swapPools(state, first!.id, last.id);
    if (!result.ok) throw new Error(result.error);
    state = result.state;
    expect(submissionsOf(state, ANYA)[0]?.pool).toBe('final');
    expect(submissionsOf(state, ANYA).at(-1)?.pool).toBe('main');
  });
});
