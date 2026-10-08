import { describe, expect, it } from 'vitest';
import type { IntakeSession } from '../bot/intakeSession.ts';
import { limitViolations } from '../bot/protocol.ts';
import { statusOf, submissionsOf } from '../domain/submission/intake.ts';
import { songKey } from '../domain/submission/titles.ts';
import { DEMO_USERS } from './demoConfig.ts';
import { intakeEngine } from './engines.ts';
import { INTAKE_SCENARIOS } from './intakeScenarios.ts';
import { runScenario, type Frame } from './runner.ts';

const engine = intakeEngine();

function run(id: string): Frame<IntakeSession>[] {
  return runScenario(engine, INTAKE_SCENARIOS.find((s) => s.id === id)!);
}

function summary(frame: Frame<IntakeSession>, owner: string) {
  return submissionsOf(frame.session.intake, owner).map((s) => [
    s.meta ? `${s.meta.artist} — ${s.meta.title}` : s.file.fileName,
    s.pool,
    statusOf(s),
  ]);
}

function listText(frame: Frame<IntakeSession>, userId: string): string {
  const message = frame.chats[userId]?.messages.find((m) => m.author === 'bot' && m.slot === 'list');
  return message?.author === 'bot' ? message.text : '';
}

describe.each(INTAKE_SCENARIOS)('сценарий «$title»', (scenario) => {
  const frames = runScenario(engine, scenario);
  const allOut = frames.flatMap((f) => f.out);

  it('ни одно нажатие не отклонено', () => {
    expect(allOut.filter((o) => o.kind === 'toast')).toEqual([]);
  });

  it('сообщения укладываются в лимиты Telegram', () => {
    expect(allOut.flatMap((o) => (o.kind === 'message' ? limitViolations(o) : []))).toEqual([]);
  });

  it('после сообщения участника список оказывается последним в его чате', () => {
    for (const frame of frames) {
      const input = frame.input;
      if (input?.kind !== 'text' && input?.kind !== 'files') continue;
      const last = frame.chats[input.from]?.messages.at(-1);
      expect(last?.author === 'bot' && last.slot).toBe('list');
    }
  });
});

describe('пачка из 10 с проблемами', () => {
  const frames = run('intake-batch');

  it('бот чистит теги, разбирает имя файла и спрашивает только про непонятные треки', () => {
    expect(summary(frames[2]!, DEMO_USERS.p0.id)).toEqual([
      ['Queen — Bohemian Rhapsody', 'main', 'accepted'],
      ['Кино — Группа крови', 'main', 'accepted'],
      ['ABBA — Dancing Queen', 'main', 'accepted'],
      ['Сплин — Выхода нет', 'main', 'accepted'],
      ['track_04.mp3', 'main', 'needs_title'],
      ['Daft Punk — Get Lucky', 'main', 'accepted'],
      ['Linkin Park — Numb', 'final', 'accepted'],
      ['audio_2023-11-02.m4a', 'final', 'needs_title'],
      ['Radiohead — Creep', null, 'rejected'],
      ['Агата Кристи — Как на войне', 'final', 'accepted'],
    ]);
    expect(listText(frames[2]!, DEMO_USERS.p0.id)).toContain('✏️ Трек 5 (track_04.mp3): не нашёл название.');
  });

  it('ответ без разделителя не принимается, бот повторяет формат', () => {
    expect(listText(frames[3]!, DEMO_USERS.p0.id)).toContain('Не разобрал «Полковнику никто не пишет»');
  });

  it('после ответов и замены все 10 приняты', () => {
    const last = frames.at(-1)!;
    expect(summary(last, DEMO_USERS.p0.id).every(([, , status]) => status === 'accepted')).toBe(true);
    expect(summary(last, DEMO_USERS.p0.id)).toHaveLength(10);
    expect(listText(last, DEMO_USERS.p0.id)).toContain('✅ Все 10 треков приняты');
  });
});

describe('дубли и битый файл', () => {
  const last = run('intake-duplicates').at(-1)!;

  it('дубль и битый файл не занимают квоту, замены приняты', () => {
    expect(summary(last, DEMO_USERS.p1.id)).toEqual([
      ['Nirvana — Smells Like Teen Spirit', 'main', 'accepted'],
      ['Земфира — Искала', 'main', 'accepted'],
      ['Rammstein — Du hast', 'main', 'accepted'],
    ]);
  });

  it('Борис записан знающим «Hey Jude», хотя его заявка не принята', () => {
    expect(last.session.intake.songs[songKey('Beatles', 'Hey Jude')]?.knownBy).toEqual([
      DEMO_USERS.p0.id,
      DEMO_USERS.p1.id,
    ]);
  });

  it('участник не узнаёт, кто прислал ту же песню', () => {
    const borisTexts = last.chats[DEMO_USERS.p1.id]!.messages.map((m) => (m.author === 'bot' ? m.text : ''));
    expect(borisTexts.join('\n')).not.toContain(DEMO_USERS.p0.name);
  });
});

describe('перенос между пулами и правка', () => {
  it('трек переехал в финал, название исправлено, лишний убран', () => {
    expect(summary(run('intake-pools').at(-1)!, DEMO_USERS.p0.id)).toEqual([
      ['Queen — Bohemian Rhapsody', 'final', 'accepted'],
      ['Кино — Группа крови', 'main', 'accepted'],
      ['ABBA — Dancing Queen', 'main', 'accepted'],
      ['Nirvana — Smells Like Teen Spirit', 'main', 'accepted'],
      ['Земфира — Искала', 'main', 'accepted'],
      ['Rammstein — Du hast', 'final', 'accepted'],
      ['Агата Кристи — Как на войне', 'final', 'accepted'],
      ['ДДТ — Что такое осень', 'final', 'accepted'],
      ['Сплин — Выхода нет', 'main', 'accepted'],
    ]);
  });
});
