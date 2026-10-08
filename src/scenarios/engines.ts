import { handleDraw, openDrawSession, type DrawSession, type DrawSessionConfig } from '../bot/drawSession.ts';
import { handleFinal, openFinalSession, type FinalSession, type FinalSessionConfig } from '../bot/finalSession.ts';
import { handleIntake, openIntakeSession, pendingSubmissions, type IntakeSession } from '../bot/intakeSession.ts';
import {
  handleIncoming,
  openMatchSession,
  type LibrarySong,
  type MatchSession,
  type MatchSessionConfig,
} from '../bot/matchSession.ts';
import { buildQualifierBracket } from '../domain/bracket/bracket.ts';
import { FINAL_RULESET } from '../domain/match/ruleset.ts';
import { DEFAULT_INTAKE_RULES } from '../domain/submission/intake.ts';
import { DEFAULT_FINAL_TARGET, finalPoolSize } from '../domain/submission/pools.ts';
import { songKey } from '../domain/submission/titles.ts';
import { seededRandom, shuffled } from '../shared/random.ts';
import { DEMO_LIBRARY, DEMO_USERS, demoConfig } from './demoConfig.ts';
import { backgroundSubmissions, ROSTER, USERNAMES } from './demoRoster.ts';
import type { Engine } from './engine.ts';
import { DEMO_CATALOG } from './intakeDemo.ts';

export function matchEngine(config: MatchSessionConfig = demoConfig()): Engine<MatchSession> {
  return {
    id: 'match',
    title: 'Матч',
    columns: [
      { role: 'judge', user: config.judge, caption: 'Судья' },
      { role: 'p0', user: config.players[0], caption: 'Игрок' },
      { role: 'p1', user: config.players[1], caption: 'Игрок' },
    ],
    composer: false,
    catalog: {},
    open: () => openMatchSession(config),
    handle: handleIncoming,
    workerEvent: () => null,
  };
}

export function intakeEngine(): Engine<IntakeSession> {
  const config = {
    participants: [DEMO_USERS.p0, DEMO_USERS.p1],
    background: backgroundSubmissions(),
    organizer: DEMO_USERS.org,
    rules: DEFAULT_INTAKE_RULES,
    finalPoolTarget: finalPoolSize(DEFAULT_FINAL_TARGET),
    finalists: 8,
    seed: 2026,
  };
  const corrupt = new Set(Object.values(DEMO_CATALOG).filter((e) => e.corrupt).map((e) => e.file.fileUniqueId));
  return {
    id: 'intake',
    title: 'Сбор треков',
    columns: [
      { role: 'p0', user: DEMO_USERS.p0, caption: 'Участник' },
      { role: 'p1', user: DEMO_USERS.p1, caption: 'Участник' },
      { role: 'org', user: DEMO_USERS.org, caption: 'Организатор' },
    ],
    composer: true,
    catalog: DEMO_CATALOG,
    open: () => openIntakeSession(config),
    handle: handleIntake,
    // Фейковый worker: битые файлы из каталога не проходят, остальные обрабатываются успешно.
    workerEvent: (session) => {
      const pending = pendingSubmissions(session);
      if (pending.length === 0) return null;
      return {
        kind: 'worker',
        results: pending.map((s) => ({ submissionId: s.id, ok: !corrupt.has(s.file.fileUniqueId) })),
      };
    },
  };
}

const GUEST_JUDGE = { id: 'u-marina', name: 'Марина' };

export const DRAW_PLAYERS = ROSTER.filter((p) => p.name !== 'Оля');

// Seed подобран так, чтобы Аня и Борис встретились в первом круге, а Вика проходила без игры
// и могла судить: так весь путь виден в трёх колонках симулятора.
export function demoDrawSeed(): number {
  const ids = DRAW_PLAYERS.map((p) => p.id);
  for (let seed = 1; seed < 10_000; seed++) {
    const first = buildQualifierBracket(ids, 8, seed).rounds[0]!;
    const together = first.some(
      (m) => !m.isBye && m.slots.every((s) => s.kind === 'player' && (s.id === DEMO_USERS.p0.id || s.id === DEMO_USERS.p1.id)),
    );
    const vikaFree = first.some((m) => m.isBye && m.slots[0].kind === 'player' && m.slots[0].id === DEMO_USERS.judge.id);
    if (together && vikaFree) return seed;
  }
  throw new Error('Не нашёлся seed для демо-жеребьёвки');
}

export function drawEngine(): Engine<DrawSession> {
  const config: DrawSessionConfig = {
    players: DRAW_PLAYERS,
    interactive: [DEMO_USERS.p0.id, DEMO_USERS.p1.id, DEMO_USERS.judge.id],
    registered: [...ROSTER, GUEST_JUDGE],
    usernames: USERNAMES,
    organizer: DEMO_USERS.org,
    finalists: 8,
    seed: demoDrawSeed(),
    deadlines: ['2026-10-15', '2026-10-22'],
    botUsername: 'music_tournament_bot',
  };
  return {
    id: 'draw',
    title: 'Жеребьёвка и пары',
    columns: [
      { role: 'p0', user: DEMO_USERS.p0, caption: 'Игрок' },
      { role: 'p1', user: DEMO_USERS.p1, caption: 'Игрок' },
      { role: 'judge', user: DEMO_USERS.judge, caption: 'Свободна в 1-м круге' },
      { role: 'org', user: DEMO_USERS.org, caption: 'Организатор' },
    ],
    composer: false,
    catalog: {},
    open: () => openDrawSession(config),
    handle: handleDraw,
    workerEvent: () => null,
  };
}

const FINALIST_NAMES = ['Аня', 'Дима', 'Маша', 'Никита', 'Борис', 'Катя', 'Вика', 'Таня'];

// Финальный пул демо: песни каталога и фоновых участников, 120 штук с зафиксированным seed.
// Среди них есть песни финалистов — видно, как бот пропускает их в матчах этих игроков.
export function demoFinalLibrary(): LibrarySong[] {
  const fromBackground: LibrarySong[] = backgroundSubmissions().flatMap(({ participant, files }) =>
    files.map((file, i) => ({
      id: `fin-${participant.id}-${i}`,
      artist: file.performer!,
      title: file.title!,
      ownerIds: [participant.id],
    })),
  );
  const seen = new Set<string>();
  const unique = [...DEMO_LIBRARY, ...fromBackground].filter((song) => {
    const key = songKey(song.artist, song.title);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return shuffled(unique, seededRandom(120)).slice(0, finalPoolSize(DEFAULT_FINAL_TARGET));
}

export function finalEngine(): Engine<FinalSession> {
  const finalists = FINALIST_NAMES.map((name) => ROSTER.find((p) => p.name === name)!);
  const config: FinalSessionConfig = {
    finalists,
    judge: GUEST_JUDGE,
    organizer: DEMO_USERS.org,
    interactive: [DEMO_USERS.p0.id, DEMO_USERS.p1.id],
    library: demoFinalLibrary(),
    ruleset: FINAL_RULESET,
    seed: 2027,
  };
  return {
    id: 'final',
    title: 'Финал',
    columns: [
      { role: 'judge', user: GUEST_JUDGE, caption: 'Судья финала' },
      { role: 'p0', user: DEMO_USERS.p0, caption: 'Игрок финала' },
      { role: 'p1', user: DEMO_USERS.p1, caption: 'Игрок финала' },
      { role: 'org', user: DEMO_USERS.org, caption: 'Организатор' },
    ],
    composer: false,
    catalog: {},
    open: () => openFinalSession(config),
    handle: handleFinal,
    workerEvent: () => null,
  };
}

// Все люди демо — для подписей в инспекторах.
export const ALL_PEOPLE = [...ROSTER, GUEST_JUDGE, DEMO_USERS.org];
