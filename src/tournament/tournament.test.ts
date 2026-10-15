import { describe, expect, it } from 'vitest';
import { matchPlayers, qualifiedIds } from '../bot/drawSession.ts';
import { admittedPlayers, isSongsOnly, readyForDraw } from '../bot/intakeSession.ts';
import type { UserId } from '../bot/protocol.ts';
import { openMatches, resolveSlot } from '../domain/bracket/bracket.ts';
import { QUALIFIER_RULESET } from '../domain/match/ruleset.ts';
import { acceptedSongs } from '../domain/submission/intake.ts';
import { formatClock } from '../shared/text.ts';
import { STYLE_IDS, styleOf, textsFor } from '../texts/index.ts';
import { createBot, handleBotEvent } from './bot.ts';
import { ORGANIZER, sender, TestBot, testConfig, violations } from './testBot.ts';
import type { TournamentState } from './tournament.ts';

const PLAYERS = ['1', '2', '3', '4', '5'];
const GUEST = '6';
const FINAL_JUDGE = '7';

// Регистрация, полный сбор, жеребьёвка: 5 игроков, 2 финалиста → 3 матча отбора.
function readyForQualifiers(bot = new TestBot()): TestBot {
  for (const id of PLAYERS) bot.register(id);
  for (const id of PLAYERS) bot.submitSongs(id, 10);
  bot.processAudio();
  toDraw(bot);
  return bot;
}

// Организатор закрывает сбор, переходит к жеребьёвке и проводит её — разделами панели.
function toDraw(bot: TestBot): void {
  bot.open(ORGANIZER, 'intake');
  bot.press(ORGANIZER, 'o:closeIntake');
  bot.open(ORGANIZER, 'home');
  bot.press(ORGANIZER, 'o:toDraw');
  bot.open(ORGANIZER, 'bracket');
  bot.press(ORGANIZER, 'o:draw');
  bot.open(ORGANIZER, 'home');
}

function nextMatch(bot: TestBot): string | undefined {
  const draw = bot.state.draw!;
  return openMatches(draw.bracket!, draw.results)[0]?.id;
}

// Первый игрок выбирает первого предложенного судью, судья соглашается, второй подтверждает.
function appointJudge(bot: TestBot, matchId: string, judge?: UserId): UserId {
  const [a, b] = matchPlayers(bot.state.draw!, matchId)!;
  bot.press(a, 'd:pickJudge');
  const chosen = judge ?? bot.buttons(a).find((d) => d.startsWith('d:judge:'))!.slice('d:judge:'.length);
  bot.press(a, `d:judge:${chosen}`);
  bot.press(chosen, `d:accept:${matchId}`);
  bot.press(b, `d:confirmJudge:${matchId}`);
  return chosen;
}

function playToDecision(bot: TestBot, prefix: string, judge: UserId, players: [UserId, UserId], tracks = 5): void {
  bot.press(judge, `${prefix}ready`);
  bot.press(players[0], `${prefix}ready`);
  bot.press(players[1], `${prefix}ready`);
  for (let i = 0; i < tracks; i++) {
    bot.press(judge, `${prefix}issue`);
    bot.press(judge, `${prefix}start`);
    bot.press(judge, `${prefix}aw:a:0`);
    bot.press(judge, `${prefix}aw:t:0`);
    bot.press(judge, `${prefix}close`);
  }
}

function confirmAll(bot: TestBot, prefix: string, judge: UserId, players: [UserId, UserId]): void {
  bot.press(judge, `${prefix}confirm`);
  bot.press(players[0], `${prefix}confirm`);
  bot.press(players[1], `${prefix}confirm`);
}

function playQualifier(bot: TestBot, matchId: string): void {
  const judge = appointJudge(bot, matchId);
  const players = matchPlayers(bot.state.draw!, matchId)!;
  const prefix = `m:${matchId}:`;
  playToDecision(bot, prefix, judge, players);
  confirmAll(bot, prefix, judge, players);
}

describe('Турнир целиком', () => {
  it('регистрация → сбор → жеребьёвка → отбор → финал → архив', () => {
    const bot = readyForQualifiers();
    expect(bot.state.phase).toBe('qualifiers');
    expect(Object.keys(bot.state.people)).toHaveLength(5);

    let guard = 0;
    for (let id = nextMatch(bot); id; id = nextMatch(bot)) {
      playQualifier(bot, id);
      if (++guard > 10) throw new Error('отбор не сходится');
    }
    expect(guard).toBe(3);
    expect(Object.values(bot.state.matches).every((m) => m.closed)).toBe(true);

    bot.press(ORGANIZER, 'o:toFinal');
    expect(bot.state.phase).toBe('final');
    bot.register(FINAL_JUDGE, 'fjudge_test');
    expect(bot.state.finalJudge?.id).toBe(FINAL_JUDGE);
    bot.press(ORGANIZER, 'o:openFinal');
    bot.open(ORGANIZER, 'final');
    bot.press(ORGANIZER, 'o:start:f1-1');
    // Два финалиста — один матч, и он сам финал, а не «четвертьфиналы».
    expect(bot.lastText(ORGANIZER)).toContain('🏆 Финал · 2 → 1');
    expect(bot.allText(ORGANIZER)).not.toContain('Четвертьфиналы');

    const finalists = bot.state.final!.config.finalists.map((p) => p.id) as [UserId, UserId];
    // Финал до 9,0: при 2,5 за трек хватает четырёх.
    playToDecision(bot, 'f:', FINAL_JUDGE, finalists, 4);
    confirmAll(bot, 'f:', FINAL_JUDGE, finalists);
    expect(bot.state.final!.results['f1-1']).toBe(finalists[0]);

    bot.open(ORGANIZER, 'home');
    bot.press(ORGANIZER, 'o:archive');
    expect(bot.state.phase).toBe('archive');
    expect(bot.lastText(finalists[1])).toContain('Победитель');

    // Ни одно сообщение не нарушает лимиты Bot API, в том числе 64 байта callback_data.
    expect(violations(bot.outLog)).toEqual([]);
  });

  it('судья знакомится с песнями матча: они попадают в его учёт знакомства', () => {
    const bot = readyForQualifiers();
    const matchId = nextMatch(bot)!;
    const judge = appointJudge(bot, matchId);
    const players = matchPlayers(bot.state.draw!, matchId)!;
    playToDecision(bot, `m:${matchId}:`, judge, players, 2);

    const issued = bot.state.matches[matchId]!.session.issued.map((t) => t.songId);
    expect(issued).toHaveLength(2);
    expect(bot.state.known[judge]).toEqual(expect.arrayContaining(issued));
    expect(bot.state.known[players[0]]).toEqual(expect.arrayContaining(issued));
  });

  it('аудио из worker уходит судье по file_id', () => {
    const bot = readyForQualifiers();
    const matchId = nextMatch(bot)!;
    const judge = appointJudge(bot, matchId);
    const players = matchPlayers(bot.state.draw!, matchId)!;
    playToDecision(bot, `m:${matchId}:`, judge, players, 1);
    const audio = bot.outLog.find((o) => o.kind === 'message' && o.to === judge && o.audio);
    expect(audio).toMatchObject({ audio: { fileId: expect.stringMatching(/^G-s\d+@0$/), title: 'Трек 1' } });
  });
});

describe('Начало фрагмента', () => {
  const ID = '1';

  function withSongs(): TestBot {
    const bot = new TestBot();
    bot.register(ID);
    bot.submitSongs(ID, 3);
    bot.processAudio();
    return bot;
  }

  function song(bot: TestBot, index = 0) {
    return bot.state.intake.intake.submissions.filter((s) => s.owner === ID)[index]!;
  }

  function preview(bot: TestBot) {
    return bot.chats[ID]!.messages.find((m) => m.author === 'bot' && m.slot === 'i:preview');
  }

  function list(bot: TestBot): string {
    return bot.chats[ID]!.messages.find((m) => m.author === 'bot' && m.slot === 'i:list')?.text ?? '';
  }

  it('начало видно у каждой песни сразу после загрузки', () => {
    const bot = withSongs();
    expect(list(bot)).toContain('1. Группа 1-0 — Песня 0 ✅ · с 0:00');
    expect(list(bot).match(/· с 0:00/g)).toHaveLength(3);
  });

  it('случайное начало всем одним нажатием; песне без длины начало не меняется', () => {
    const play = () => {
      const bot = withSongs();
      const file = { fileId: 'F-doc', fileUniqueId: 'U-doc', mimeType: 'audio/mpeg', sizeBytes: 5_000_000, performer: 'Док', title: 'Без длины' };
      bot.send({ kind: 'files', from: sender(ID), files: [file] });
      bot.processAudio();
      bot.press(ID, 'i:randomAll');
      return bot;
    };
    const bot = play();
    const starts = [0, 1, 2].map((i) => song(bot, i).startSec);
    // Песня 180 с, фрагмент 60 с, без последних 20 с: начало от 0:01 до 1:40.
    for (const start of starts) {
      expect(start).toBeGreaterThan(0);
      expect(start).toBeLessThanOrEqual(100);
    }
    expect(song(bot, 3).startSec).toBe(0);
    expect(list(bot)).toContain('Случайное начало у 3 песен, у 1 — прежнее');
    for (const start of starts) expect(list(bot)).toContain(`· с ${formatClock(start)}`);

    // Перенарезка по новым началам и тот же результат при повторе событий.
    expect(song(bot).processing).toBe('pending');
    bot.processAudio();
    expect(song(bot).processing).toBe('ok');
    expect([0, 1, 2].map((i) => song(play(), i).startSec)).toEqual(starts);
  });

  it('автор пишет время — песня перенарезается и приходит послушать', () => {
    const bot = withSongs();
    const { id } = song(bot);
    bot.press(ID, 'i:pick:start');
    bot.press(ID, `i:n:${id}`);
    bot.text(ID, '1:15');

    expect(song(bot)).toMatchObject({ startSec: 75, processing: 'pending' });
    expect(list(bot)).toContain('· с 1:15');
    expect(preview(bot)?.text).toContain('⏳');

    // Нарезка с прежним началом устарела и не засчитывается.
    bot.send({ kind: 'worker', results: [{ submissionId: id, ok: true, startSec: 0, gameFileId: 'OLD' }] });
    expect(song(bot).processing).toBe('pending');

    bot.processAudio();
    expect(preview(bot)).toMatchObject({ audio: { fileId: `G-${id}@75`, title: 'Трек' } });
    expect(preview(bot)?.text).toContain('Начало 1:15');
    expect(preview(bot)?.text).toContain('Так её услышит судья');
  });

  it('фрагмент целиком умещается в песню: позднее начало и непонятный текст не принимаются', () => {
    const bot = withSongs();
    const { id } = song(bot);
    bot.press(ID, 'i:pick:start');
    bot.press(ID, `i:n:${id}`);
    bot.text(ID, 'с припева');
    expect(list(bot)).toContain('Не разобрал');
    // Песня 3:00, фрагмент 60 с.
    bot.text(ID, '2:30');
    expect(list(bot)).toContain('начало не позже 2:00');
    expect(song(bot).startSec).toBe(0);

    bot.text(ID, '1:55');
    bot.press(ID, `i:shift:${id}:10`);
    expect(song(bot).startSec).toBe(120);
    bot.press(ID, `i:shift:${id}:5`);
    expect(bot.toasts.at(-1)?.text).toBe('Дальше сдвигать некуда');
  });

  it('послушать и сдвинуть кнопками, не выходя за пределы песни', () => {
    const bot = withSongs();
    const { id } = song(bot, 1);
    bot.press(ID, 'i:pick:listen');
    bot.press(ID, `i:n:${id}`);
    expect(preview(bot)).toMatchObject({ audio: { fileId: `G-${id}@0` } });

    bot.press(ID, `i:shift:${id}:-5`);
    expect(bot.toasts.at(-1)?.text).toBe('Дальше сдвигать некуда');
    bot.press(ID, `i:shift:${id}:10`);
    bot.press(ID, `i:shift:${id}:5`);
    expect(song(bot, 1).startSec).toBe(15);
    bot.processAudio();
    expect(preview(bot)).toMatchObject({ audio: { fileId: `G-${id}@15` } });
  });

  it('«Готово» оставляет фрагмент итоговой строкой без кнопок, «Послушать» снова открывает сдвиг', () => {
    const bot = withSongs();
    const { id } = song(bot, 1);
    bot.press(ID, 'i:pick:listen');
    bot.press(ID, `i:n:${id}`);
    bot.press(ID, `i:shift:${id}:10`);
    bot.processAudio();
    bot.press(ID, `i:done:${id}`);

    expect(preview(bot)).toMatchObject({ audio: { fileId: `G-${id}@10` } });
    expect(preview(bot)?.text).toBe('✅ Песня 2: Группа 1-1 — Песня 1\nНачнётся с 0:10.');
    expect(bot.buttons(ID).filter((d) => d.includes(id))).toEqual([]);

    bot.press(ID, 'i:pick:listen');
    bot.press(ID, `i:n:${id}`);
    expect(preview(bot)?.text).toContain('Сдвинуть начало');
    expect(bot.buttons(ID)).toContain(`i:done:${id}`);
  });

  it('случайное начало: фрагмент целиком в песне, повтор событий даёт то же место', () => {
    const play = () => {
      const bot = withSongs();
      const { id } = song(bot);
      bot.press(ID, 'i:pick:start');
      bot.press(ID, `i:n:${id}`);
      bot.press(ID, `i:random:${id}`);
      const first = song(bot).startSec;
      bot.processAudio();
      bot.press(ID, `i:random:${id}`);
      return [first, song(bot).startSec];
    };
    const [first, second] = play();
    // Песня 180 с, фрагмент 60 с, без последних 20 с: начало не позже 1:40.
    for (const start of [first!, second!]) {
      expect(start).toBeGreaterThan(0);
      expect(start).toBeLessThanOrEqual(100);
    }
    expect(second).not.toBe(first);
    expect(play()).toEqual([first, second]);
  });

  it('без нарезки судья видит, с какого места включить песню', () => {
    const bot = new TestBot();
    for (const id of PLAYERS) bot.register(id);
    for (const id of PLAYERS) bot.submitSongs(id, 10);
    for (const s of bot.state.intake.intake.submissions) {
      bot.press(s.owner, 'i:pick:start');
      bot.press(s.owner, `i:n:${s.id}`);
      bot.text(s.owner, '0:30');
    }
    bot.processAudio({ cut: false });
    toDraw(bot);

    const matchId = nextMatch(bot)!;
    const judge = appointJudge(bot, matchId);
    playToDecision(bot, `m:${matchId}:`, judge, matchPlayers(bot.state.draw!, matchId)!, 1);
    const audio = bot.outLog.find((o) => o.kind === 'message' && o.to === judge && o.audio);
    expect(audio).toMatchObject({ text: 'Включи с 0:30', audio: { title: 'Трек 1', fileId: undefined } });
    expect(violations(bot.outLog)).toEqual([]);
  });
});

describe('Регистрация', () => {
  it('своё имя текстом, затем правила', () => {
    const bot = new TestBot();
    bot.command('1', '/start t_test');
    bot.text('1', 'Аня');
    expect(bot.lastText('1')).toContain('Имя: Аня');
    bot.press('1', 'r:accept');
    expect(bot.state.people['1']).toMatchObject({ name: 'Аня', number: 1, username: 'user1' });
    expect(bot.allText('1')).toContain('Пришли до 10 песен');
  });

  it('без ссылки-приглашения не регистрирует', () => {
    const bot = new TestBot();
    bot.command('1', '/start');
    bot.command('1', '/start t_wrong');
    expect(bot.state.people).toEqual({});
    expect(bot.state.registration).toEqual({});
  });

  it('организатор может играть: его панель и его список песен не путаются', () => {
    const bot = new TestBot();
    bot.register(ORGANIZER);
    bot.submitSongs(ORGANIZER, 3);
    bot.open(ORGANIZER, 'intake');
    expect(bot.hasButton(ORGANIZER, 'o:closeIntake')).toBe(true);
    expect(bot.hasButton(ORGANIZER, 'i:pick:remove')).toBe(true);
    bot.press(ORGANIZER, 'i:pick:remove');
    expect(bot.state.phase).toBe('intake');
    expect(bot.state.intake.closed).toBeNull();
  });

  it('после закрытия сбора — только судить', () => {
    const bot = readyForQualifiers();
    bot.register(GUEST);
    expect(bot.state.people[GUEST]).toBeDefined();
    expect(bot.allText(GUEST)).toContain('сыграть не выйдет');
    expect(bot.state.draw!.config.registered.some((p) => p.id === GUEST)).toBe(true);
  });

  it('правила называют число треков и отрыв в отборе — из настроек', () => {
    const bot = new TestBot();
    bot.command('1', '/start t_test');
    bot.press('1', 'r:name');
    expect(bot.lastText('1')).toContain('• В матче отбора 5 треков. Если отрыв меньше 2,0 балла — ещё по треку, пока кто-то не оторвётся на 2,0.');
    // «Любой» отрыв — прежнее правило: дополнительные треки только при ничьей.
    bot.open(ORGANIZER, 'settings');
    for (const action of ['o:set:lead', 'o:set:lead:0', 'o:set:tracks', 'o:set:tracks:3']) bot.press(ORGANIZER, action);
    bot.command('2', '/start t_test');
    bot.press('2', 'r:name');
    expect(bot.lastText('2')).toContain('• В матче отбора 3 трека; при ничьей — ещё по треку, пока кто-то не вырвется вперёд.');
  });
});

describe('Судья по ссылке', () => {
  it('незарегистрированный открывает ссылку, регистрируется и получает приглашение', () => {
    const bot = readyForQualifiers();
    const matchId = nextMatch(bot)!;
    const [a, b] = matchPlayers(bot.state.draw!, matchId)!;
    bot.register(GUEST, `judge_${matchId}`);
    bot.press(GUEST, `d:accept:${matchId}`);
    bot.press(a, `d:confirmJudge:${matchId}`);
    bot.press(b, `d:confirmJudge:${matchId}`);
    expect(bot.state.matches[matchId]?.session.config.judge.id).toBe(GUEST);
    expect(bot.hasButton(GUEST, `m:${matchId}:ready`)).toBe(true);
  });

  it('игрок не может судить свой матч по ссылке', () => {
    const bot = readyForQualifiers();
    const matchId = nextMatch(bot)!;
    const [a] = matchPlayers(bot.state.draw!, matchId)!;
    bot.command(a, `/start judge_${matchId}`);
    expect(bot.lastText(a)).toContain('собственный матч');
    expect(bot.state.draw!.judges[matchId]).toBeUndefined();
  });
});

describe('Споры и решения организатора', () => {
  function decided() {
    const bot = readyForQualifiers();
    const matchId = nextMatch(bot)!;
    const judge = appointJudge(bot, matchId);
    const players = matchPlayers(bot.state.draw!, matchId)!;
    playToDecision(bot, `m:${matchId}:`, judge, players);
    bot.press(judge, `m:${matchId}:confirm`);
    return { bot, matchId, judge, players };
  }

  it('спор блокирует сетку; переигровка открывает новый матч без уже прозвучавших песен', () => {
    const { bot, matchId, judge, players } = decided();
    bot.press(players[1], `x:dispute:${matchId}`);
    bot.press(players[0], `m:${matchId}:confirm`);
    bot.press(players[1], `m:${matchId}:confirm`);
    // Оба подтвердили, но спор открыт — результат в сетку не идёт.
    expect(bot.state.draw!.results[matchId]).toBeUndefined();
    expect(bot.allText(ORGANIZER)).toContain('Спор по матчу');

    const first = bot.state.matches[matchId]!.session.issued.map((t) => t.songId);
    bot.press(ORGANIZER, `o:open:${matchId}`);
    bot.press(ORGANIZER, `o:replay:${matchId}`);
    const replay = bot.state.matches[matchId]!;
    expect(replay.attempt).toBe(1);
    expect(replay.closed).toBe(false);
    // Уведомление о споре прошлой попытки решено, кнопки «Открыть в панели» больше нет.
    expect(bot.allText(ORGANIZER)).toContain('✅ Решено.');
    expect(bot.hasButton(ORGANIZER, `o:open:${matchId}`)).toBe(false);
    expect(bot.allText(players[1])).toContain('будет переигран по решению организатора');

    playToDecision(bot, `m:${matchId}:`, judge, players);
    const second = bot.state.matches[matchId]!.session.issued.map((t) => t.songId);
    expect(second.filter((id) => first.includes(id))).toEqual([]);
    confirmAll(bot, `m:${matchId}:`, judge, players);
    expect(bot.state.draw!.results[matchId]).toBe(players[0]);
  });

  it('организатор оставляет результат при споре', () => {
    const { bot, matchId, players } = decided();
    bot.press(players[1], `x:dispute:${matchId}`);
    bot.press(ORGANIZER, `o:open:${matchId}`);
    bot.press(ORGANIZER, `o:keep:${matchId}`);
    expect(bot.state.draw!.results[matchId]).toBe(players[0]);
    expect(bot.state.matches[matchId]!.closed).toBe(true);
    expect(bot.allText(ORGANIZER)).toContain('✅ Решено.');
  });

  it('технический результат командой /tech', () => {
    const bot = readyForQualifiers();
    const matchId = nextMatch(bot)!;
    const [, b] = matchPlayers(bot.state.draw!, matchId)!;
    const label = matchId.replace(/^r(\d+)-(\d+)$/, '$1.$2');
    const number = bot.state.people[b]!.number;
    bot.command(ORGANIZER, `/tech ${label} ${number} неявка соперника`);
    expect(bot.state.draw!.results[matchId]).toBe(b);
    expect(bot.state.draw!.journal.at(-1)).toContain('технический результат: неявка соперника');
    expect(bot.lastText(b)).toContain('закрыт без игры (неявка соперника)');
  });

  it('/tech не доступна участнику', () => {
    const bot = readyForQualifiers();
    bot.command('1', '/tech 1.1 1 так');
    expect(Object.keys(bot.state.draw!.results)).toEqual([]);
  });
});

describe('Инструменты организатора', () => {
  it('техническая победа кнопками: матчи → матч → кому → подтверждение', () => {
    const bot = readyForQualifiers();
    const matchId = nextMatch(bot)!;
    const [a, b] = matchPlayers(bot.state.draw!, matchId)!;
    bot.open(ORGANIZER, 'matches');
    bot.press(ORGANIZER, `o:m:${matchId}`);
    bot.press(ORGANIZER, `o:techMatch:${matchId}`);
    bot.press(ORGANIZER, `o:techWin:${matchId}:${b}`);
    expect(bot.allText(ORGANIZER)).toContain('Засчитать техническую победу');
    expect(bot.state.draw!.results[matchId]).toBeUndefined();

    bot.press(ORGANIZER, `o:techOk:${matchId}:${b}`);
    expect(bot.state.draw!.results[matchId]).toBe(b);
    expect(bot.state.adminMenu).toBeNull();
    expect(bot.allText(a)).toContain('закрыт без игры (решение организатора)');
    expect(violations(bot.outLog)).toEqual([]);
  });

  it('меню общее на админов: «Засчитать» засчитывает то, что видел нажавший', () => {
    const ADMIN = '950';
    const bot = readyForQualifiers(new TestBot(testConfig({ adminIds: [ADMIN] })));
    const matchId = nextMatch(bot)!;
    const [a, b] = matchPlayers(bot.state.draw!, matchId)!;
    bot.open(ORGANIZER, 'matches');
    bot.press(ORGANIZER, `o:m:${matchId}`);
    bot.press(ORGANIZER, `o:techMatch:${matchId}`);
    bot.press(ORGANIZER, `o:techWin:${matchId}:${b}`);
    // Админ открыл то же меню и выбрал другого — организатор ещё видит своё подтверждение.
    bot.send({ kind: 'button', from: sender(ADMIN), data: `o:techWin:${matchId}:${a}` });
    bot.send({ kind: 'button', from: sender(ORGANIZER), data: `o:techOk:${matchId}:${b}` });
    expect(bot.state.draw!.results[matchId]).toBe(b);
    // Матч закрыт — подтверждения в карточке больше нет.
    expect(bot.buttons(ORGANIZER).some((data) => data.startsWith('o:techOk'))).toBe(false);
  });

  it('отмена закрывает подтверждение, ничего не меняя', () => {
    const bot = readyForQualifiers();
    const [a] = matchPlayers(bot.state.draw!, nextMatch(bot)!)!;
    bot.open(ORGANIZER, 'players');
    bot.press(ORGANIZER, `o:p:${a}`);
    bot.press(ORGANIZER, `o:withdrawPick:${a}`);
    expect(bot.hasButton(ORGANIZER, 'o:menu:close')).toBe(true);
    bot.press(ORGANIZER, 'o:menu:close');
    expect(bot.state.adminMenu).toBeNull();
    expect(bot.state.withdrawn).toEqual([]);
    expect(bot.hasButton(ORGANIZER, `o:withdrawPick:${a}`)).toBe(true);
  });

  it('снятый игрок: текущий матч — сопернику, в будущей паре — техническое поражение', () => {
    const bot = readyForQualifiers();
    const draw = bot.state.draw!;
    // Матч первого круга, победитель которого встретится с игроком, прошедшим без игры.
    const first = draw.bracket!.rounds[0]!.find((m) => !m.isBye)!;
    const second = draw.bracket!.rounds[1]!.find((m) => m.slots.some((s) => s.kind === 'winnerOf' && s.matchId === first.id))!;
    const waiting = second.slots.map((slot) => resolveSlot(draw.bracket!, draw.results, slot)).find(Boolean)!;
    const [a, b] = matchPlayers(draw, first.id)!;

    // Ждущего соперника снимаем заранее: пока пары нет, результата нет.
    bot.open(ORGANIZER, 'players');
    bot.press(ORGANIZER, `o:p:${waiting}`);
    bot.press(ORGANIZER, `o:withdrawPick:${waiting}`);
    bot.press(ORGANIZER, `o:withdrawOk:${waiting}`);
    expect(bot.state.withdrawn).toEqual([waiting]);
    expect(bot.lastText(waiting)).toContain('Тебя сняли с турнира по решению организатора');
    expect(bot.state.draw!.results[second.id]).toBeUndefined();

    // Снятие игрока текущего матча закрывает его в пользу соперника, а следующая пара —
    // с заранее снятым — закрывается сама.
    expect(bot.hasButton(ORGANIZER, `o:withdrawPick:${waiting}`)).toBe(false);
    bot.open(ORGANIZER, 'players');
    bot.press(ORGANIZER, `o:p:${a}`);
    bot.press(ORGANIZER, `o:withdrawPick:${a}`);
    bot.press(ORGANIZER, `o:withdrawOk:${a}`);
    expect(bot.state.draw!.results[first.id]).toBe(b);
    expect(bot.state.draw!.results[second.id]).toBe(b);
    expect(bot.allText(b)).toContain('соперник снят с турнира');
    // Снятым про их пары не пишем: о снятии они уже знают.
    expect(bot.allText(a)).not.toContain('соперник снят');
    expect(bot.allText(waiting)).not.toContain('соперник снят');
    expect(bot.state.draw!.bracket!.rounds.at(-1)!.some((m) => bot.state.draw!.results[m.id] === b)).toBe(true);
  });
});

describe('/status', () => {
  function status(bot: TestBot, id: UserId): string {
    bot.command(id, '/status');
    return bot.lastText(id);
  }

  it('на сборе: сколько песен принято; после регистрации — подсказка команд', () => {
    const bot = new TestBot();
    bot.register('1');
    expect(bot.allText('1')).toContain('Команды: /status — где ты сейчас, /matches');
    bot.submitSongs('1', 3);
    bot.processAudio();
    expect(status(bot, '1')).toContain('🎵 Песен принято: 3 из 10');
    expect(status(bot, '1')).toContain('Команды: /matches — кто с кем играет, /help');
  });

  it('на отборе: свой матч по шагам, судейство, ожидание соперника и итог', () => {
    const bot = readyForQualifiers();
    const draw = bot.state.draw!;
    const first = draw.bracket!.rounds[0]!.find((m) => !m.isBye)!;
    const second = draw.bracket!.rounds[1]!.find((m) => m.slots.some((slot) => slot.kind === 'winnerOf' && slot.matchId === first.id))!;
    const waiting = second.slots.map((slot) => resolveSlot(draw.bracket!, draw.results, slot)).find(Boolean)!;
    const [a, b] = matchPlayers(draw, first.id)!;
    const name = (id: UserId) => bot.state.people[id]!.name;

    expect(status(bot, a)).toMatch(new RegExp(`🎤 Твой матч №1\\.\\d, соперник — ${name(b)}, сыграть до \\d+ \\S+ включительно\\. Сейчас: нужно выбрать судью`));
    expect(status(bot, waiting)).toContain(`⏳ Твой следующий матч №2.`);
    expect(status(bot, waiting)).toContain(`соперник определится в №1.`);

    const judge = appointJudge(bot, first.id);
    expect(status(bot, a)).toContain(`ждём «Все на месте», судья ${name(judge)}`);
    expect(status(bot, judge)).toMatch(/⚖️ Судишь №1\.\d: .+: ждём «Все на месте»$/m);
    expect(status(bot, ORGANIZER)).toContain('Ты организатор турнира.');
    playToDecision(bot, `m:${first.id}:`, judge, [a, b], 1);
    expect(status(bot, b)).toMatch(/идёт, .+ 2,5 : 0,0 .+, судья /);
    expect(status(bot, ORGANIZER)).toMatch(/🎤 Матчи: сыграно 0 из 3 · идут 1 · без судьи \d/);
    expect(status(bot, ORGANIZER)).toContain('Организатору: /panel');

    bot.open(ORGANIZER, 'matches');
    bot.press(ORGANIZER, `o:m:${first.id}`);
    bot.press(ORGANIZER, `o:techMatch:${first.id}`);
    bot.press(ORGANIZER, `o:techWin:${first.id}:${a}`);
    bot.press(ORGANIZER, `o:techOk:${first.id}:${a}`);
    expect(status(bot, b)).toContain(`Отбор для тебя закончен: в ${'№'}1.`);
    expect(status(bot, b)).toContain(`дальше проходит ${name(a)}`);
    expect(status(bot, a)).toContain(`🎤 Твой матч №2.`);
  });
});

describe('/matches', () => {
  it('сбор, ожидание пар, живой матч со счётом и судьёй, сыгранные', () => {
    const bot = new TestBot();
    bot.register('1');
    bot.command('1', '/matches');
    expect(bot.lastText('1')).toContain('Идёт сбор песен');

    const ready = readyForQualifiers();
    const matchId = nextMatch(ready)!;
    ready.command(GUEST, '/start');
    ready.command('1', '/matches');
    expect(ready.lastText('1')).toContain('Ждут начала');
    expect(ready.lastText('1')).toContain('выбирают судью');

    const judge = appointJudge(ready, matchId);
    const players = matchPlayers(ready.state.draw!, matchId)!;
    playToDecision(ready, `m:${matchId}:`, judge, players, 1);
    ready.command('1', '/matches');
    expect(ready.lastText('1')).toMatch(/Сейчас играют:\n🎤 №\d\.\d: .+ 2,5 : 0,0 .+ · судья /);

    for (let i = 1; i < 5; i++) {
      ready.press(judge, `m:${matchId}:issue`);
      ready.press(judge, `m:${matchId}:start`);
      ready.press(judge, `m:${matchId}:aw:a:0`);
      ready.press(judge, `m:${matchId}:aw:t:0`);
      ready.press(judge, `m:${matchId}:close`);
    }
    confirmAll(ready, `m:${matchId}:`, judge, players);
    ready.command('1', '/matches');
    expect(ready.lastText('1')).toContain('Сыграно:');
    expect(ready.lastText('1')).toContain(`→ ${ready.state.people[players[0]]!.name}`);
  });

  it('в финале на двоих единственный матч называется «Финал»', () => {
    const bot = readyForQualifiers();
    for (let id = nextMatch(bot); id; id = nextMatch(bot)) playQualifier(bot, id);
    bot.press(ORGANIZER, 'o:toFinal');
    bot.command('1', '/matches');
    expect(bot.lastText('1')).toContain('Финал ещё не начался');
    bot.register(FINAL_JUDGE, 'fjudge_test');
    bot.press(ORGANIZER, 'o:openFinal');
    bot.command('1', '/matches');
    expect(bot.lastText('1')).toMatch(/⏳ Финал: .+ — .+/);
  });
});

describe('Напоминания', () => {
  it('минута на трек и 10 минут на подтверждение с передачей организатору', () => {
    const bot = readyForQualifiers();
    const matchId = nextMatch(bot)!;
    const judge = appointJudge(bot, matchId);
    const players = matchPlayers(bot.state.draw!, matchId)!;
    const p = `m:${matchId}:`;
    bot.press(judge, `${p}ready`);
    bot.press(players[0], `${p}ready`);
    bot.press(players[1], `${p}ready`);
    bot.press(judge, `${p}issue`);
    bot.press(judge, `${p}start`);

    bot.send({ kind: 'tick' }, 30_000);
    expect(bot.lastText(judge)).not.toContain('больше минуты');
    bot.send({ kind: 'tick' }, 31_000);
    expect(bot.lastText(judge)).toContain('больше минуты');
    const reminders = bot.outLog.length;
    bot.send({ kind: 'tick' }, 60_000);
    expect(bot.outLog.length).toBe(reminders);

    bot.press(judge, `${p}none`);
    for (let i = 0; i < 4; i++) {
      bot.press(judge, `${p}issue`);
      bot.press(judge, `${p}start`);
      bot.press(judge, `${p}aw:a:0`);
      bot.press(judge, `${p}close`);
    }
    bot.send({ kind: 'tick' }, 11 * 60_000);
    expect(bot.lastText(players[1])).toContain('Подтверди результат');
    expect(bot.allText(ORGANIZER)).toContain('не подтверждён 10 минут');
    bot.press(ORGANIZER, `o:open:${matchId}`);
    bot.press(ORGANIZER, `o:keep:${matchId}`);
    expect(bot.state.draw!.results[matchId]).toBe(players[0]);
  });

  it('срок круга: утром последнего дня — паре, наутро после — организатору', () => {
    const bot = readyForQualifiers();
    const matchId = nextMatch(bot)!;
    const [a, b] = matchPlayers(bot.state.draw!, matchId)!;
    // Срок «до N октября» включительно: круг заканчивается в полночь по Москве, 21:00 UTC.
    const end = Date.parse(`${bot.state.draw!.deadlines[0]}T21:00:00Z`);
    const hour = 3600_000;

    bot.send({ kind: 'tick' }, end - 15 * hour - bot.now);
    expect(bot.allText(a)).not.toContain('последний день');
    bot.send({ kind: 'tick' }, hour);
    expect(bot.lastText(a)).toContain('📅 Сегодня последний день для твоего матча');
    expect(bot.lastText(a)).toContain(`соперник — ${bot.state.people[b]!.name}`);

    bot.send({ kind: 'tick' }, 14 * hour);
    expect(bot.allText(ORGANIZER)).not.toContain('круг закончился');
    bot.send({ kind: 'tick' }, 10 * hour);
    expect(bot.lastText(ORGANIZER)).toContain('⌛ 1-й круг закончился, а эти матчи так и не сыграны');
  });

  it('срок круга считается по Москве: жеребьёвка в час ночи — уже новый день', () => {
    const bot = new TestBot(testConfig({ roundDays: 1 }));
    for (const id of PLAYERS) bot.register(id);
    for (const id of PLAYERS) bot.submitSongs(id, 10);
    bot.processAudio();
    bot.now = Date.parse('2026-10-10T22:30:00Z'); // 11 октября, 01:30 по Москве
    toDraw(bot);
    expect(bot.state.draw!.deadlines[0]).toBe('2026-10-12');
  });

  it('без срока: дат нет ни в карточках, ни в статусе, продлевать нечего, напоминаний нет', () => {
    const bot = readyForQualifiers(new TestBot(testConfig({ roundDays: 0 })));
    const matchId = nextMatch(bot)!;
    const [a] = matchPlayers(bot.state.draw!, matchId)!;
    expect(bot.state.draw!.deadlines).toEqual([]);
    expect(bot.allText(a)).toContain('Соперник:');
    expect(bot.allText(a)).not.toContain('включительно');
    bot.command(a, '/status');
    expect(bot.lastText(a)).toMatch(/🎤 Твой матч №\d\.\d, соперник — .+\. Сейчас: нужно выбрать судью/);

    bot.open(ORGANIZER, 'bracket');
    expect(bot.allText(ORGANIZER)).toContain('1-й круг · ');
    expect(bot.allText(ORGANIZER)).not.toContain('1-й круг · до');
    expect(bot.buttons(ORGANIZER).some((data) => data.startsWith('o:shift:'))).toBe(false);

    const before = bot.outLog.length;
    bot.send({ kind: 'tick' }, 30 * 24 * 3600_000);
    const texts = bot.outLog.slice(before).flatMap((o) => (o.kind === 'message' ? [o.text] : []));
    expect(texts.filter((text) => /последний день|круг закончился/.test(text))).toEqual([]);
  });
});

describe('Панель админа', () => {
  const ADMIN = '950';
  const panel = (bot: TestBot, id: UserId) => bot.chats[id]?.messages.find((m) => m.author === 'bot' && m.slot === 'o:phase');
  const panelText = (bot: TestBot, id: UserId) => {
    const message = panel(bot, id);
    return message?.author === 'bot' ? message.text : '';
  };

  it('главный экран и разделы по этапам; из раздела — назад', () => {
    const bot = new TestBot();
    for (const id of PLAYERS) bot.register(id);
    expect(panelText(bot, ORGANIZER)).toContain('Этап: регистрация и сбор песен');
    expect(bot.buttons(ORGANIZER)).toEqual(['o:v:intake', 'o:v:players', 'o:v:broadcast', 'o:v:settings', 't:list']);

    bot.open(ORGANIZER, 'players');
    expect(panelText(bot, ORGANIZER)).toContain('№1 Игрок 1 @user1 · песен: 0 из 10');
    bot.open(ORGANIZER, 'intake');
    expect(panelText(bot, ORGANIZER)).toContain('Сбор песен');
    expect(bot.hasButton(ORGANIZER, 'o:closeIntake')).toBe(true);
    bot.open(ORGANIZER, 'home');
    expect(bot.hasButton(ORGANIZER, 'o:closeIntake')).toBe(false);

    // Панель — одно сообщение: переходы правят его на месте.
    expect(bot.chats[ORGANIZER]!.messages.filter((m) => m.author === 'bot' && m.slot === 'o:phase')).toHaveLength(1);
    expect(violations(bot.outLog)).toEqual([]);
  });

  it('у админа своя панель: свой раздел, общие действия, ответы — ему', () => {
    const bot = new TestBot(testConfig({ adminIds: [ADMIN] }));
    for (const id of PLAYERS) bot.register(id);
    for (const id of PLAYERS) bot.submitSongs(id, 10);
    bot.processAudio();

    bot.command(ADMIN, '/panel');
    expect(panelText(bot, ADMIN)).toContain('📣 Тестовый турнир');
    bot.open(ADMIN, 'intake');
    bot.press(ADMIN, 'o:closeIntake');
    expect(bot.state.intake.closed).not.toBeNull();
    // У организатора панель осталась на главном экране, но сводка обновилась.
    expect(panelText(bot, ORGANIZER)).toContain('Допущено к жеребьёвке: 5');

    bot.send({ kind: 'button', from: sender(ADMIN), data: 'o:toFinal' });
    expect(bot.toasts.at(-1)).toEqual({ to: ADMIN, text: 'Отбор ещё не закончен' });
    bot.command('1', '/panel');
    expect(panelText(bot, '1')).toBe('');
  });

  it('кнопки прошлой версии значат то же самое: повтор журнала не расходится', () => {
    const bot = readyForQualifiers();
    const matchId = nextMatch(bot)!;
    const [, b] = matchPlayers(bot.state.draw!, matchId)!;
    // Нажатия из старой панели этапа — таких кнопок больше не видно, но в журнале они есть.
    for (const data of ['o:menu:tech', `o:techMatch:${matchId}`, `o:techWin:${matchId}:${b}`, 'o:techOk']) {
      bot.send({ kind: 'button', from: sender(ORGANIZER), data });
    }
    expect(bot.state.draw!.results[matchId]).toBe(b);
    expect(bot.state.panels?.[ORGANIZER]).toBe(`match:${matchId}`);
  });

  it('снимок прошлой версии без панелей открывается на главном экране', () => {
    const bot = readyForQualifiers();
    const { panels: _, ...old } = bot.state;
    bot.state = old as TournamentState;
    bot.command(ORGANIZER, '/panel');
    expect(bot.lastText(ORGANIZER)).toContain('Этап: отбор');
  });

  it('ник и имя из профиля обновляются; в карточке — ссылка на чат', () => {
    const bot = new TestBot();
    bot.register('1');
    bot.send({ kind: 'command', from: { id: '1', name: 'Анна Миронова', username: 'anna_m' }, command: 'status', payload: '' });
    expect(bot.state.people['1']).toMatchObject({ name: 'Игрок 1', username: 'anna_m', profileName: 'Анна Миронова' });

    bot.open(ORGANIZER, 'players');
    bot.press(ORGANIZER, 'o:p:1');
    expect(panelText(bot, ORGANIZER)).toContain('Telegram: @anna_m · Анна Миронова');
    const link = () => {
      const message = panel(bot, ORGANIZER);
      return message?.author === 'bot' ? message.buttons?.flat().find((b) => b.url) : undefined;
    };
    expect(link()?.url).toBe('https://t.me/anna_m');

    // Без ника — имя из профиля и без ссылки: по одному ID Telegram её может не открыть.
    bot.send({ kind: 'command', from: { id: '1', name: 'Анна Миронова' }, command: 'status', payload: '' });
    bot.press(ORGANIZER, 'o:v:players');
    expect(panelText(bot, ORGANIZER)).toContain('№1 Игрок 1 (без ника, в Telegram — Анна Миронова)');
    bot.press(ORGANIZER, 'o:p:1');
    expect(link()).toBeUndefined();
  });

  it('/rename — только организатор; /game — настройки', () => {
    const bot = new TestBot(testConfig({ adminIds: [ADMIN] }));
    bot.command(ORGANIZER, '/rename Осенний турнир');
    expect(bot.state.config.title).toBe('Осенний турнир');
    expect(panelText(bot, ORGANIZER)).toContain('📣 Осенний турнир');
    bot.command(ORGANIZER, '/rename а');
    expect(bot.lastText(ORGANIZER)).toContain('от 2 до 48 символов');
    bot.command(ADMIN, '/rename Чужое');
    expect(bot.state.config.title).toBe('Осенний турнир');

    bot.command(ADMIN, '/game');
    expect(bot.lastText(ADMIN)).toContain('👥 Финалистов: 2');
    expect(bot.lastText(ADMIN)).toContain('🎯 Очки: исполнитель 1,0, название 1,5');
    expect(bot.lastText(ADMIN)).toContain('📏 Отрыв в отборе: от 2,0');
  });

  it('«Открыть в панели» из уведомления переносит панель вниз, к карточке матча', () => {
    const bot = readyForQualifiers();
    const matchId = nextMatch(bot)!;
    const judge = appointJudge(bot, matchId);
    const players = matchPlayers(bot.state.draw!, matchId)!;
    playToDecision(bot, `m:${matchId}:`, judge, players);
    bot.press(players[1], `x:dispute:${matchId}`);

    const out = bot.press(ORGANIZER, `o:open:${matchId}`);
    expect(out).toContainEqual(expect.objectContaining({ to: ORGANIZER, slot: 'o:phase', bump: true }));
    expect(bot.lastText(ORGANIZER)).toContain('⚠️ Спор: результат оспаривает');
    expect(bot.hasButton(ORGANIZER, `o:keep:${matchId}`)).toBe(true);
  });
});

describe('Только песни, без игры', () => {
  it('песни идут в пулы, а в недобравших и в жеребьёвке такого участника нет; судить может', () => {
    const bot = new TestBot();
    for (const id of PLAYERS) bot.register(id);
    bot.command(GUEST, '/start t_test');
    bot.press(GUEST, 'r:name');
    bot.press(GUEST, 'r:songs');
    expect(isSongsOnly(bot.state.intake, GUEST)).toBe(true);
    expect(bot.allText(GUEST)).toContain('Присылаешь песни, но не играешь');

    for (const id of PLAYERS) bot.submitSongs(id, 10);
    bot.submitSongs(GUEST, 4);
    bot.processAudio();
    bot.open(ORGANIZER, 'intake');
    expect(bot.allText(ORGANIZER)).toContain('🎁 Только песни: Игрок 6 — 4');
    bot.press(ORGANIZER, 'o:closeIntake');
    // Четыре песни из десяти, но решать по нему не нужно: он не играет.
    expect(readyForDraw(bot.state.intake)).toBe(true);
    expect(admittedPlayers(bot.state.intake).map((p) => p.id)).toEqual(PLAYERS);
    const own = acceptedSongs(bot.state.intake.intake).filter((song) => song.knownBy.includes(GUEST)).map((song) => song.key);
    const { split } = bot.state.intake.closed!;
    expect(own).toHaveLength(4);
    expect(own.every((key) => split.main.includes(key) || split.final.includes(key))).toBe(true);

    bot.open(ORGANIZER, 'home');
    bot.press(ORGANIZER, 'o:toDraw');
    bot.open(ORGANIZER, 'bracket');
    bot.press(ORGANIZER, 'o:draw');
    expect(bot.state.draw!.config.players.map((p) => p.id)).not.toContain(GUEST);
    expect(bot.state.draw!.config.registered.some((p) => p.id === GUEST)).toBe(true);
    bot.command(GUEST, '/status');
    expect(bot.lastText(GUEST)).toContain('🎁 Твои песни в игре, а в матчах ты не участвуешь.');
    bot.open(ORGANIZER, 'players');
    expect(bot.allText(ORGANIZER)).toContain('№6 Игрок 6 @user6 · 🎁 только песни');
  });

  it('передумать можно до закрытия сбора: сам — под списком песен, админ — в карточке', () => {
    const bot = new TestBot();
    bot.register('1');
    bot.press('1', 'i:role:songs');
    expect(isSongsOnly(bot.state.intake, '1')).toBe(true);
    expect(bot.allText('1')).toContain('Ты только присылаешь песни');
    bot.press('1', 'i:role:play');
    expect(isSongsOnly(bot.state.intake, '1')).toBe(false);

    bot.open(ORGANIZER, 'players');
    bot.press(ORGANIZER, 'o:p:1');
    bot.press(ORGANIZER, 'o:songsOnly:1');
    expect(isSongsOnly(bot.state.intake, '1')).toBe(true);
    expect(bot.hasButton('1', 'i:role:play')).toBe(true);
    bot.press(ORGANIZER, 'o:player:1');
    expect(isSongsOnly(bot.state.intake, '1')).toBe(false);

    bot.open(ORGANIZER, 'intake');
    bot.press(ORGANIZER, 'o:closeIntake');
    expect(bot.hasButton('1', 'i:role:songs')).toBe(false);
    bot.send({ kind: 'button', from: sender(ORGANIZER), data: 'o:songsOnly:1' });
    expect(bot.toasts.at(-1)).toEqual({ to: ORGANIZER, text: 'Сбор уже закрыт' });
    expect(isSongsOnly(bot.state.intake, '1')).toBe(false);
  });

  it('после закрытия сбора выбора нет: можно только судить', () => {
    const bot = readyForQualifiers();
    bot.command(GUEST, '/start t_test');
    bot.press(GUEST, 'r:name');
    expect(bot.hasButton(GUEST, 'r:songs')).toBe(false);
    expect(bot.hasButton(GUEST, 'r:accept')).toBe(true);
  });
});

describe('Выход из турнира (/leave)', () => {
  const ADMIN = '950';

  it('на сборе: песни остаются, в жеребьёвку не попадает; админам — уведомление', () => {
    const bot = new TestBot(testConfig({ adminIds: [ADMIN] }));
    for (const id of PLAYERS) bot.register(id);
    bot.submitSongs('1', 10);
    bot.processAudio();
    bot.command('1', '/leave');
    expect(bot.lastText('1')).toContain('Точно не играешь?');
    bot.press('1', 'l:ok:intake');
    expect(isSongsOnly(bot.state.intake, '1')).toBe(true);
    expect(bot.state.intake.intake.submissions.filter((sub) => sub.owner === '1' && !sub.rejection)).toHaveLength(10);
    expect(bot.lastText(ADMIN)).toContain('№1 Игрок 1 больше не играет — песни остаются в турнире.');
    expect(bot.allText(ORGANIZER)).toContain('№1 Игрок 1 больше не играет');
    bot.command('1', '/leave');
    expect(bot.lastText('1')).toContain('Ты и так не играешь');
  });

  it('«Остаться» на любом шаге ничего не меняет', () => {
    const bot = readyForQualifiers();
    const [a] = matchPlayers(bot.state.draw!, nextMatch(bot)!)!;
    bot.command(a, '/leave');
    bot.press(a, 'l:cancel');
    expect(bot.allText(a)).toContain('Остаёшься в турнире');
    expect(bot.hasButton(a, 'l:ok:bracket')).toBe(false);

    bot.command(a, '/leave');
    bot.press(a, 'l:ok:bracket');
    bot.press(a, 'l:cancel');
    expect(bot.state.withdrawn).toEqual([]);
    expect(bot.hasButton(a, 'l:final:bracket')).toBe(false);
  });

  it('на отборе: текущий матч — сопернику, следующие — техническое поражение; судить можно', () => {
    const bot = readyForQualifiers(new TestBot(testConfig({ adminIds: [ADMIN] })));
    const matchId = nextMatch(bot)!;
    const [a, b] = matchPlayers(bot.state.draw!, matchId)!;
    bot.command(a, '/leave');
    expect(bot.lastText(a)).toContain('Текущий матч засчитается сопернику');
    bot.press(a, 'l:ok:bracket');
    // Выход необратим — второй шаг, и до него ничего не меняется.
    expect(bot.lastText(a)).toContain('Вернуться в турнир будет нельзя');
    expect(bot.state.withdrawn).toEqual([]);
    bot.press(a, 'l:final:bracket');

    expect(bot.state.withdrawn).toEqual([a]);
    expect(bot.state.left).toEqual([a]);
    expect(bot.state.draw!.results[matchId]).toBe(b);
    expect(bot.allText(b)).toContain('закрыт без игры (соперник вышел из турнира)');
    expect(bot.allText(a)).toContain('ты больше не в турнире. Спасибо за игру!');
    // Самому вышедшему про его пары не пишем.
    expect(bot.allText(a)).not.toContain('соперник вышел');
    expect(bot.lastText(ADMIN)).toContain('покидает турнир по своему желанию');
    expect(bot.state.draw!.config.registered.some((p) => p.id === a)).toBe(true);

    bot.command(a, '/status');
    expect(bot.lastText(a)).toContain('🚪 Ты больше не в турнире.');
    bot.command(a, '/leave');
    expect(bot.lastText(a)).toContain('Ты уже не в турнире.');
    bot.open(ORGANIZER, 'players');
    expect(bot.allText(ORGANIZER)).toContain('🚪 выход по своему желанию');
  });

  it('после перехода к жеребьёвке, но до неё — просто не попадает в сетку', () => {
    const bot = new TestBot();
    for (const id of PLAYERS) bot.register(id);
    for (const id of PLAYERS) bot.submitSongs(id, 10);
    bot.processAudio();
    bot.open(ORGANIZER, 'intake');
    bot.press(ORGANIZER, 'o:closeIntake');
    bot.open(ORGANIZER, 'home');
    bot.press(ORGANIZER, 'o:toDraw');

    bot.command('5', '/leave');
    expect(bot.lastText('5')).toContain('В жеребьёвку ты не попадёшь');
    bot.press('5', 'l:ok:draw');
    bot.press('5', 'l:final:draw');
    expect(bot.allText('5')).not.toContain('ждём жеребьёвку');
    bot.command('5', '/status');
    expect(bot.lastText('5')).toContain('🚪 Ты больше не в турнире.');
    bot.open(ORGANIZER, 'bracket');
    bot.press(ORGANIZER, 'o:draw');
    expect(bot.state.draw!.config.players.map((p) => p.id)).toEqual(['1', '2', '3', '4']);
    expect(bot.state.left).toEqual(['5']);
    expect(bot.state.draw!.results).toEqual({});
    bot.open(ORGANIZER, 'players');
    expect(bot.allText(ORGANIZER)).toContain('№5 Игрок 5 @user5 · 🚪 выход по своему желанию');
  });

  it('игроков столько же, сколько мест в финале: жеребьёвка проходит, выйти до неё нельзя', () => {
    const bot = new TestBot();
    for (const id of ['1', '2', '3']) bot.register(id);
    for (const id of ['1', '2', '3']) bot.submitSongs(id, 10);
    bot.processAudio();
    bot.open(ORGANIZER, 'intake');
    bot.press(ORGANIZER, 'o:closeIntake');
    bot.open(ORGANIZER, 'home');
    bot.press(ORGANIZER, 'o:toDraw');
    bot.command('3', '/leave');
    bot.press('3', 'l:ok:draw');
    bot.press('3', 'l:final:draw');
    bot.command('2', '/leave');
    expect(bot.lastText('2')).toContain('игроков станет меньше, чем мест в финале');

    bot.open(ORGANIZER, 'bracket');
    expect(bot.allText(ORGANIZER)).toContain('Игроков: 2');
    bot.press(ORGANIZER, 'o:draw');
    expect(bot.state.draw!.bracket!.rounds).toEqual([]);
    expect(bot.state.withdrawn).toEqual(['3']);
  });

  it('после закрытия сбора выход необратим — второй шаг; кнопка прошлых версий значит то же', () => {
    const bot = new TestBot();
    for (const id of PLAYERS) bot.register(id);
    bot.open(ORGANIZER, 'intake');
    bot.press(ORGANIZER, 'o:closeIntake');
    bot.command('1', '/leave');
    expect(bot.lastText('1')).toContain('Сбор уже закрыт — вернуться будет нельзя.');
    bot.press('1', 'l:ok:intake');
    expect(bot.lastText('1')).toContain('Вернуться в турнир будет нельзя');
    expect(isSongsOnly(bot.state.intake, '1')).toBe(false);
    bot.press('1', 'l:final:intake');
    expect(isSongsOnly(bot.state.intake, '1')).toBe(true);

    // l:ok без этапа — из журнала прошлой версии: на сборе он выходил сразу.
    bot.send({ kind: 'button', from: sender('2'), data: 'l:ok' });
    expect(isSongsOnly(bot.state.intake, '2')).toBe(true);
  });

  it('этап сменился, пока игрок думал, — бот спрашивает заново', () => {
    const bot = new TestBot();
    for (const id of PLAYERS) bot.register(id);
    for (const id of PLAYERS) bot.submitSongs(id, 10);
    bot.processAudio();
    toDraw(bot);
    const matchId = nextMatch(bot)!;
    const [a] = matchPlayers(bot.state.draw!, matchId)!;
    bot.send({ kind: 'button', from: sender(a), data: 'l:ok:draw' });
    expect(bot.lastText(a)).toContain('Текущий матч засчитается сопернику');
    expect(bot.state.withdrawn).toEqual([]);
  });

  it('финалист выходит только через организатора', () => {
    const bot = readyForQualifiers();
    for (let id = nextMatch(bot); id; id = nextMatch(bot)) playQualifier(bot, id);
    bot.press(ORGANIZER, 'o:toFinal');
    const [finalist] = qualifiedIds(bot.state.draw!);
    bot.command(finalist!, '/leave');
    expect(bot.lastText(finalist!)).toContain('Ты в финале');
    expect(bot.buttons(finalist!).some((data) => data.startsWith('l:ok'))).toBe(false);
  });
});

describe('Настройки по ходу турнира', () => {
  const ADMIN = '950';
  const panelText = (bot: TestBot, id: UserId) => {
    const message = bot.chats[id]?.messages.find((m) => m.author === 'bot' && m.slot === 'o:phase');
    return message?.author === 'bot' ? message.text : '';
  };
  // Нажатие кнопки, которой уже не видно: из панели, открытой раньше.
  const press = (bot: TestBot, data: string) => bot.send({ kind: 'button', from: sender(ORGANIZER), data });

  it('организатор меняет настройку кнопками; списки песен участников правятся на месте', () => {
    const bot = new TestBot();
    for (const id of PLAYERS) bot.register(id);
    bot.submitSongs('1', 3);
    bot.processAudio();

    bot.open(ORGANIZER, 'settings');
    bot.press(ORGANIZER, 'o:set:songs');
    expect(panelText(bot, ORGANIZER)).toContain('Сейчас: до 10');
    bot.press(ORGANIZER, 'o:set:songs:5');
    expect(bot.toasts.at(-1)).toEqual({ to: ORGANIZER, text: '✅ Песен на игрока: до 5' });
    expect(bot.state.config.intakeRules.maxSubmissions).toBe(5);
    expect(bot.state.intake.config.rules.maxSubmissions).toBe(5);
    expect(bot.state.intake.intake.rules.maxSubmissions).toBe(5);
    expect(bot.allText('1')).toContain('принято 3 из 5');
    expect(panelText(bot, ORGANIZER)).toContain('🎵 Песен на игрока: до 5');
    expect(bot.state.journal.at(-1)).toBe('Организатор: песен на игрока до 10 → до 5');

    // Меньше, чем уже прислал кто-то, — нельзя: кнопка под замком и при нажатии объясняет.
    bot.press(ORGANIZER, 'o:set:songs');
    bot.press(ORGANIZER, 'o:set:songs:7');
    bot.submitSongs('2', 6);
    bot.processAudio();
    bot.press(ORGANIZER, 'o:set:songs');
    const panel = bot.chats[ORGANIZER]!.messages.find((m) => m.author === 'bot' && m.slot === 'o:phase');
    const labels = panel?.author === 'bot' ? panel.buttons?.flat().map((b) => b.label) : [];
    expect(labels).toEqual(['🔒 5', '✅ 7', '10', '12', '15', '⬅️ К настройкам']);
    bot.press(ORGANIZER, 'o:set:songs:5');
    expect(bot.toasts.at(-1)?.text).toBe('У кого-то уже 6 песен — меньше нельзя');
    expect(bot.state.config.intakeRules.maxSubmissions).toBe(7);
    expect(violations(bot.outLog)).toEqual([]);
  });

  it('вводное к сбору правится на месте: лимит песен, длина фрагмента, «только песни»', () => {
    const bot = new TestBot();
    bot.register('1');
    const welcome = () => bot.chats['1']!.messages.flatMap((m) => (m.author === 'bot' && m.slot === 'i:welcome' ? [m.text] : []));
    expect(welcome()).toHaveLength(1);
    expect(welcome()[0]).toContain('Пришли до 10 песен');
    expect(welcome()[0]).toContain('фрагмент до 60 секунд');

    bot.open(ORGANIZER, 'settings');
    bot.press(ORGANIZER, 'o:set:songs');
    bot.press(ORGANIZER, 'o:set:songs:15');
    bot.press(ORGANIZER, 'o:set:fragment');
    bot.press(ORGANIZER, 'o:set:fragment:30');
    bot.press('1', 'i:role:songs');
    expect(welcome()).toHaveLength(1);
    expect(welcome()[0]).toContain('Пришли до 15 песен');
    expect(welcome()[0]).toContain('фрагмент до 30 секунд');
    expect(welcome()[0]).toContain('🎁 Ты только присылаешь песни');
  });

  it('срок круга «без срока» выбирается до жеребьёвки и потом под замком', () => {
    const bot = new TestBot();
    bot.open(ORGANIZER, 'settings');
    bot.press(ORGANIZER, 'o:set:round');
    expect(panelText(bot, ORGANIZER)).toContain('«Без срока» — дат нет вовсе');
    bot.press(ORGANIZER, 'o:set:round:0');
    expect(bot.toasts.at(-1)).toEqual({ to: ORGANIZER, text: '✅ Срок круга: без срока' });
    expect(bot.state.journal.at(-1)).toBe('Организатор: срок круга 7 дней → без срока');

    readyForQualifiers(bot);
    expect(bot.state.draw!.deadlines).toEqual([]);
    bot.open(ORGANIZER, 'settings');
    expect(panelText(bot, ORGANIZER)).toContain('📅 Срок круга: без срока · 🔒 жеребьёвка уже началась');
  });

  it('отрыв в отборе: «любой» — значение 0, число треков и очки отрыв не теряют', () => {
    const bot = new TestBot();
    bot.open(ORGANIZER, 'settings');
    expect(panelText(bot, ORGANIZER)).toContain('🎤 Треков в матче отбора: 5\n📏 Отрыв в отборе: от 2,0\n🎯 Очки');
    bot.press(ORGANIZER, 'o:set:lead');
    expect(panelText(bot, ORGANIZER)).toContain('Сейчас: от 2,0');
    expect(panelText(bot, ORGANIZER)).toContain('«Любой» — прежнее правило: дополнительные треки только при ничьей.');
    const panel = bot.chats[ORGANIZER]!.messages.find((m) => m.author === 'bot' && m.slot === 'o:phase');
    const labels = panel?.author === 'bot' ? panel.buttons?.flat().map((b) => b.label) : [];
    expect(labels).toEqual(['любой', '1,0', '✅ 2,0', '3,0', '⬅️ К настройкам']);

    bot.press(ORGANIZER, 'o:set:lead:0');
    expect(bot.toasts.at(-1)).toEqual({ to: ORGANIZER, text: '✅ Отрыв в отборе: любой' });
    expect(bot.state.journal.at(-1)).toBe('Организатор: отрыв в отборе от 2,0 → любой');
    expect(bot.state.config.qualifierRuleset.format).toEqual({ kind: 'fixed', tracks: 5, minLead: 0 });
    expect(panelText(bot, ORGANIZER)).toContain('📏 Отрыв в отборе: любой');

    // Число треков и очки меняют формат отбора, не сбрасывая отрыв.
    for (const action of ['o:set:lead', 'o:set:lead:30', 'o:set:tracks', 'o:set:tracks:7', 'o:set:points', 'o:set:points:912']) {
      bot.press(ORGANIZER, action);
    }
    expect(bot.state.config.qualifierRuleset).toEqual({ artistPoints: 9, titlePoints: 12, format: { kind: 'fixed', tracks: 7, minLead: 30 } });
    expect(bot.state.config.finalRuleset.format).toEqual({ kind: 'first_to', winThreshold: 90, trackLimit: 20 });
    expect(violations(bot.outLog)).toEqual([]);
  });

  it('замок: сбор закрыт — лимит, фрагмент и пул; жеребьёвка — финалисты и срок; первый матч — треки, отрыв и очки', () => {
    const bot = readyForQualifiers();
    bot.open(ORGANIZER, 'settings');
    const text = panelText(bot, ORGANIZER);
    expect(text).toContain('🎵 Песен на игрока: до 10 · 🔒 сбор закрыт');
    expect(text).toContain('👥 Финалистов: 2 · 🔒 жеребьёвка уже началась');
    expect(text).toContain('📅 Срок круга: 7 дней · 🔒 сроки назначены — их двигают в «Сетке»');
    expect(bot.hasButton(ORGANIZER, 'o:set:songs')).toBe(false);
    expect(bot.hasButton(ORGANIZER, 'o:set:points')).toBe(true);
    // Замок проверяется при нажатии: кнопка из панели, открытой раньше, его не обойдёт.
    press(bot, 'o:set:finalists:4');
    expect(bot.toasts.at(-1)?.text).toBe('🔒 Финалистов: жеребьёвка уже началась');
    expect(bot.state.config.finalists).toBe(2);

    bot.press(ORGANIZER, 'o:set:points');
    bot.press(ORGANIZER, 'o:set:points:912');
    expect(bot.state.config.qualifierRuleset).toMatchObject({ artistPoints: 9, titlePoints: 12 });
    expect(bot.state.config.finalRuleset).toMatchObject({ artistPoints: 9, titlePoints: 12 });
    const matchId = nextMatch(bot)!;
    appointJudge(bot, matchId);
    expect(bot.state.matches[matchId]!.session.config.ruleset).toMatchObject({ artistPoints: 9, titlePoints: 12 });
    expect(panelText(bot, ORGANIZER)).toContain('🎯 Очки: исполнитель 0,9, название 1,2 · 🔒 матчи отбора уже начались');
    expect(panelText(bot, ORGANIZER)).toContain('📏 Отрыв в отборе: от 2,0 · 🔒 матчи отбора уже начались');
    expect(bot.hasButton(ORGANIZER, 'o:set:tracks')).toBe(false);
    expect(bot.hasButton(ORGANIZER, 'o:set:lead')).toBe(false);
    // Кнопка из панели, открытой до первого матча: открытый матч играет с тем отрывом, что был.
    press(bot, 'o:set:lead:0');
    expect(bot.toasts.at(-1)?.text).toBe('🔒 Отрыв в отборе: матчи отбора уже начались');
    expect(bot.state.matches[matchId]!.session.match.ruleset.format).toEqual({ kind: 'fixed', tracks: 5, minLead: 20 });
    expect(bot.hasButton(ORGANIZER, 'o:set:finalTo')).toBe(true);
  });

  it('длина фрагмента: нарезанные песни нарезаются заново, результат со старой длиной не засчитывается', () => {
    const bot = new TestBot();
    bot.register('1');
    bot.submitSongs('1', 2);
    bot.processAudio();
    expect(bot.state.intake.intake.submissions.every((s) => s.processing === 'ok')).toBe(true);

    bot.open(ORGANIZER, 'settings');
    bot.press(ORGANIZER, 'o:set:fragment');
    bot.press(ORGANIZER, 'o:set:fragment:30');
    expect(bot.state.intake.config.fragmentSec).toBe(30);
    expect(bot.state.intake.intake.submissions.every((s) => s.processing === 'pending')).toBe(true);

    bot.send({ kind: 'worker', results: [{ submissionId: 's1', ok: true, startSec: 0, fragmentSec: 60, gameFileId: 'old' }] });
    expect(bot.state.intake.intake.submissions[0]!.processing).toBe('pending');
    bot.send({ kind: 'worker', results: [{ submissionId: 's1', ok: true, startSec: 0, fragmentSec: 30, gameFileId: 'new' }] });
    expect(bot.state.intake.intake.submissions[0]).toMatchObject({ processing: 'ok', gameFileId: 'new' });
  });

  it('админ видит настройки, но не меняет; название из панели — текстом', () => {
    const bot = new TestBot(testConfig({ adminIds: [ADMIN] }));
    bot.command(ADMIN, '/panel');
    bot.open(ADMIN, 'settings');
    expect(panelText(bot, ADMIN)).toContain('Менять настройки может организатор.');
    expect(bot.buttons(ADMIN).some((data) => data.startsWith('o:set:'))).toBe(false);
    bot.send({ kind: 'button', from: sender(ADMIN), data: 'o:set:songs:5' });
    expect(bot.toasts.at(-1)).toEqual({ to: ADMIN, text: 'Менять настройки может только организатор' });
    bot.send({ kind: 'button', from: sender(ADMIN), data: 'o:v:rename' });
    expect(bot.toasts.at(-1)?.text).toBe('Переименовать турнир может только организатор');

    bot.open(ORGANIZER, 'settings');
    bot.press(ORGANIZER, 'o:v:rename');
    expect(panelText(bot, ORGANIZER)).toContain('Пришлите новое название сообщением');
    bot.text(ORGANIZER, 'а');
    expect(bot.lastText(ORGANIZER)).toContain('от 2 до 48 символов');
    const out = bot.text(ORGANIZER, 'Весенний кубок');
    expect(bot.state.config.title).toBe('Весенний кубок');
    expect(out).toContainEqual(expect.objectContaining({ to: ORGANIZER, slot: 'o:phase', bump: true }));
    expect(bot.lastText(ORGANIZER)).toContain('⚙️ Настройки · Весенний кубок');
    // Новые участники видят очки из настроек, а не зашитые в текст правил.
    bot.press(ORGANIZER, 'o:set:points');
    bot.press(ORGANIZER, 'o:set:points:912');
    bot.command('1', '/start t_test');
    bot.press('1', 'r:name');
    expect(bot.lastText('1')).toContain('Исполнитель — 0,9 балла, название — 1,2.');
  });
});

describe('Отрыв в отборе', () => {
  // Основная часть матча со счётом 1,0 : 0,0: на первом треке исполнителя угадал первый игрок,
  // остальные четыре трека не угадал никто.
  function playLeadOfOne(bot: TestBot, matchId: string): { judge: UserId; players: [UserId, UserId] } {
    const judge = appointJudge(bot, matchId);
    const players = matchPlayers(bot.state.draw!, matchId)!;
    const prefix = `m:${matchId}:`;
    bot.press(judge, `${prefix}ready`);
    bot.press(players[0], `${prefix}ready`);
    bot.press(players[1], `${prefix}ready`);
    bot.press(judge, `${prefix}issue`);
    bot.press(judge, `${prefix}start`);
    bot.press(judge, `${prefix}aw:a:0`);
    bot.press(judge, `${prefix}close`);
    for (let i = 0; i < 4; i++) {
      bot.press(judge, `${prefix}issue`);
      bot.press(judge, `${prefix}start`);
      bot.press(judge, `${prefix}none`);
    }
    return { judge, players };
  }

  it('отрыв 2,0: 1,0 : 0,0 после пяти треков — матч идёт дальше, судья видит почему', () => {
    const bot = readyForQualifiers();
    const matchId = nextMatch(bot)!;
    const { judge } = playLeadOfOne(bot, matchId);
    const { match } = bot.state.matches[matchId]!.session;
    expect(match.closedTracks).toHaveLength(5);
    expect(match.phase.kind).toBe('between_tracks');
    expect(bot.allText(judge)).toContain('Отрыв меньше 2,0 — дополнительный трек 1');
    expect(bot.hasButton(judge, `m:${matchId}:issue`)).toBe(true);
  });

  it('турнир прошлой версии без поля отрыва: тот же счёт решает матч, повтор журнала даёт тот же итог', () => {
    const config = testConfig({ qualifierRuleset: { ...QUALIFIER_RULESET, format: { kind: 'fixed', tracks: 5 } } });
    const bot = readyForQualifiers(new TestBot(config));
    const matchId = nextMatch(bot)!;
    const { judge, players } = playLeadOfOne(bot, matchId);
    expect(bot.state.matches[matchId]!.session.match.phase).toMatchObject({ kind: 'decided', winner: 0 });
    expect(bot.allText(judge)).not.toContain('Отрыв');
    confirmAll(bot, `m:${matchId}:`, judge, players);
    expect(bot.state.draw!.results[matchId]).toBe(players[0]);

    let replayed = createBot(config, Date.parse('2026-10-10T10:00:00Z')).state;
    for (const event of bot.events) replayed = handleBotEvent(replayed, event).state;
    expect(replayed).toEqual(bot.bot);
  });
});

describe('Стиль текстов (/style)', () => {
  const slotText = (bot: TestBot, id: UserId, slot: string) => {
    const message = bot.chats[id]?.messages.find((m) => m.author === 'bot' && m.slot === slot);
    return message?.author === 'bot' ? message.text : '';
  };

  it('участник выбирает стиль; его список песен перерисовывается, у остальных всё как было', () => {
    const bot = new TestBot();
    bot.register('1');
    bot.register('2');
    bot.submitSongs('1', 3);
    bot.processAudio();
    const otherList = slotText(bot, '2', 'i:list');

    bot.command('1', '/style');
    expect(bot.hasButton('1', 's:set:rude')).toBe(true);
    bot.press('1', 's:set:rude');
    bot.press('1', 's:ok:rude');
    expect(bot.state.people['1']!.style).toBe('rude');
    expect(bot.state.intake.config.styles).toEqual({ '1': 'rude' });
    expect(slotText(bot, '1', 's:style')).toContain(textsFor('rude', '1').commands.style.chosen({ name: '🤬 Ругательный' }));
    expect(bot.hasButton('1', 's:set:base')).toBe(true);
    expect(slotText(bot, '1', 'i:list')).toContain(textsFor('rude', '1').intake.list.progress({ accepted: 3, max: 10 }));
    expect(slotText(bot, '2', 'i:list')).toBe(otherList);

    bot.press('1', 's:set:rude');
    expect(bot.toasts.at(-1)).toEqual({ to: '1', text: textsFor('rude', '1').commands.style.same });
    expect(violations(bot.outLog)).toEqual([]);
  });

  it('по умолчанию — обычный стиль; ругательный включается только после предупреждения, обратно — сразу', () => {
    const bot = new TestBot();
    bot.register('1');
    expect(bot.state.people['1']!.style).toBeUndefined();
    bot.command('1', '/style');
    const texts = textsFor(undefined, '1').commands.style;
    expect(slotText(bot, '1', 's:style')).toContain(texts.current({ name: '🙂 Обычный' }));

    bot.press('1', 's:set:rude');
    expect(bot.state.people['1']!.style).toBeUndefined();
    expect(slotText(bot, '1', 's:style')).toContain(styleOf('rude').warning!);
    expect(bot.hasButton('1', 's:ok:rude')).toBe(true);
    bot.press('1', 's:back');
    expect(bot.state.people['1']!.style).toBeUndefined();
    expect(bot.hasButton('1', 's:set:rude')).toBe(true);

    bot.press('1', 's:set:rude');
    bot.press('1', 's:ok:rude');
    expect(bot.state.people['1']!.style).toBe('rude');
    bot.press('1', 's:set:base');
    expect(bot.state.people['1']!.style).toBe('base');
    expect(violations(bot.outLog)).toEqual([]);
  });

  it('мат в примерах запикан, пока человек не включил ругательный стиль', () => {
    const bot = new TestBot();
    const mat = /ху[йеёяил]|пизд|бля|[её]ба|ёб/i;
    bot.register('1');
    bot.command('1', '/style');
    expect(slotText(bot, '1', 's:style')).toContain(styleOf('rude').sampleBleeped!);
    expect(slotText(bot, '1', 's:style')).not.toMatch(mat);
    bot.press('1', 's:set:rude');
    expect(slotText(bot, '1', 's:style')).not.toMatch(mat);

    bot.press('1', 's:ok:rude');
    expect(slotText(bot, '1', 's:style')).toContain(styleOf('rude').sample);
  });

  // Каждый стиль проходит турнир от регистрации до архива: все участники в нём, команды и выход тоже.
  it.each(STYLE_IDS)('турнир целиком в стиле %s: без нарушений лимитов Telegram и без undefined', (style) => {
    const bot = new TestBot();
    const choose = (id: UserId) => {
      bot.command(id, '/style');
      if (style === 'base') return;
      bot.press(id, `s:set:${style}`);
      if (styleOf(style).warning) bot.press(id, `s:ok:${style}`);
    };
    for (const id of PLAYERS) bot.register(id);
    for (const id of PLAYERS) choose(id);
    for (const id of PLAYERS) bot.submitSongs(id, 10);
    bot.processAudio();
    for (const command of ['/status', '/matches', '/help', '/nope', '/name Первый', '/leave']) bot.command('1', command);
    bot.press('1', 'l:cancel');
    toDraw(bot);
    bot.command('1', '/status');
    let guard = 0;
    for (let id = nextMatch(bot); id; id = nextMatch(bot)) {
      playQualifier(bot, id);
      if (++guard > 10) throw new Error('отбор не сходится');
    }
    bot.press(ORGANIZER, 'o:toFinal');
    bot.register(FINAL_JUDGE, 'fjudge_test');
    choose(FINAL_JUDGE);
    bot.press(ORGANIZER, 'o:openFinal');
    bot.open(ORGANIZER, 'final');
    bot.press(ORGANIZER, 'o:start:f1-1');
    const finalists = bot.state.final!.config.finalists.map((p) => p.id) as [UserId, UserId];
    playToDecision(bot, 'f:', FINAL_JUDGE, finalists, 4);
    confirmAll(bot, 'f:', FINAL_JUDGE, finalists);
    bot.open(ORGANIZER, 'home');
    bot.press(ORGANIZER, 'o:archive');
    expect(bot.state.phase).toBe('archive');

    const texts = bot.outLog.flatMap((o) => (o.kind === 'message' ? [o.text, ...(o.buttons ?? []).flat().map((b) => b.label)] : [o.text]));
    expect(texts.filter((text) => /undefined|\[object|NaN/.test(text))).toEqual([]);
    expect(violations(bot.outLog)).toEqual([]);
    if (style !== 'base') expect(bot.allText('1')).toContain(textsFor(style, '1').commands.style.chosen({ name: styleOf(style).name }));
  });

  it('стиль доходит до пар и матчей; до регистрации стиль не выбрать', () => {
    const bot = new TestBot();
    bot.command('99', '/style');
    expect(bot.lastText('99')).toBe(textsFor(undefined, '99').commands.style.stranger);

    readyForQualifiers(bot);
    bot.command('1', '/style');
    bot.press('1', 's:set:rude');
    bot.press('1', 's:ok:rude');
    expect(bot.state.draw!.config.styles).toEqual({ '1': 'rude' });
    let guard = 0;
    for (let id = nextMatch(bot); id; id = nextMatch(bot)) {
      playQualifier(bot, id);
      expect(bot.state.matches[id]!.session.config.styles).toEqual({ '1': 'rude' });
      if (++guard > 10) throw new Error('отбор не сходится');
    }
    expect(violations(bot.outLog)).toEqual([]);
  });
});

describe('Смена имени (/name)', () => {
  const slotText = (bot: TestBot, id: UserId, slot: string) => {
    const message = bot.chats[id]?.messages.find((m) => m.author === 'bot' && m.slot === slot);
    return message?.author === 'bot' ? message.text : '';
  };
  const texts = textsFor(undefined, '1').commands.name;

  it('«/name Имя» — сразу: имя в карточке человека, в сборе и в журнале; приветствие правится на месте', () => {
    const bot = new TestBot();
    bot.register('1');
    expect(slotText(bot, '1', 'i:welcome')).toContain('Игрок 1');

    bot.command('1', '/name   Аня   К.');
    expect(bot.state.people['1']!.name).toBe('Аня К.');
    expect(bot.state.intake.config.participants.find((p) => p.id === '1')!.name).toBe('Аня К.');
    expect(slotText(bot, '1', 'n:name')).toBe(texts.done({ name: 'Аня К.' }));
    expect(slotText(bot, '1', 'i:welcome')).toContain('Аня К.');
    expect(bot.state.journal.at(-1)).toBe('Новое имя: №1 Игрок 1 → Аня К.');

    bot.command('1', '/name Аня К.');
    expect(slotText(bot, '1', 'n:name')).toBe(texts.same({ name: 'Аня К.' }));
    expect(violations(bot.outLog)).toEqual([]);
  });

  it('«/name» из меню: бот ждёт имя сообщением, неподходящее просит прислать ещё раз, «Оставить как есть» — отмена', () => {
    const bot = new TestBot();
    bot.register('1');
    bot.command('1', '/name');
    expect(slotText(bot, '1', 'n:name')).toBe(texts.ask({ name: 'Игрок 1' }));
    expect(bot.hasButton('1', 'n:keep')).toBe(true);

    bot.text('1', 'А');
    expect(bot.lastText('1')).toBe(textsFor(undefined, '1').registration.badName);
    bot.text('1', 'Борис');
    expect(bot.state.people['1']!.name).toBe('Борис');
    expect(bot.state.renaming).toEqual([]);
    expect(bot.hasButton('1', 'n:keep')).toBe(false);

    bot.command('1', '/name');
    bot.press('1', 'n:keep');
    expect(slotText(bot, '1', 'n:name')).toBe(texts.kept);
    bot.text('1', 'Вера');
    expect(bot.state.people['1']!.name).toBe('Борис');
  });

  it('занялся другим — имя больше не ждём: следующее сообщение не станет именем', () => {
    const bot = new TestBot();
    bot.register('1');
    bot.command('1', '/name');
    bot.command('1', '/status');
    bot.text('1', 'Сплин — Выхода нет');
    expect(bot.state.people['1']!.name).toBe('Игрок 1');
  });

  it('на отборе новое имя видят соперник в карточке пары и судья в панели матча', () => {
    const bot = readyForQualifiers();
    const matchId = nextMatch(bot)!;
    const [a, b] = matchPlayers(bot.state.draw!, matchId)!;
    const judge = appointJudge(bot, matchId);
    expect(slotText(bot, b, 'd:card')).toContain(`Игрок ${a}`);

    bot.command(a, '/name Новое Имя');
    expect(slotText(bot, b, 'd:card')).toContain('Новое Имя');
    expect(slotText(bot, b, 'd:card')).not.toContain(`Игрок ${a}`);
    expect(bot.state.matches[matchId]!.session.config.players.map((p) => p.name)).toContain('Новое Имя');
    expect(bot.allText(judge)).toContain('Новое Имя');

    playToDecision(bot, `m:${matchId}:`, judge, [a, b]);
    confirmAll(bot, `m:${matchId}:`, judge, [a, b]);
    expect(bot.state.matches[matchId]!.closed).toBe(true);
    expect(violations(bot.outLog)).toEqual([]);
  });

  it('до регистрации имя не сменить', () => {
    const bot = new TestBot();
    bot.command('99', '/name Кто-то');
    expect(bot.lastText('99')).toBe(texts.stranger);
  });
});

describe('Удалённая переписка и повторный «Старт»', () => {
  const slots = (bot: TestBot, id: UserId) => bot.chats[id]!.messages.flatMap((m) => (m.author === 'bot' && m.slot ? [m.slot] : []));
  const wipe = (bot: TestBot, id: UserId) => {
    bot.chats[id] = { messages: [], toasts: [] };
  };

  it('на сборе: вводное и список песен приходят заново, под «Ты в турнире»', () => {
    const bot = new TestBot();
    bot.register('1');
    bot.submitSongs('1', 3);
    bot.processAudio();
    wipe(bot, '1');

    bot.command('1', '/start');
    const messages = bot.chats['1']!.messages.filter((m) => m.author === 'bot');
    expect(messages[0]!.text).toContain(textsFor(undefined, '1').registration.already({ number: 1, name: 'Игрок 1' }));
    expect(slots(bot, '1')).toEqual(['i:welcome', 'i:list']);
    expect(bot.hasButton('1', 'i:pick:edit')).toBe(true);

    // Без удаления «Старт» не плодит копии: сообщения переезжают вниз.
    bot.command('1', '/start');
    expect(slots(bot, '1')).toEqual(['i:welcome', 'i:list']);
    expect(violations(bot.outLog)).toEqual([]);
  });

  it('на отборе: карточка пары и панель матча — заново; вводное к закрытому сбору — нет', () => {
    const bot = readyForQualifiers();
    const matchId = nextMatch(bot)!;
    const [a, b] = matchPlayers(bot.state.draw!, matchId)!;
    const judge = appointJudge(bot, matchId);
    wipe(bot, a);
    wipe(bot, judge);

    bot.command(a, '/start');
    bot.command(judge, '/start');
    expect(slots(bot, a)).not.toContain('i:welcome');
    expect(slots(bot, a)).toEqual(expect.arrayContaining(['i:list', 'd:card']));
    expect(bot.hasButton(a, `m:${matchId}:ready`)).toBe(true);
    expect(bot.hasButton(judge, `m:${matchId}:ready`)).toBe(true);

    playToDecision(bot, `m:${matchId}:`, judge, [a, b]);
    confirmAll(bot, `m:${matchId}:`, judge, [a, b]);
    expect(bot.state.matches[matchId]!.closed).toBe(true);
    expect(violations(bot.outLog)).toEqual([]);
  });
});
