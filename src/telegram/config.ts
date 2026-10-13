import { randomBytes } from 'node:crypto';
import { QUALIFIER_RULESET, FINAL_RULESET } from '../domain/match/ruleset.ts';
import { DEFAULT_INTAKE_RULES } from '../domain/submission/intake.ts';
import { DEFAULT_FINAL_TARGET, finalPoolSize } from '../domain/submission/pools.ts';
import { DEFAULT_DATABASE_URL } from '../storage/database.ts';
import type { TournamentConfig } from '../tournament/tournament.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Настройки бота из переменных окружения (пример — .env.example). Параметры турнира — значения для
// первого турнира при первом запуске, дальше их меняет организатор в панели; organizer, админы
// и username бота берутся из окружения каждый раз.

export interface BotSettings {
  token: string;
  // Свой Bot API server (файлы больше 20 МБ) или тестовая подмена; по умолчанию облачный.
  apiBaseUrl?: string;
  // postgres://пользователь:пароль@хост:5432/база
  databaseUrl: string;
  audioMode: 'ffmpeg' | 'skip';
  serviceChatId?: string;
  tmpDir: string;
  ffmpegPath: string;
  ffprobePath: string;
  tournament: Omit<TournamentConfig, 'botUsername'>;
}

export class ConfigError extends Error {}

export function readSettings(env: Record<string, string | undefined>): BotSettings {
  const token = env.BOT_TOKEN?.trim();
  if (!token) throw new ConfigError('Не задан BOT_TOKEN — токен тестового бота из @BotFather.');
  const organizerId = env.ORGANIZER_ID?.trim();
  if (!organizerId || !/^\d+$/.test(organizerId)) throw new ConfigError('Не задан ORGANIZER_ID — Telegram ID организатора.');
  const databaseUrl = env.DATABASE_URL?.trim() || DEFAULT_DATABASE_URL;

  const audioMode = (env.AUDIO_MODE ?? 'ffmpeg').trim();
  if (audioMode !== 'ffmpeg' && audioMode !== 'skip') throw new ConfigError('AUDIO_MODE: ffmpeg или skip.');
  const serviceChatId = env.SERVICE_CHAT_ID?.trim() || undefined;
  if (audioMode === 'ffmpeg' && !serviceChatId) {
    throw new ConfigError('Для AUDIO_MODE=ffmpeg нужен SERVICE_CHAT_ID — чат, куда бот один раз отправляет игровые версии.');
  }

  const finalists = int(env.FINALISTS, 8);
  if (finalists < 2 || (finalists & (finalists - 1)) !== 0) throw new ConfigError('FINALISTS — степень двойки: 2, 4, 8.');
  const tracks = int(env.QUALIFIER_TRACKS, 5);
  const fragmentSec = int(env.FRAGMENT_SECONDS, 60);
  if (fragmentSec < 5 || fragmentSec > 600) throw new ConfigError('FRAGMENT_SECONDS — от 5 до 600 секунд.');

  return {
    token,
    apiBaseUrl: env.TELEGRAM_API_URL?.trim() || undefined,
    databaseUrl,
    audioMode,
    serviceChatId,
    tmpDir: join(tmpdir(), env.TMP_DIR?.trim() || 'audio'),
    ffmpegPath: env.FFMPEG_PATH?.trim() || 'ffmpeg',
    ffprobePath: env.FFPROBE_PATH?.trim() || 'ffprobe',
    tournament: {
      code: env.TOURNAMENT_CODE?.trim() || randomBytes(4).toString('hex'),
      title: env.TOURNAMENT_TITLE?.trim() || 'Музыкальный турнир',
      organizerId,
      // Права проверяются по Telegram ID, не по username.
      adminIds: (env.ADMIN_IDS ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter((id) => /^\d+$/.test(id)),
      finalists,
      seed: int(env.SEED, Math.floor(Math.random() * 1_000_000)),
      roundDays: int(env.ROUND_DAYS, 7),
      intakeRules: { ...DEFAULT_INTAKE_RULES, maxSubmissions: int(env.MAX_SUBMISSIONS, DEFAULT_INTAKE_RULES.maxSubmissions) },
      fragmentSec,
      finalPoolTarget: int(env.FINAL_POOL_TARGET, finalPoolSize(DEFAULT_FINAL_TARGET)),
      qualifierRuleset: { ...QUALIFIER_RULESET, format: { kind: 'fixed', tracks } },
      finalRuleset: FINAL_RULESET,
    },
  };
}

function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new ConfigError(`Ожидалось целое число, получено «${value}».`);
  return parsed;
}
