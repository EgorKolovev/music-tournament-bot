import { describe, expect, it } from 'vitest';
import { matchPlayers } from '../bot/drawSession.ts';
import type { Outgoing, UserId } from '../bot/protocol.ts';
import { openMatches } from '../domain/bracket/bracket.ts';
import { ORGANIZER, sender, TestBot, testConfig, violations } from './testBot.ts';

const ADMIN = '950';

const panelOf = (bot: TestBot, id: UserId) => {
  const message = bot.chats[id]?.messages.find((m) => m.author === 'bot' && m.slot === 'o:phase');
  return message?.author === 'bot' ? message : undefined;
};

const sentTo = (out: Outgoing[]) =>
  out.flatMap((o) => (o.kind === 'message' && o.text.startsWith('📣') ? [o.to] : [])).sort();

// Сбор: 1 прислал всё, 2 — три песни, 3 — ничего, 4 только присылает песни.
function intakeBot(): TestBot {
  const bot = new TestBot(testConfig({ adminIds: [ADMIN] }));
  for (const id of ['1', '2', '3']) bot.register(id);
  bot.command('4', '/start t_test');
  bot.press('4', 'r:name');
  bot.press('4', 'r:songs');
  bot.submitSongs('1', 10);
  bot.submitSongs('2', 3);
  bot.submitSongs('4', 2);
  bot.processAudio();
  return bot;
}

describe('✉️ Рассылка', () => {
  it('на сборе: группа, текст, предпросмотр — и сообщение только этой группе', () => {
    const bot = intakeBot();
    bot.open(ADMIN, 'broadcast');
    expect(panelOf(bot, ADMIN)!.text).toContain('Сообщение придёт от бота с пометкой 📣. Кому написать?');
    expect(panelOf(bot, ADMIN)!.buttons?.flat().map((b) => b.label)).toEqual([
      '👥 Всем участникам · 4',
      '🎤 Играющим · 3',
      '🎵 Прислали не все песни · 2',
      '⬅️ К турниру',
    ]);

    bot.press(ADMIN, 'o:bc:short');
    expect(panelOf(bot, ADMIN)!.text).toContain('✉️ Рассылка · Прислали не все песни — 2\nИгрок 2, Игрок 3');
    const typed = bot.text(ADMIN, '  Дошлите песни до вечера  ');
    expect(typed).toContainEqual(expect.objectContaining({ to: ADMIN, slot: 'o:phase', bump: true }));
    expect(panelOf(bot, ADMIN)!.text).toContain('Так получат:\n📣 Дошлите песни до вечера');
    expect(sentTo(typed)).toEqual([]);

    const sent = bot.press(ADMIN, 'o:bcSend:short');
    expect(sentTo(sent)).toEqual(['2', '3']);
    expect(bot.lastText('2')).toBe('📣 Дошлите песни до вечера');
    expect(bot.toasts.at(-1)).toEqual({ to: ADMIN, text: '✉️ Отправлено: 2' });
    expect(bot.state.journal.at(-1)).toBe('✉️ Рассылка «Прислали не все песни»: 2');
    expect(panelOf(bot, ADMIN)!.text).toContain('Последняя: «Прислали не все песни»: 2');
    expect(bot.state.broadcastDrafts).toEqual({});

    // Повторное нажатие старой кнопки второй раз не отправит.
    const again = bot.send({ kind: 'button', from: sender(ADMIN), data: 'o:bcSend:short' });
    expect(sentTo(again)).toEqual([]);
    expect(bot.toasts.at(-1)?.text).toBe('Кнопка устарела');
    expect(violations(bot.outLog)).toEqual([]);
  });

  it('слишком длинный текст — просьба прислать короче; отмена — назад к группам; участнику раздел недоступен', () => {
    const bot = intakeBot();
    bot.open(ORGANIZER, 'broadcast');
    bot.press(ORGANIZER, 'o:bc:all');
    bot.text(ORGANIZER, 'а'.repeat(3501));
    expect(bot.lastText(ORGANIZER)).toContain('Длинновато: 3501 символов, можно до 3500');
    expect(bot.state.broadcastDrafts?.[ORGANIZER]).toBeUndefined();
    bot.text(ORGANIZER, 'Всем привет');
    bot.press(ORGANIZER, 'o:v:broadcast');
    expect(panelOf(bot, ORGANIZER)!.text).toContain('Кому написать?');

    bot.send({ kind: 'button', from: sender('1'), data: 'o:v:broadcast' });
    expect(bot.toasts.at(-1)).toEqual({ to: '1', text: 'Эта кнопка — для организатора и админов' });
  });

  it('на отборе: «Парам без судьи» — только пары, которым судью ещё не нашли', () => {
    const bot = new TestBot(testConfig({ adminIds: [ADMIN] }));
    for (const id of ['1', '2', '3', '4', '5']) {
      bot.register(id);
      bot.submitSongs(id, 10);
    }
    bot.processAudio();
    bot.open(ORGANIZER, 'intake');
    bot.press(ORGANIZER, 'o:closeIntake');
    bot.open(ORGANIZER, 'home');
    bot.press(ORGANIZER, 'o:toDraw');
    bot.open(ORGANIZER, 'bracket');
    bot.press(ORGANIZER, 'o:draw');

    const draw = bot.state.draw!;
    const open = openMatches(draw.bracket!, draw.results).filter((m) => matchPlayers(draw, m.id));
    const [a, b] = matchPlayers(draw, open[0]!.id)!;
    bot.press(a, 'd:pickJudge');
    const judge = bot.buttons(a).find((d) => d.startsWith('d:judge:'))!.slice('d:judge:'.length);
    bot.press(a, `d:judge:${judge}`);

    bot.open(ADMIN, 'broadcast');
    const labels = panelOf(bot, ADMIN)!.buttons?.flat().map((b) => b.label);
    expect(labels).toEqual(['👥 Всем участникам · 5', '🎤 Играющим · 5', `⚖️ Парам без судьи · ${(open.length - 1) * 2}`, '🎯 Ещё в турнире · 5', '⬅️ К турниру']);
    bot.press(ADMIN, 'o:bc:noJudge');
    bot.text(ADMIN, 'Найдите судью до вечера');
    const sent = bot.press(ADMIN, 'o:bcSend:noJudge');
    expect(sentTo(sent)).not.toContain(a);
    expect(sentTo(sent)).not.toContain(b);
    expect(sentTo(sent)).toHaveLength((open.length - 1) * 2);
  });

  it('/broadcast — та же рассылка всем, с записью в журнал', () => {
    const bot = intakeBot();
    const out = bot.command(ORGANIZER, '/broadcast Завтра жеребьёвка');
    expect(sentTo(out)).toEqual(['1', '2', '3', '4']);
    expect(bot.lastText(ORGANIZER)).toBe('Отправлено: 4');
    expect(bot.state.journal.at(-1)).toBe('✉️ Рассылка «Всем участникам»: 4');
  });
});
