import { describe, expect, it } from 'vitest';
import { limitViolations } from '../bot/protocol.ts';
import { DEMO_LIBRARY, DEMO_USERS, demoConfig } from './demoConfig.ts';
import { initialFrame, nextFrame, resolveStep, runScenario } from './runner.ts';
import { SCENARIOS } from './scenarios.ts';

describe.each(SCENARIOS)('сценарий «$title»', (scenario) => {
  const config = demoConfig();
  const frames = runScenario(config, scenario);
  const last = frames.at(-1)!;
  const allOut = frames.flatMap((f) => f.out);

  it('доходит до ожидаемого итога', () => {
    const { phase } = last.session.match;
    expect(phase.kind).toBe(scenario.expect.kind);
    if (scenario.expect.winner !== undefined) expect(phase).toMatchObject({ winner: scenario.expect.winner });
  });

  it('ни одно нажатие не отклонено', () => {
    expect(allOut.filter((o) => o.kind === 'toast')).toEqual([]);
  });

  it('игроки не получают ответов', () => {
    const playerIds: string[] = [DEMO_USERS.p0.id, DEMO_USERS.p1.id];
    const playerTexts = allOut.filter((o) => playerIds.includes(o.to)).map((o) => o.text);
    for (const song of DEMO_LIBRARY) {
      for (const text of playerTexts) {
        expect(text).not.toContain(song.title);
      }
    }
  });

  it('никому не выдаются песни игроков и повторы внутри матча', () => {
    const issued = last.session.issued.map((t) => t.songId);
    expect(new Set(issued).size).toBe(issued.length);
    const owned = DEMO_LIBRARY.filter((s) => s.ownerIds.some((o) => o === DEMO_USERS.p0.id || o === DEMO_USERS.p1.id));
    expect(issued.filter((id) => owned.some((s) => s.id === id))).toEqual([]);
  });

  it('сообщения укладываются в лимиты Telegram', () => {
    const problems = allOut.flatMap((o) => (o.kind === 'message' ? limitViolations(o) : []));
    expect(problems).toEqual([]);
  });
});

describe('защита от устаревших кнопок', () => {
  it('повторное нажатие той же кнопки не начисляет очки дважды', () => {
    const scenario = SCENARIOS[0]!;
    const frames = runScenario(demoConfig(), { ...scenario, steps: scenario.steps.slice(0, 6) });
    const frame = frames.at(-1)!;
    // Двойной клик: ровно та же callback_data приходит второй раз.
    const repeated = nextFrame(frame, frames.at(-1)!.input!);
    expect(repeated.session.match.version).toBe(frame.session.match.version);
    expect(repeated.out).toEqual([{ kind: 'toast', to: DEMO_USERS.judge.id, text: 'Панель устарела — показываю актуальную' }]);
  });

  it('игрок не может нажать судейскую кнопку', () => {
    const frame = initialFrame(demoConfig());
    const judgeInput = resolveStep(frame, { as: 'judge', press: 'ready' });
    const next = nextFrame(frame, { ...judgeInput, from: DEMO_USERS.p0.id });
    expect(next.session.match.phase).toMatchObject({ judgeReady: false });
  });
});
