import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GrammyError, InputFile } from 'grammy';
import { FakeApi, silentLog } from '../telegram/fakeApi.ts';
import { createAudioProcessor, gameArgs, type AudioProcessorDeps } from './audioProcessor.ts';

const hasFfmpeg =
  spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

// Фейк Bot API: getFile отдаёт путь, sendAudio запоминает файл и возвращает file_id игровой версии.
class AudioApi extends FakeApi {
  fileSize = 1000;

  constructor() {
    super();
    this.replies.set('getFile', (params) => ({
      file_id: params.file_id,
      file_unique_id: 'U',
      file_path: 'music/file_1.mp3',
      file_size: this.fileSize,
    }));
    this.replies.set('sendAudio', () => ({ message_id: 1, audio: { file_id: `GAME-${this.sent.length}` } }));
  }

  get sent() {
    return this.calls.filter((c) => c.method === 'sendAudio');
  }
}

let dir: string;
let tagged: Uint8Array;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'worker-test-'));
  if (!hasFfmpeg) return;
  const path = join(dir, 'source.mp3');
  // 3 секунды тишины в начале, затем тон; теги раскрывают песню.
  const result = spawnSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=90',
    '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1',
    '-metadata', 'artist=Queen', '-metadata', 'title=Secret',
    '-c:a', 'libmp3lame', '-b:a', '128k', path,
  ]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
  tagged = await readFile(path);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup(bytes: () => Uint8Array, overrides: Partial<AudioProcessorDeps> = {}) {
  const api = new AudioApi();
  const work = join(dir, `work-${Math.random().toString(36).slice(2)}`);
  const process = createAudioProcessor({
    api,
    downloadFile: async () => bytes(),
    serviceChatId: '-100500',
    tmpDir: dir,
    log: silentLog,
    ...overrides,
  });
  return { api, process, work };
}

function probe(path: string) {
  const out = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path]);
  return JSON.parse(out.stdout.toString()) as {
    format: { duration: string; tags?: Record<string, string> };
    streams: { codec_type: string; sample_rate: string; channels: number; tags?: Record<string, string> }[];
  };
}

// Средняя громкость первых seconds секунд, дБ; цифровая тишина — около −91.
function meanVolume(path: string, seconds: number): number {
  const out = spawnSync('ffmpeg', ['-v', 'info', '-t', String(seconds), '-i', path, '-af', 'volumedetect', '-f', 'null', '-']);
  return Number(/mean_volume: (-?[\d.]+) dB/.exec(out.stderr.toString())![1]);
}

describe('createAudioProcessor', () => {
  it.skipIf(!hasFfmpeg)('собирает обезличенный фрагмент до 60 секунд и отправляет в служебный чат', async () => {
    const { api, process } = setup(() => tagged);
    const before = await readdir(dir);
    const result = await process({ submissionId: 's1', fileId: 'F1', startSec: 0 });

    expect(result).toMatchObject({ submissionId: 's1', ok: true, gameFileId: 'GAME-1' });
    expect(result.durationSec).toBeGreaterThan(90);
    const { params } = api.sent[0]!;
    expect(params).toMatchObject({ chat_id: '-100500', title: 'Трек', performer: 'Музыкальный турнир' });
    const file = params.audio as InputFile;
    expect(file.filename).toBe('track.mp3');

    const out = join(dir, 'check.mp3');
    await writeFile(out, (await file.toRaw()) as Uint8Array);
    const info = probe(out);
    expect(Number(info.format.duration)).toBeGreaterThan(55);
    expect(Number(info.format.duration)).toBeLessThanOrEqual(61);
    expect(info.format.tags ?? {}).toEqual({});
    expect(info.streams.every((s) => Object.keys(s.tags ?? {}).length === 0)).toBe(true);
    expect(info.streams).toHaveLength(1);
    expect(info.streams[0]).toMatchObject({ codec_type: 'audio', sample_rate: '44100', channels: 2 });
    const raw = await readFile(out);
    expect(raw.includes('Queen')).toBe(false);
    expect(raw.includes('Secret')).toBe(false);
    await rm(out);

    // Временный каталог удалён.
    expect(await readdir(dir)).toEqual(before);
  }, 60_000);

  it.skipIf(!hasFfmpeg)('режет с начала, выбранного автором; слишком позднее — так, чтобы фрагмент уместился', async () => {
    const { api, process } = setup(() => tagged);
    // Исходник: 3 с тишины, затем тон. С 1-й секунды без перемотки фрагмент начался бы с тишины.
    expect(await process({ submissionId: 's6', fileId: 'F6', startSec: 33 })).toMatchObject({ ok: true, startSec: 33 });
    // Исходник 93 с: с 90-й секунды остались бы 3 с — режем с 33-й.
    expect(await process({ submissionId: 's7', fileId: 'F7', startSec: 90 })).toMatchObject({ ok: true, startSec: 90 });

    for (const [i, sent] of api.sent.entries()) {
      const out = join(dir, `start-${i}.mp3`);
      await writeFile(out, (await (sent.params.audio as InputFile).toRaw()) as Uint8Array);
      expect(Number(probe(out).format.duration)).toBeGreaterThan(55);
      expect(meanVolume(out, 1)).toBeGreaterThan(-40);
      await rm(out);
    }
  }, 60_000);

  it('gameArgs: с началом — перемотка без среза тишины, без начала — срез тишины', () => {
    const fromStart = gameArgs('in', 'out', 60);
    expect(fromStart).not.toContain('-ss');
    expect(fromStart.join(' ')).toContain('silenceremove');
    const fromMiddle = gameArgs('in', 'out', 60, 75);
    expect(fromMiddle.slice(fromMiddle.indexOf('-ss'), fromMiddle.indexOf('-ss') + 2)).toEqual(['-ss', '75']);
    expect(fromMiddle.indexOf('-ss')).toBeLessThan(fromMiddle.indexOf('-i'));
    expect(fromMiddle.join(' ')).not.toContain('silenceremove');
  });

  it.skipIf(!hasFfmpeg)('битый файл — ok:false corrupt, без отправки', async () => {
    const { api, process } = setup(() => randomBytes(50_000));
    const result = await process({ submissionId: 's2', fileId: 'F2', startSec: 0 });
    expect(result).toEqual({ submissionId: 's2', ok: false, startSec: 0, reason: 'corrupt', durationSec: undefined });
    expect(api.sent).toHaveLength(0);
  }, 30_000);

  it('слишком большой файл не скачивается', async () => {
    let downloaded = false;
    const { api, process } = setup(() => {
      downloaded = true;
      return new Uint8Array();
    });
    api.fileSize = 25 * 1024 * 1024;
    expect(await process({ submissionId: 's3', fileId: 'F3', startSec: 0 })).toMatchObject({ ok: false, reason: 'too_large' });
    api.failNext('getFile', 400, 'Bad Request: file is too big');
    expect(await process({ submissionId: 's4', fileId: 'F4', startSec: 0 })).toMatchObject({ ok: false, reason: 'too_large' });
    expect(downloaded).toBe(false);
  });

  it('временная ошибка Telegram пробрасывается для повтора', async () => {
    const { api, process } = setup(() => new Uint8Array());
    api.failNext('getFile', 502, 'Bad Gateway');
    await expect(process({ submissionId: 's5', fileId: 'F5', startSec: 0 })).rejects.toBeInstanceOf(GrammyError);
  });
});
