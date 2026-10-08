import { describe, expect, it } from 'vitest';
import type { DrawSession } from '../bot/drawSession.ts';
import { limitViolations } from '../bot/protocol.ts';
import { playedMatches } from '../domain/bracket/bracket.ts';
import { DEMO_USERS } from './demoConfig.ts';
import { DRAW_SCENARIOS } from './drawScenarios.ts';
import { drawEngine } from './engines.ts';
import { runScenario, type Frame } from './runner.ts';

const engine = drawEngine();

function run(id: string): Frame<DrawSession>[] {
  return runScenario(engine, DRAW_SCENARIOS.find((s) => s.id === id)!);
}

function card(frame: Frame<DrawSession>, userId: string): string {
  const message = frame.chats[userId]?.messages.find((m) => m.author === 'bot' && m.slot === 'card');
  return message?.author === 'bot' ? message.text : '';
}

describe.each(DRAW_SCENARIOS)('сценарий «$title»', (scenario) => {
  const frames = runScenario(engine, scenario);
  const allOut = frames.flatMap((f) => f.out);

  it('ни одно нажатие не отклонено', () => {
    expect(allOut.filter((o) => o.kind === 'toast')).toEqual([]);
  });

  it('сообщения укладываются в лимиты Telegram', () => {
    expect(allOut.flatMap((o) => (o.kind === 'message' ? limitViolations(o) : []))).toEqual([]);
  });
});

describe('жеребьёвка, судья, перенос срока', () => {
  const frames = run('draw-pairs');
  const last = frames.at(-1)!;

  it('сетка: 19 игроков, 11 матчей отбора', () => {
    expect(playedMatches(last.session.bracket!)).toHaveLength(11);
  });

  it('карточка сразу показывает соперника с контактом и срок', () => {
    const text = card(frames[1]!, DEMO_USERS.p0.id);
    expect(text).toContain('Соперник: Борис (@boris_music)');
    expect(text).toContain('до 15 октября');
  });

  it('судья назначен после согласия судьи и подтверждения второго игрока', () => {
    expect(card(frames[4]!, DEMO_USERS.p1.id)).toContain('Аня предлагает судью: Вика');
    expect(card(frames[5]!, DEMO_USERS.p0.id)).toContain('✅ Всё готово: судья Вика');
  });

  it('перенос срока уведомляет только участников затронутых матчей и их судей', () => {
    const notified = last.out.filter((o) => o.kind === 'message' && !o.slot).map((o) => o.to);
    expect(notified.sort()).toEqual([DEMO_USERS.p0.id, DEMO_USERS.p1.id, DEMO_USERS.judge.id].sort());
    expect(card(last, DEMO_USERS.p0.id)).toContain('до 17 октября');
    const org = last.chats[DEMO_USERS.org.id]!.messages[0]!;
    expect(org.author === 'bot' && org.text).toContain('срок 1-го круга 15 октября → 17 октября');
  });
});

describe('судья отказался', () => {
  it('после отказа можно выбрать другого, и его подтверждает второй игрок', () => {
    const last = run('draw-decline').at(-1)!;
    expect(card(last, DEMO_USERS.p0.id)).toContain('✅ Всё готово: судья Марина');
    expect(last.session.journal.some((entry) => /^Отказ судить №1\.\d+: Вика$/.test(entry))).toBe(true);
  });
});
