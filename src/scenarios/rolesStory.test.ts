import { describe, expect, it } from 'vitest';
import type { BotChatMessage } from '../bot/chat.ts';
import { violations } from '../tournament/testBot.ts';
import { MOMENTS, playToMoment, pressInRun, type RolesRun } from './rolesStory.ts';

const PHASE = { intake: 'intake', qualifiers: 'qualifiers', final: 'final', archive: 'archive' } as const;

function botMessages(run: RolesRun, userId: string): BotChatMessage[] {
  return (run.bot.chats[userId]?.messages ?? []).flatMap((m) => (m.author === 'bot' ? [m] : []));
}

describe.each(MOMENTS)('Роли · $title', (moment) => {
  const run = playToMoment(moment.id);

  it('сценарий доходит до момента на настоящем боте', () => {
    expect(run.bot.state.phase).toBe(PHASE[moment.id]);
    expect(run.moment).toBe(moment);
  });

  it('у каждой роли в колонке есть сообщения бота', () => {
    for (const column of run.columns) expect(botMessages(run, column.userId).length, column.role).toBeGreaterThan(0);
  });

  it('сообщения укладываются в лимиты Telegram', () => {
    expect(violations(run.bot.outLog)).toEqual([]);
  });
});

describe('Роли · отбор', () => {
  const run = playToMoment('qualifiers');
  const column = (role: string) => run.columns.find((c) => c.role === role)!;

  it('ответы видит только судья', () => {
    expect(botMessages(run, column('Судья').userId).some((m) => m.text.startsWith('🔒 Ответы'))).toBe(true);
    for (const role of ['Игрок', 'Ждёт пару', 'Организатор']) {
      expect(botMessages(run, column(role).userId).some((m) => m.text.startsWith('🔒 Ответы')), role).toBe(false);
    }
  });

  it('кнопки живые: нажатие судьи меняет счёт у игрока', () => {
    const judge = column('Судья').userId;
    const player = column('Игрок').userId;
    const close = run.bot.buttons(judge).find((d) => /^m:[^:]+:close/.test(d))!;
    const before = botMessages(run, player).map((m) => m.text).join('\n');
    const after = pressInRun(run, judge, close);
    expect(after.pressed).toEqual({ from: judge, data: close });
    expect(botMessages(after, player).map((m) => m.text).join('\n')).not.toBe(before);
  });
});
