import { handleIntake, openIntakeSession, pendingSubmissions, type IntakeSession } from '../bot/intakeSession.ts';
import { handleIncoming, openMatchSession, type MatchSession, type MatchSessionConfig } from '../bot/matchSession.ts';
import { DEFAULT_INTAKE_RULES } from '../domain/submission/intake.ts';
import { DEMO_USERS, demoConfig } from './demoConfig.ts';
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
    organizer: DEMO_USERS.org,
    rules: DEFAULT_INTAKE_RULES,
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
