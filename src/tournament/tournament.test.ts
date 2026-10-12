import { describe, expect, it } from 'vitest';
import { matchPlayers, qualifiedIds } from '../bot/drawSession.ts';
import { admittedPlayers, isSongsOnly, readyForDraw } from '../bot/intakeSession.ts';
import type { UserId } from '../bot/protocol.ts';
import { openMatches, resolveSlot } from '../domain/bracket/bracket.ts';
import { acceptedSongs } from '../domain/submission/intake.ts';
import { formatClock } from '../shared/text.ts';
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

    const finalists = bot.state.final!.config.finalists.map((p) => p.id) as [UserId, UserId];
    playToDecision(bot, 'f:', FINAL_JUDGE, finalists);
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
    bot.press(ORGANIZER, `o:open:${matchId}`);
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
    expect(bot.lastText(b)).toContain('закрыт организатором');
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

    bot.press(ORGANIZER, 'o:techOk');
    expect(bot.state.draw!.results[matchId]).toBe(b);
    expect(bot.state.adminMenu).toBeNull();
    expect(bot.allText(a)).toContain('технический результат: решение организатора');
    expect(violations(bot.outLog)).toEqual([]);
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
    bot.press(ORGANIZER, 'o:withdrawOk');
    expect(bot.state.withdrawn).toEqual([waiting]);
    expect(bot.lastText(waiting)).toContain('снял тебя с турнира');
    expect(bot.state.draw!.results[second.id]).toBeUndefined();

    // Снятие игрока текущего матча закрывает его в пользу соперника, а следующая пара —
    // с заранее снятым — закрывается сама.
    expect(bot.hasButton(ORGANIZER, `o:withdrawPick:${waiting}`)).toBe(false);
    bot.open(ORGANIZER, 'players');
    bot.press(ORGANIZER, `o:p:${a}`);
    bot.press(ORGANIZER, `o:withdrawPick:${a}`);
    bot.press(ORGANIZER, 'o:withdrawOk');
    expect(bot.state.draw!.results[first.id]).toBe(b);
    expect(bot.state.draw!.results[second.id]).toBe(b);
    expect(bot.allText(b)).toContain('соперник снят с турнира');
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

    expect(status(bot, a)).toMatch(new RegExp(`🎤 Твой матч №1\\.\\d, соперник — ${name(b)}, до \\d+ \\S+: нужно выбрать судью`));
    expect(status(bot, waiting)).toContain(`⏳ Твой следующий матч №2.`);
    expect(status(bot, waiting)).toContain(`соперник определится в №1.`);

    const judge = appointJudge(bot, first.id);
    expect(status(bot, a)).toContain(`ждём «Все на месте», судья ${name(judge)}`);
    expect(status(bot, judge)).toMatch(/⚖️ Судишь №1\.\d: .+: ждём «Все на месте»$/m);
    expect(status(bot, ORGANIZER)).toContain('Ты организатор турнира.');
    playToDecision(bot, `m:${first.id}:`, judge, [a, b], 1);
    expect(status(bot, b)).toMatch(/идёт, .+ 2,1 : 0,0 .+, судья /);
    expect(status(bot, ORGANIZER)).toMatch(/🎤 Матчи: сыграно 0 из 3 · идут 1 · без судьи \d/);
    expect(status(bot, ORGANIZER)).toContain('Организатору: /panel');

    bot.open(ORGANIZER, 'matches');
    bot.press(ORGANIZER, `o:m:${first.id}`);
    bot.press(ORGANIZER, `o:techMatch:${first.id}`);
    bot.press(ORGANIZER, `o:techWin:${first.id}:${a}`);
    bot.press(ORGANIZER, 'o:techOk');
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
    expect(bot.allText(ORGANIZER)).toContain('не подтверждён 10 минут');
    bot.press(ORGANIZER, `o:open:${matchId}`);
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
    expect(bot.buttons(ORGANIZER)).toEqual(['o:v:intake', 'o:v:players', 'o:v:settings']);

    bot.open(ORGANIZER, 'players');
    expect(panelText(bot, ORGANIZER)).toContain('№1 Игрок 1 @user1 · песен: 0 из 10');
    bot.open(ORGANIZER, 'intake');
    expect(panelText(bot, ORGANIZER)).toContain('Сбор треков');
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
    expect(bot.lastText(ADMIN)).toContain('Финалистов: 2');
    expect(bot.lastText(ADMIN)).toContain('Отбор: 5 треков; исполнитель 0,9, название 1,2');
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
    expect(bot.lastText(ORGANIZER)).toContain('⚠️ Спор. Оспорил:');
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
    expect(bot.lastText(GUEST)).toContain('🎁 Твои песни в игре, сам ты не играешь.');
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
    bot.press('1', 'l:ok');
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
    expect(bot.hasButton(a, 'l:ok')).toBe(false);

    bot.command(a, '/leave');
    bot.press(a, 'l:ok');
    bot.press(a, 'l:cancel');
    expect(bot.state.withdrawn).toEqual([]);
    expect(bot.hasButton(a, 'l:final')).toBe(false);
  });

  it('на отборе: текущий матч — сопернику, следующие — техническое поражение; судить можно', () => {
    const bot = readyForQualifiers(new TestBot(testConfig({ adminIds: [ADMIN] })));
    const matchId = nextMatch(bot)!;
    const [a, b] = matchPlayers(bot.state.draw!, matchId)!;
    bot.command(a, '/leave');
    expect(bot.lastText(a)).toContain('Текущий матч засчитается сопернику');
    bot.press(a, 'l:ok');
    // Выход необратим — второй шаг, и до него ничего не меняется.
    expect(bot.lastText(a)).toContain('Вернуться в турнир будет нельзя');
    expect(bot.state.withdrawn).toEqual([]);
    bot.press(a, 'l:final');

    expect(bot.state.withdrawn).toEqual([a]);
    expect(bot.state.left).toEqual([a]);
    expect(bot.state.draw!.results[matchId]).toBe(b);
    expect(bot.allText(b)).toContain('закрыт: технический результат: соперник вышел из турнира');
    expect(bot.allText(a)).toContain('Ты вышел из турнира. Спасибо за игру!');
    expect(bot.lastText(ADMIN)).toContain('вышел из турнира сам');
    expect(bot.state.draw!.config.registered.some((p) => p.id === a)).toBe(true);

    bot.command(a, '/status');
    expect(bot.lastText(a)).toContain('🚪 Ты вышел из турнира.');
    bot.command(a, '/leave');
    expect(bot.lastText(a)).toContain('Ты уже не в турнире.');
    bot.open(ORGANIZER, 'players');
    expect(bot.allText(ORGANIZER)).toContain('🚪 вышел сам');
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
    bot.press('5', 'l:ok');
    bot.press('5', 'l:final');
    bot.open(ORGANIZER, 'bracket');
    bot.press(ORGANIZER, 'o:draw');
    expect(bot.state.draw!.config.players.map((p) => p.id)).toEqual(['1', '2', '3', '4']);
    expect(bot.state.withdrawn).toEqual([]);
  });

  it('финалист выходит только через организатора', () => {
    const bot = readyForQualifiers();
    for (let id = nextMatch(bot); id; id = nextMatch(bot)) playQualifier(bot, id);
    bot.press(ORGANIZER, 'o:toFinal');
    const [finalist] = qualifiedIds(bot.state.draw!);
    bot.command(finalist!, '/leave');
    expect(bot.lastText(finalist!)).toContain('Ты в финале');
    expect(bot.hasButton(finalist!, 'l:ok')).toBe(false);
  });
});
