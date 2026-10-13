import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GrammyError, InputFile, type Api } from 'grammy';
import type { Logger } from '../telegram/delivery.ts';

// Обработка присланного аудио (docs/architecture.md, раздел 7; docs/telegram-integration.md, раздел 5):
// скачать по file_id, проверить ffprobe, собрать обезличенный игровой фрагмент ffmpeg,
// один раз отправить его в служебный чат и вернуть file_id игровой версии.

export interface AudioJob {
  submissionId: string;
  fileId: string;
  sizeBytes?: number;
  // С какой секунды резать фрагмент; 0 — с начала песни после тишины.
  startSec: number;
  // Длина фрагмента турнира, чья это песня. У задач прошлых версий нет — длина по умолчанию.
  fragmentSec?: number;
}

export interface AudioResult {
  submissionId: string;
  ok: boolean;
  // Начало и длина фрагмента из задачи: по ним ядро отличает устаревший результат.
  startSec: number;
  fragmentSec?: number;
  gameFileId?: string;
  // Длительность исходного файла по ffprobe.
  durationSec?: number;
  reason?: string;
}

export interface AudioProcessorDeps {
  api: Api;
  downloadFile(filePath: string, signal?: AbortSignal): Promise<Uint8Array>;
  serviceChatId: string;
  tmpDir: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  fragmentSec?: number;
  timeoutMs?: number;
  log: Logger;
}

// Предел getFile облачного Bot API.
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

const GAME_TITLE = 'Трек';
const GAME_PERFORMER = 'Музыкальный турнир';

export function createAudioProcessor(deps: AudioProcessorDeps): (job: AudioJob) => Promise<AudioResult> {
  const ffmpeg = deps.ffmpegPath ?? 'ffmpeg';
  const ffprobe = deps.ffprobePath ?? 'ffprobe';
  const timeoutMs = deps.timeoutMs ?? 120_000;

  return async (job) => {
    const fragmentSec = job.fragmentSec ?? deps.fragmentSec ?? 60;
    const { submissionId, startSec: requested } = job;
    const fail = (reason: string, durationSec?: number): AudioResult => {
      deps.log.warn(`аудио ${submissionId}: ${reason}`);
      return { submissionId, ok: false, startSec: requested, fragmentSec: job.fragmentSec, reason, durationSec };
    };
    if (job.sizeBytes !== undefined && job.sizeBytes > MAX_DOWNLOAD_BYTES) return fail('too_large');

    let file: { file_path?: string; file_size?: number };
    try {
      file = await deps.api.raw.getFile({ file_id: job.fileId });
    } catch (error) {
      if (error instanceof GrammyError && /file is too big/i.test(error.description)) return fail('too_large');
      throw error;
    }
    if ((file.file_size ?? 0) > MAX_DOWNLOAD_BYTES) return fail('too_large');
    if (!file.file_path) throw new Error(`getFile без file_path для ${job.submissionId}`);
    let bytes: Uint8Array;
    try {
      bytes = await deps.downloadFile(file.file_path);
    } catch (error) {
      if (error instanceof TooLargeError) return fail('too_large');
      throw error;
    }
    if (bytes.byteLength > MAX_DOWNLOAD_BYTES) return fail('too_large');

    // Имена файлов непрозрачные: пользовательское имя никуда не подставляется.
    const dir = await mkdtemp(join(deps.tmpDir, 'audio-'));
    try {
      const input = join(dir, 'input');
      const output = join(dir, 'game.mp3');
      await writeFile(input, bytes);

      const probe = await probeAudio(ffprobe, input, timeoutMs);
      if (!probe) return fail('corrupt');

      // Длительность из Telegram известна не всегда: слишком позднее начало сдвигаем так,
      // чтобы фрагмент уместился целиком, — иначе останется хвост с затуханием или тишиной.
      const startSec = Math.min(job.startSec, Math.max(0, Math.floor(probe.durationSec - fragmentSec)));
      if (startSec !== job.startSec) deps.log.warn(`аудио ${job.submissionId}: начало ${job.startSec} с → ${startSec} с`);
      const encoded = await run(ffmpeg, gameArgs(input, output, fragmentSec, startSec), timeoutMs);
      if (encoded.code !== 0) {
        deps.log.warn(`ffmpeg ${job.submissionId}: ${encoded.timedOut ? 'таймаут' : encoded.stderr.trim()}`);
        return fail('corrupt', probe.durationSec);
      }

      // Проверка результата: декодируется, есть длительность, тегов не осталось.
      const check = await probeAudio(ffprobe, output, timeoutMs);
      if (!check || check.durationSec <= 0) return fail('corrupt', probe.durationSec);
      if (check.tagged) return fail('tags_left', probe.durationSec);

      const game = await readFile(output);
      const sent = await deps.api.raw.sendAudio({
        chat_id: deps.serviceChatId,
        audio: new InputFile(game, 'track.mp3'),
        title: GAME_TITLE,
        performer: GAME_PERFORMER,
      });
      if (!sent.audio?.file_id) throw new Error(`sendAudio без audio.file_id для ${job.submissionId}`);
      return {
        submissionId,
        ok: true,
        startSec: requested,
        fragmentSec: job.fragmentSec,
        gameFileId: sent.audio.file_id,
        durationSec: probe.durationSec,
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

// Первый аудиопоток без обложки, метаданных и глав; срез начальной тишины, фрагмент,
// однопроходная нормализация громкости, MP3 160 кбит/с CBR, 44,1 кГц, стерео, без ID3.
// Заголовок Xing/LAME тоже выключен: ffprobe показывает из него тег encoder, а для CBR он не нужен.
// Начало, выбранное автором, — точное место: тишина срезается только у начала песни.
export function gameArgs(input: string, output: string, fragmentSec: number, startSec = 0): string[] {
  const filters = [
    ...(startSec > 0 ? [] : ['silenceremove=start_periods=1:start_duration=0.1:start_threshold=-50dB']),
    `atrim=duration=${fragmentSec}`,
    'loudnorm=I=-16:TP=-1.5:LRA=11',
    'aresample=44100',
  ].join(',');
  return [
    '-nostdin', '-hide_banner', '-v', 'error', '-y',
    ...(startSec > 0 ? ['-ss', String(startSec)] : []),
    '-i', input,
    '-map', '0:a:0', '-vn', '-sn', '-dn',
    '-map_metadata', '-1', '-map_chapters', '-1',
    '-af', filters,
    '-t', String(fragmentSec),
    '-ac', '2', '-ar', '44100',
    '-c:a', 'libmp3lame', '-b:a', '160k',
    '-id3v2_version', '0', '-write_id3v1', '0', '-write_xing', '0',
    '-fflags', '+bitexact', '-flags:a', '+bitexact',
    '-f', 'mp3', output,
  ];
}

interface Probe {
  durationSec: number;
  tagged: boolean;
}

async function probeAudio(ffprobe: string, path: string, timeoutMs: number): Promise<Probe | undefined> {
  const result = await run(
    ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
    timeoutMs,
  );
  if (result.code !== 0) return undefined;
  let parsed: {
    format?: { duration?: string; tags?: Record<string, string> };
    streams?: { codec_type?: string; duration?: string; tags?: Record<string, string> }[];
  };
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
  const audio = parsed.streams?.find((s) => s.codec_type === 'audio');
  if (!audio) return undefined;
  const durationSec = Number(parsed.format?.duration ?? audio.duration ?? 0);
  if (!Number.isFinite(durationSec)) return undefined;
  const hasTags = (tags?: Record<string, string>) => Object.keys(tags ?? {}).length > 0;
  const tagged = hasTags(parsed.format?.tags) || (parsed.streams ?? []).some((s) => hasTags(s.tags));
  return { durationSec, tagged };
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const MAX_STDOUT = 4 * 1024 * 1024;
const MAX_STDERR = 16 * 1024;

// Запуск без shell: аргументы массивом, жёсткий таймаут, ограниченный вывод в памяти.
export function run(command: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (stdout.length < MAX_STDOUT) stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? null : code, stdout, stderr, timedOut });
    });
  });
}

// Проверка при запуске: без ffmpeg worker не запустил бы ни одной задачи, и через пять повторов
// все песни выглядели бы битыми. undefined — оба инструмента на месте, иначе — что не так.
export async function checkFfmpeg(ffmpegPath: string, ffprobePath: string): Promise<string | undefined> {
  for (const tool of [ffmpegPath, ffprobePath]) {
    try {
      const { code } = await run(tool, ['-version'], 10_000);
      if (code !== 0) return `${tool} -version завершился с кодом ${code}`;
    } catch (error) {
      return `${tool} не найден (${error instanceof Error ? error.message : String(error)})`;
    }
  }
  return undefined;
}

// Файл больше предела — окончательная ошибка файла, а не временная.
export class TooLargeError extends Error {
  constructor() {
    super('файл больше 20 МБ');
    this.name = 'TooLargeError';
  }
}

export function createTelegramDownloader(
  token: string,
  fetchImpl: typeof fetch = fetch,
): (filePath: string, signal?: AbortSignal) => Promise<Uint8Array> {
  // Токен — часть URL; URL в ошибки и логи не попадает.
  const base = `https://api.telegram.org/file/bot${token}`;
  return async (filePath, signal) => {
    const response = await fetchImpl(`${base}/${filePath}`, { signal });
    if (!response.ok) throw new Error(`скачивание файла: HTTP ${response.status}`);
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > MAX_DOWNLOAD_BYTES) throw new TooLargeError();
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw new TooLargeError();
    return bytes;
  };
}
