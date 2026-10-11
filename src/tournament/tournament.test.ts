import { describe, expect, it } from 'vitest';
import { matchPlayers } from '../bot/drawSession.ts';
import type { UserId } from '../bot/protocol.ts';
import { openMatches, resolveSlot } from '../domain/bracket/bracket.ts';
import { formatClock } from '../shared/text.ts';
import { ORGANIZER, sender, TestBot, violations } from './testBot.ts';

const PLAYERS = ['1', '2', '3', '4', '5'];
const GUEST = '6';
const FINAL_JUDGE = '7';

// Регистрация, полный сбор, жеребьёвка: 5 игроков, 2 финалиста → 3 матча отбора.
function readyForQualifiers(bot = new TestBot()): TestBot {
  for (const id of PLAYERS) bot.register(id);
  for (const id of PLAYERS) bot.submitSongs(id, 10);
  bot.processAudio();
  bot.press(ORGANIZER, 'o:closeIntake');
  bot.press(ORGANIZER, 'o:toDraw');
  bot.press(ORGANIZER, 'o:draw');
  return bot;
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
    bot.press(ORGANIZER, 'o:start:f1-1');

    const finalists = bot.state.final!.config.finalists.map((p) => p.id) as [UserId, UserId];
    playToDecision(bot, 'f:', FINAL_JUDGE, finalists);
    confirmAll(bot, 'f:', FINAL_JUDGE, finalists);
    expect(bot.state.final!.results['f1-1']).toBe(finalists[0]);

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
    bot.press(ORGANIZER, 'o:closeIntake');
    bot.press(ORGANIZER, 'o:toDraw');
    bot.press(ORGANIZER, 'o:draw');

    const matchId = nextMatch(bot)!;
    const judge = appointJudge(bot, matchId);
    playToDecision(bot, `m:${matchId}:`, judge, matchPlayers(bot.state.draw!, matchId)!, 1);
    const audio = bot.outLog.find((o) => o.kind === 'message' && o.to === judge && o.audio);
    expect(audio).toMatchObject({ text: 'Включите с 0:30', audio: { title: 'Трек 1', fileId: undefined } });
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
    expect(bot.allText(GUEST)).toContain('сыграть не получится');
    expect(bot.state.draw!.config.registered.some((p) => p.id === GUEST)).toBe(true);
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
    bot.press(ORGANIZER, `o:replay:${matchId}`);
    const replay = bot.state.matches[matchId]!;
    expect(replay.attempt).toBe(1);
    expect(replay.closed).toBe(false);

    playToDecision(bot, `m:${matchId}:`, judge, players);
    const second = bot.state.matches[matchId]!.session.issued.map((t) => t.songId);
    expect(second.filter((id) => first.includes(id))).toEqual([]);
    confirmAll(bot, `m:${matchId}:`, judge, players);
    expect(bot.state.draw!.results[matchId]).toBe(players[0]);
  });

  it('организатор оставляет результат при споре', () => {
    const { bot, matchId, players } = decided();
    bot.press(players[1], `x:dispute:${matchId}`);
    bot.press(ORGANIZER, `o:keep:${matchId}`);
    expect(bot.state.draw!.results[matchId]).toBe(players[0]);
    expect(bot.state.matches[matchId]!.closed).toBe(true);
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
    expect(bot.lastText(b)).toContain('закрыт организатором');
  });

  it('/tech не доступна участнику', () => {
    const bot = readyForQualifiers();
    bot.command('1', '/tech 1.1 1 так');
    expect(Object.keys(bot.state.draw!.results)).toEqual([]);
  });
});

describe('Инструменты организатора', () => {
  it('техническая победа кнопками: матч → кому → подтверждение', () => {
    const bot = readyForQualifiers();
    const matchId = nextMatch(bot)!;
    const [a, b] = matchPlayers(bot.state.draw!, matchId)!;
    bot.press(ORGANIZER, 'o:menu:tech');
    bot.press(ORGANIZER, `o:techMatch:${matchId}`);
    bot.press(ORGANIZER, `o:techWin:${matchId}:${b}`);
    expect(bot.allText(ORGANIZER)).toContain('Засчитать техническую победу');
    expect(bot.state.draw!.results[matchId]).toBeUndefined();

    bot.press(ORGANIZER, 'o:techOk');
    expect(bot.state.draw!.results[matchId]).toBe(b);
    expect(bot.state.adminMenu).toBeNull();
    expect(bot.allText(a)).toContain('технический результат: решение организатора');
    expect(violations(bot.outLog)).toEqual([]);
  });

  it('отмена закрывает меню, ничего не меняя', () => {
    const bot = readyForQualifiers();
    bot.press(ORGANIZER, 'o:menu:withdraw');
    expect(bot.hasButton(ORGANIZER, 'o:menu:close')).toBe(true);
    bot.press(ORGANIZER, 'o:menu:close');
    expect(bot.state.adminMenu).toBeNull();
    expect(bot.state.withdrawn).toEqual([]);
    expect(bot.hasButton(ORGANIZER, 'o:menu:tech')).toBe(true);
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
    bot.press(ORGANIZER, 'o:menu:withdraw');
    bot.press(ORGANIZER, `o:withdrawPick:${waiting}`);
    bot.press(ORGANIZER, 'o:withdrawOk');
    expect(bot.state.withdrawn).toEqual([waiting]);
    expect(bot.lastText(waiting)).toContain('снял тебя с турнира');
    expect(bot.state.draw!.results[second.id]).toBeUndefined();

    // Снятие игрока текущего матча закрывает его в пользу соперника, а следующая пара —
    // с заранее снятым — закрывается сама.
    bot.press(ORGANIZER, 'o:menu:withdraw');
    expect(bot.hasButton(ORGANIZER, `o:withdrawPick:${waiting}`)).toBe(false);
    bot.press(ORGANIZER, `o:withdrawPick:${a}`);
    bot.press(ORGANIZER, 'o:withdrawOk');
    expect(bot.state.draw!.results[first.id]).toBe(b);
    expect(bot.state.draw!.results[second.id]).toBe(b);
    expect(bot.allText(b)).toContain('соперник снят с турнира');
    expect(bot.state.draw!.bracket!.rounds.at(-1)!.some((m) => bot.state.draw!.results[m.id] === b)).toBe(true);
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
    expect(ready.lastText('1')).toMatch(/Сейчас играют:\n🎤 №\d\.\d: .+ 2,1 : 0,0 .+ · судья /);

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
    expect(bot.lastText(players[1])).toContain('Подтвердите результат');
    bot.press(ORGANIZER, `o:keep:${matchId}`);
    expect(bot.state.draw!.results[matchId]).toBe(players[0]);
  });

  it('срок круга: напоминание накануне и сообщение организатору после', () => {
    const bot = readyForQualifiers();
    const matchId = nextMatch(bot)!;
    const [a] = matchPlayers(bot.state.draw!, matchId)!;
    const deadline = Date.parse(`${bot.state.draw!.deadlines[0]}T21:00:00Z`);

    bot.send({ kind: 'tick' }, deadline - 12 * 3600_000 - bot.now);
    expect(bot.lastText(a)).toContain('последний день');
    bot.send({ kind: 'tick' }, 13 * 3600_000);
    expect(bot.lastText(ORGANIZER)).toContain('Срок 1-го круга истёк');
  });
});
