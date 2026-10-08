import { describe, expect, it } from 'vitest';
import { admittedPlayers, readyForDraw, type IntakeSession } from '../bot/intakeSession.ts';
import { limitViolations } from '../bot/protocol.ts';
import { acceptedSongs, statusOf, submissionsOf } from '../domain/submission/intake.ts';
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
    statusOf(s),
    s.rejection,
  ]);
}

function botText(frame: Frame<IntakeSession>, userId: string, slot: string): string {
  const message = frame.chats[userId]?.messages.find((m) => m.author === 'bot' && m.slot === slot);
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

  it('участник никогда не узнаёт, что его песню уже прислал кто-то другой', () => {
    for (const frame of frames) {
      for (const id of [DEMO_USERS.p0.id, DEMO_USERS.p1.id]) {
        const text = botText(frame, id, 'list');
        expect(text).not.toMatch(/друг|уже есть у/i);
      }
    }
  });
});

describe('пачка из 10 с проблемами', () => {
  const frames = run('intake-batch');

  it('бот чистит теги, разбирает имя файла и спрашивает только про непонятные песни', () => {
    expect(summary(frames[2]!, DEMO_USERS.p0.id)).toEqual([
      ['Queen — Bohemian Rhapsody', 'accepted', null],
      ['Кино — Группа крови', 'accepted', null],
      ['ABBA — Dancing Queen', 'accepted', null],
      ['Сплин — Выхода нет', 'accepted', null],
      ['track_04.mp3', 'needs_title', null],
      ['Daft Punk — Get Lucky', 'accepted', null],
      ['Linkin Park — Numb', 'accepted', null],
      ['audio_2023-11-02.m4a', 'needs_title', null],
      ['Radiohead — Creep', 'rejected', 'too_large'],
      ['Агата Кристи — Как на войне', 'accepted', null],
    ]);
    expect(botText(frames[2]!, DEMO_USERS.p0.id, 'list')).toContain('✏️ Песня 5 (track_04.mp3): не нашёл название.');
  });

  it('ответ без разделителя не принимается', () => {
    expect(botText(frames[3]!, DEMO_USERS.p0.id, 'list')).toContain('Не разобрал «Полковнику никто не пишет»');
  });

  it('после ответов и замены все 10 приняты, дубли с другими участниками склеены', () => {
    const last = frames.at(-1)!;
    expect(summary(last, DEMO_USERS.p0.id).filter(([, status]) => status === 'accepted')).toHaveLength(10);
    expect(botText(last, DEMO_USERS.p0.id, 'list')).toContain('✅ Все 10 песен приняты');
    const queen = last.session.intake.songs[songKey('Queen', 'Bohemian Rhapsody')];
    expect(queen?.knownBy).toContain(DEMO_USERS.p0.id);
    expect(queen?.knownBy).toHaveLength(2);
  });
});

describe('дубли и битые файлы', () => {
  const last = run('intake-duplicates').at(-1)!;

  it('чужой дубль принят, свой повтор и плохие файлы отклонены', () => {
    expect(summary(last, DEMO_USERS.p1.id)).toEqual([
      ['Beatles — Hey Jude', 'accepted', null],
      ['Nirvana — Smells Like Teen Spirit', 'accepted', null],
      ['Nirvana — Smells Like Teen Spirit', 'rejected', 'duplicate_own'],
      ['Земфира — Искала', 'accepted', null],
      ['Rammstein — Du hast', 'accepted', null],
    ]);
  });

  it('Борис записан знающим «Hey Jude» вместе с остальными авторами', () => {
    const entry = last.session.intake.songs[songKey('Beatles', 'Hey Jude')];
    expect(entry?.knownBy).toContain(DEMO_USERS.p1.id);
    expect(entry?.submissionIds.length).toBeGreaterThan(1);
  });
});

describe('закрытие сбора и пулы', () => {
  const frames = run('intake-close');
  const last = frames.at(-1)!;

  it('пулы разделены без пересечений и покрывают всю библиотеку', () => {
    const split = last.session.closed!.split;
    expect(new Set([...split.final, ...split.main]).size).toBe(acceptedSongs(last.session.intake).length);
    expect(split.final.length).toBeGreaterThanOrEqual(110);
  });

  it('после закрытия новые файлы не принимаются', () => {
    expect(summary(last, DEMO_USERS.p1.id)).toHaveLength(3);
    expect(botText(frames[5]!, DEMO_USERS.p1.id, 'list')).toContain('Сбор уже закрыт');
  });

  it('жеребьёвка доступна только после решений по всем недобравшим', () => {
    expect(readyForDraw(frames[6]!.session)).toBe(false);
    expect(readyForDraw(last.session)).toBe(true);
    const admitted = admittedPlayers(last.session).map((p) => p.name);
    expect(admitted).toContain('Борис');
    expect(admitted).not.toContain('Оля');
    expect(admitted).toHaveLength(19);
    expect(botText(last, DEMO_USERS.org.id, 'intake')).toContain('Готово к жеребьёвке: 19 игроков ✅');
  });
});
