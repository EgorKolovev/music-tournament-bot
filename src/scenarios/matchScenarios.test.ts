import { describe, expect, it } from 'vitest';
import { minSongsForMatch, openMatchSession } from '../bot/matchSession.ts';
import { limitViolations, type Outgoing, type OutgoingMessage } from '../bot/protocol.ts';
import { FINAL_RULESET, QUALIFIER_RULESET, type Ruleset } from '../domain/match/ruleset.ts';
import { DEMO_LIBRARY, DEMO_USERS, demoConfig } from './demoConfig.ts';
import { matchEngine } from './engines.ts';
import { everyoneReady, MATCH_SCENARIOS, repeat, track } from './matchScenarios.ts';
import { initialFrame, nextFrame, resolveStep, runScenario } from './runner.ts';

const engine = matchEngine();

// Регламент турниров прошлых версий: формат без поля отрыва.
const LEGACY: Ruleset = { ...QUALIFIER_RULESET, format: { kind: 'fixed', tracks: 5 } };

// Все сообщения судьи за матч, включая правки панелей.
const judgeTexts = (frames: { out: Outgoing[] }[]) =>
  frames
    .flatMap((f) => f.out)
    .filter((o) => o.kind === 'message' && o.to === DEMO_USERS.judge.id)
    .map((o) => o.text);

describe.each(MATCH_SCENARIOS)('сценарий «$title»', (scenario) => {
  const frames = runScenario(engine, scenario);
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
    expect(playerTexts.length).toBeGreaterThan(0);
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
    const scenario = MATCH_SCENARIOS[0]!;
    const frames = runScenario(engine, { ...scenario, steps: scenario.steps.slice(0, 6) });
    const frame = frames.at(-1)!;
    // Двойной клик: ровно та же callback_data приходит второй раз.
    const repeated = nextFrame(engine, frame, frame.input!);
    expect(repeated.session.match.version).toBe(frame.session.match.version);
    expect(repeated.out).toEqual([{ kind: 'toast', to: DEMO_USERS.judge.id, text: 'Эта панель устарела — вот свежая' }]);
  });

  it('игрок не может нажать судейскую кнопку', () => {
    const frame = initialFrame(engine);
    const judgeInput = resolveStep(engine, frame, { as: 'judge', press: 'ready' });
    const next = nextFrame(engine, frame, { ...judgeInput, from: DEMO_USERS.p0.id } as typeof judgeInput);
    expect(next.session.match.phase).toMatchObject({ judgeReady: false });
  });
});

describe('отрыв после основной части — панель судьи', () => {
  const tie = MATCH_SCENARIOS.find((s) => s.id === 'qualifier-tie')!;

  it('в лобби — правило отрыва, между треками — «Отрыв меньше 2,0», а не «Ничья»', () => {
    const texts = judgeTexts(runScenario(engine, tie));
    expect(texts).toContainEqual(
      expect.stringContaining('5 треков, побеждает тот, кто наберёт больше\nПри отрыве меньше 2,0 — ещё по треку, пока кто-то не оторвётся на 2,0'),
    );
    // После 5-го трека ничья, после 6-го счёт неравный, но отрыв мал — строка одна и та же.
    expect(texts).toContainEqual(expect.stringContaining('Аня 2,5 : 2,5 Борис\nОтрыв меньше 2,0 — дополнительный трек 1'));
    expect(texts).toContainEqual(expect.stringContaining('Аня 2,5 : 4,0 Борис\nОтрыв меньше 2,0 — дополнительный трек 2'));
    expect(texts.join('\n')).not.toMatch(/ничь/i);
  });

  it('без отрыва (турниры прошлых версий) — прежние строки про ничью', () => {
    const steps = [...everyoneReady, ...track('aw:a:0', 'aw:t:1'), ...track('aw:a:1', 'aw:t:0'), ...repeat(3, track())];
    const texts = judgeTexts(runScenario(matchEngine(demoConfig({ ruleset: LEGACY })), { ...tie, steps }));
    expect(texts).toContainEqual(
      expect.stringContaining('5 треков, побеждает тот, кто наберёт больше\nПри ничьей — ещё по треку, пока кто-то не вырвется вперёд'),
    );
    expect(texts).toContainEqual(expect.stringContaining('Аня 2,5 : 2,5 Борис\nНичья — дополнительный трек 1'));
    expect(texts.join('\n')).not.toContain('Отрыв');
  });

  it('запас песен: к основной части +10 при отрыве, +5 без него; судья видит предупреждение', () => {
    expect(minSongsForMatch(QUALIFIER_RULESET)).toBe(15);
    expect(minSongsForMatch(LEGACY)).toBe(10);
    expect(minSongsForMatch(FINAL_RULESET)).toBe(25);
    // 6 песен игроков и 12 чужих.
    const library = DEMO_LIBRARY.slice(0, 18);
    const lobby = (ruleset: Ruleset) =>
      openMatchSession(demoConfig({ library, ruleset })).out.find(
        (o): o is OutgoingMessage => o.kind === 'message' && o.slot === 'panel:lobby',
      )!.text;
    expect(lobby(QUALIFIER_RULESET)).toContain('⚠️ Подходящих песен 12, а нужно хотя бы 15.');
    expect(lobby(LEGACY)).not.toContain('Подходящих песен');
  });
});
