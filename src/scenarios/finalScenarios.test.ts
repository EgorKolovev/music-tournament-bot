import { describe, expect, it } from 'vitest';
import type { FinalSession } from '../bot/finalSession.ts';
import { limitViolations } from '../bot/protocol.ts';
import { scoreOf } from '../domain/match/match.ts';
import { DEMO_USERS } from './demoConfig.ts';
import { finalEngine } from './engines.ts';
import { FINAL_SCENARIOS } from './finalScenarios.ts';
import { runScenario, type Frame } from './runner.ts';

const engine = finalEngine();

function run(id: string): Frame<FinalSession>[] {
  return runScenario(engine, FINAL_SCENARIOS.find((s) => s.id === id)!);
}

describe.each(FINAL_SCENARIOS)('сценарий «$title»', (scenario) => {
  const frames = runScenario(engine, scenario);
  const allOut = frames.flatMap((f) => f.out);

  it('ни одно нажатие не отклонено', () => {
    expect(allOut.filter((o) => o.kind === 'toast')).toEqual([]);
  });

  it('сообщения укладываются в лимиты Telegram', () => {
    expect(allOut.flatMap((o) => (o.kind === 'message' ? limitViolations(o) : []))).toEqual([]);
  });

  it('игроки не получают ответов', () => {
    const library = engine.open().session.config.library;
    const toPlayers = allOut.filter((o) => o.to === DEMO_USERS.p0.id || o.to === DEMO_USERS.p1.id).map((o) => o.text);
    for (const song of library) for (const text of toPlayers) expect(text).not.toContain(song.title);
  });
});

describe('четвертьфиналы на сцене', () => {
  const frames = run('final-quarter');
  const last = frames.at(-1)!.session;

  it('оба матча зафиксированы в сетке', () => {
    expect(last.results).toEqual({ 'f1-1': DEMO_USERS.p0.id, 'f1-2': expect.any(String) });
    expect(last.current).toBeNull();
  });

  it('песни выдаются строго по очереди, без песен пары и без повторов в финале', () => {
    const { library, finalists } = last.config;
    expect(new Set(last.played).size).toBe(last.played.length);
    const pairs = [
      ['Аня', 'Дима'],
      ['Маша', 'Никита'],
    ];
    const firstMatchSongs = last.played.slice(0, 5);
    const secondMatchSongs = last.played.slice(5);
    [firstMatchSongs, secondMatchSongs].forEach((songs, i) => {
      const ids = pairs[i]!.map((name) => finalists.find((p) => p.name === name)!.id);
      for (const songId of songs) {
        const song = library.find((s) => s.id === songId)!;
        expect(song.ownerIds.some((o) => ids.includes(o))).toBe(false);
      }
    });
    // Первая песня матча — первая подходящая в очереди.
    const firstIds = pairs[0]!.map((name) => finalists.find((p) => p.name === name)!.id);
    const expected = last.queue.find((id) => !library.find((s) => s.id === id)!.ownerIds.some((o) => firstIds.includes(o)));
    expect(firstMatchSongs[0]).toBe(expected);
  });
});

describe('порог вничью', () => {
  it('9,3 : 9,3 продолжает матч, следующий трек решает', () => {
    const frames = run('final-threshold-tie');
    const tied = frames.find((f) => {
      const match = f.session.current?.session.match;
      return match && match.closedTracks.length === 14;
    })!;
    const match = tied.session.current!.session.match;
    expect(scoreOf(match.closedTracks, match.ruleset)).toEqual([93, 93]);
    expect(match.phase.kind).toBe('between_tracks');
    expect(frames.at(-1)!.session.results['f1-1']).not.toBe(DEMO_USERS.p0.id);
  });
});

describe('пропал интернет', () => {
  const frames = run('final-offline');

  it('офлайн-комплект содержит лист судьи по той же очереди', () => {
    const kit = frames[1]!.out.find((o) => o.kind === 'message' && o.document);
    expect(kit?.kind === 'message' && kit.document?.fileName).toBe('final-judge-sheet.csv');
    const rows = kit?.kind === 'message' ? kit.document!.content.split('\n') : [];
    expect(rows).toHaveLength(frames[1]!.session.queue.length + 1);
  });

  it('результат с бумаги продвигает сетку и пишется в журнал', () => {
    const last = frames.at(-1)!.session;
    expect(last.journal.some((e) => e.startsWith('Результат с бумаги'))).toBe(true);
    expect(last.current?.matchId).toBe('f1-2');
  });
});
