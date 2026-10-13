import { matchPlayers } from '../bot/drawSession.ts';
import type { Outgoing, UserId } from '../bot/protocol.ts';
import { openMatches } from '../domain/bracket/bracket.ts';
import type { AudioFile } from '../domain/submission/intake.ts';
import { ORGANIZER, TestBot, testConfig } from '../tournament/testBot.ts';

// Вкладка «Роли»: один турнир глазами разных ролей. Экраны рисует настоящий бот (ядро из
// src/tournament, как в тестах), сценарий — нажатия настоящих кнопок. Моменты — точки сценария:
// стенд проигрывает его до нужного момента, дальше кнопки в колонках живые.

const ADMIN = '950';
const SONGS_ONLY = '6';
const FINAL_JUDGE = '7';
const PLAYERS = ['1', '2', '3', '4', '5'];

export const ROLE_PEOPLE: Record<UserId, { name: string; username: string }> = {
  '1': { name: 'Аня', username: 'anya_m' },
  '2': { name: 'Борис', username: 'boris_k' },
  '3': { name: 'Вера', username: 'vera_v' },
  '4': { name: 'Глеб', username: 'gleb_o' },
  '5': { name: 'Даша', username: 'dasha_n' },
  [SONGS_ONLY]: { name: 'Яна', username: 'yana_songs' },
  [FINAL_JUDGE]: { name: 'Марина', username: 'marina_dj' },
  [ORGANIZER]: { name: 'Ира', username: 'ira_org' },
  [ADMIN]: { name: 'Костя', username: 'kostya_adm' },
};

export type MomentId = 'intake' | 'qualifiers' | 'final' | 'archive';

export interface RoleColumn {
  role: string;
  userId: UserId;
  note: string;
}

export interface RolesMoment {
  id: MomentId;
  title: string;
  description: string;
}

export const MOMENTS: RolesMoment[] = [
  {
    id: 'intake',
    title: 'Сбор',
    description:
      'Пятеро зарегистрировались по ссылке-приглашению и прислали по 10 песен. Яна выбрала «🎁 Только пришлю песни»: её песни идут в пулы, в жеребьёвку она не попадёт. У организатора открыт раздел «🎵 Сбор», у админа — своя панель.',
  },
  {
    id: 'qualifiers',
    title: 'Отбор',
    description:
      'Жеребьёвка прошла, идёт первый матч, третий трек. Судит Яна — она только прислала песни, поэтому свободна. Судья видит ответы, игроки — только счёт. Админ смотрит раздел «🎤 Матчи».',
  },
  {
    id: 'final',
    title: 'Финал',
    description:
      'Отбор сыгран, финал на сцене. Судит Марина — не участник турнира, она пришла по ссылке судьи финала. Организатор ведёт финал в разделе «🏆 Финал», выбывший видит итог своего матча.',
  },
  {
    id: 'archive',
    title: 'Итоги',
    description: 'Финал сыгран, организатор завершил турнир: итоги у него в панели, поздравление — у всех участников.',
  },
];

export interface RolesRun {
  bot: TestBot;
  moment: RolesMoment;
  columns: RoleColumn[];
  // Ответ бота на последнее действие — для toast в колонке.
  lastOut: Outgoing[];
  pressed?: { from: UserId; data: string };
}

export function roleSender(id: UserId) {
  const person = ROLE_PEOPLE[id];
  return { id, name: person?.name ?? `Гость ${id}`, username: person?.username };
}

// Нажатие в колонке: от имени человека, как в Telegram.
export function pressInRun(run: RolesRun, from: UserId, data: string): RolesRun {
  const lastOut = run.bot.send({ kind: 'button', from: roleSender(from), data });
  return { ...run, lastOut, pressed: { from, data } };
}

// Проиграть сценарий до момента.
export function playToMoment(id: MomentId): RolesRun {
  const story = new Story();
  for (const moment of MOMENTS) {
    const columns = story.play(moment.id);
    if (moment.id === id) return { bot: story.bot, moment, columns, lastOut: [] };
  }
  throw new Error(`нет момента ${id}`);
}

class Story {
  readonly bot = new TestBot(testConfig({ adminIds: [ADMIN], finalists: 2, title: 'Осенний турнир', code: 'osen' }));
  private firstMatch = '';
  private finalists: [UserId, UserId] = ['', ''];

  play(id: MomentId): RoleColumn[] {
    switch (id) {
      case 'intake':
        return this.intake();
      case 'qualifiers':
        return this.qualifiers();
      case 'final':
        return this.final();
      case 'archive':
        return this.archive();
    }
  }

  private intake(): RoleColumn[] {
    for (const id of PLAYERS) {
      this.command(id, 'start', 't_osen');
      this.press(id, 'r:name');
      this.press(id, 'r:accept');
    }
    this.command(SONGS_ONLY, 'start', 't_osen');
    this.press(SONGS_ONLY, 'r:name');
    this.press(SONGS_ONLY, 'r:songs');
    for (const id of PLAYERS) this.songs(id, 10);
    this.songs(SONGS_ONLY, 6);
    this.bot.processAudio();
    this.open(ORGANIZER, 'intake');
    return [
      { role: 'Организатор', userId: ORGANIZER, note: 'Панель турнира, раздел «🎵 Сбор»: кто сколько прислал, закрыть сбор.' },
      { role: 'Админ', userId: ADMIN, note: 'Своя копия панели: те же разделы, но настройки менять не может.' },
      { role: 'Игрок', userId: '1', note: 'Правила, список своих песен — его можно править до закрытия сбора.' },
      { role: 'Только песни', userId: SONGS_ONLY, note: 'Прислала 6 песен и не играет: в жеребьёвку не попадёт.' },
    ];
  }

  private qualifiers(): RoleColumn[] {
    this.open(ORGANIZER, 'intake');
    this.press(ORGANIZER, 'o:closeIntake');
    this.open(ORGANIZER, 'home');
    this.press(ORGANIZER, 'o:toDraw');
    this.open(ORGANIZER, 'bracket');
    this.press(ORGANIZER, 'o:draw');
    this.open(ORGANIZER, 'home');

    this.firstMatch = this.nextMatch()!;
    const [a, b] = this.players(this.firstMatch);
    this.press(a, 'd:pickJudge');
    this.press(a, `d:judge:${SONGS_ONLY}`);
    this.press(SONGS_ONLY, `d:accept:${this.firstMatch}`);
    this.press(b, `d:confirmJudge:${this.firstMatch}`);
    const m = `m:${this.firstMatch}:`;
    for (const id of [SONGS_ONLY, a, b]) this.press(id, `${m}ready`);
    this.track(SONGS_ONLY, m, 0, 1);
    this.track(SONGS_ONLY, m, 1);
    this.press(SONGS_ONLY, `${m}issue`);
    this.press(SONGS_ONLY, `${m}start`);
    this.press(SONGS_ONLY, `${m}aw:a:0`);
    this.open(ADMIN, 'matches');
    const waiting = PLAYERS.find((id) => id !== a && id !== b)!;
    return [
      { role: 'Организатор', userId: ORGANIZER, note: 'Главный экран отбора: сыграно, идут, без судьи; споры приходят уведомлением.' },
      { role: 'Админ', userId: ADMIN, note: 'Раздел «🎤 Матчи»: живой счёт и судьи всех матчей.' },
      { role: 'Игрок', userId: a, note: 'Карточка пары и матч: счёт после каждого трека, ответов не видно.' },
      { role: 'Судья', userId: SONGS_ONLY, note: 'Панель судьи: ответы трека и кнопки «исполнитель», «название».' },
      { role: 'Ждёт пару', userId: waiting, note: 'Не в этом матче: карточка своей пары, соперник и срок.' },
    ];
  }

  private final(): RoleColumn[] {
    const m = `m:${this.firstMatch}:`;
    this.press(SONGS_ONLY, `${m}close`);
    this.track(SONGS_ONLY, m, 0);
    this.track(SONGS_ONLY, m, 0, 0);
    this.confirm(m, [SONGS_ONLY, ...this.players(this.firstMatch)]);
    for (let guard = 0, id = this.nextMatch(); id && guard < 10; id = this.nextMatch(), guard++) {
      const [x, y] = this.players(id);
      this.press(x, 'd:pickJudge');
      const judge = this.bot.buttons(x).find((d) => d.startsWith('d:judge:'))!.slice('d:judge:'.length);
      this.press(x, `d:judge:${judge}`);
      this.press(judge, `d:accept:${id}`);
      this.press(y, `d:confirmJudge:${id}`);
      const p = `m:${id}:`;
      for (const r of [judge, x, y]) this.press(r, `${p}ready`);
      for (let i = 0; i < 5; i++) this.track(judge, p, 0, 0);
      this.confirm(p, [judge, x, y]);
    }

    this.open(ORGANIZER, 'home');
    this.press(ORGANIZER, 'o:toFinal');
    this.command(FINAL_JUDGE, 'start', 'fjudge_osen');
    this.press(FINAL_JUDGE, 'r:name');
    this.press(FINAL_JUDGE, 'r:accept');
    this.open(ORGANIZER, 'home');
    this.press(ORGANIZER, 'o:openFinal');
    this.open(ORGANIZER, 'final');
    this.press(ORGANIZER, 'o:start:f1-1');
    this.finalists = this.bot.state.final!.config.finalists.map((p) => p.id) as [UserId, UserId];
    this.press(FINAL_JUDGE, 'f:ready');
    for (const id of this.finalists) if (this.has(id, 'f:ready')) this.press(id, 'f:ready');
    this.track(FINAL_JUDGE, 'f:', 0, 1);
    this.track(FINAL_JUDGE, 'f:', 1, 0);
    this.press(FINAL_JUDGE, 'f:issue');
    this.press(FINAL_JUDGE, 'f:start');
    const out = PLAYERS.find((id) => !this.finalists.includes(id))!;
    return [
      { role: 'Организатор', userId: ORGANIZER, note: 'Раздел «🏆 Финал»: сетка, пара на сцене, очередь песен, офлайн-комплект.' },
      { role: 'Судья финала', userId: FINAL_JUDGE, note: 'Не участник: пришла по ссылке судьи финала, видит ответы финального пула.' },
      { role: 'Финалист', userId: this.finalists[0], note: 'На сцене: счёт после каждого трека.' },
      { role: 'Выбыл', userId: out, note: 'Проиграл в отборе: видит итог своего матча.' },
    ];
  }

  private archive(): RoleColumn[] {
    this.press(FINAL_JUDGE, 'f:aw:a:0');
    this.press(FINAL_JUDGE, 'f:aw:t:0');
    this.press(FINAL_JUDGE, 'f:close');
    for (let i = 0; i < 4 && this.has(FINAL_JUDGE, 'f:issue'); i++) this.track(FINAL_JUDGE, 'f:', 0, 0);
    this.confirm('f:', [FINAL_JUDGE, ...this.finalists]);
    this.open(ORGANIZER, 'home');
    this.press(ORGANIZER, 'o:archive');
    const out = PLAYERS.find((id) => !this.finalists.includes(id))!;
    return [
      { role: 'Организатор', userId: ORGANIZER, note: 'Итоги турнира в панели. В «🗂 Все турниры» — новый турнир и бэкап всей базы.' },
      { role: 'Победитель', userId: this.finalists[0], note: 'Последний матч и поздравление.' },
      { role: 'Участник', userId: out, note: 'Итог турнира приходит всем.' },
    ];
  }

  // --- Действия от имени людей --------------------------------------------------------

  private press(id: UserId, action: string): void {
    const data = this.bot.buttons(id).find((d) => d.split('|')[0] === action);
    if (!data) throw new Error(`Роли: у ${id} нет кнопки «${action}». Видны: ${this.bot.buttons(id).join(', ')}`);
    this.bot.send({ kind: 'button', from: roleSender(id), data });
  }

  private has(id: UserId, action: string): boolean {
    return this.bot.buttons(id).some((d) => d.split('|')[0] === action);
  }

  private command(id: UserId, command: string, payload: string): void {
    this.bot.send({ kind: 'command', from: roleSender(id), command, payload });
  }

  // Раздел панели админа: разделы — на главном экране, из карточек — назад к списку.
  private open(id: UserId, screen: string): void {
    for (const back of ['o:v:matches', 'o:v:players', 'o:v:home']) {
      if (this.has(id, `o:v:${screen}`)) break;
      if (this.has(id, back)) this.press(id, back);
    }
    if (this.has(id, `o:v:${screen}`)) this.press(id, `o:v:${screen}`);
  }

  private songs(id: UserId, count: number): void {
    const files: AudioFile[] = Array.from({ length: count }, (_, i) => ({
      fileId: `F-${id}-${i}`,
      fileUniqueId: `U-${id}-${i}`,
      fileName: `track${i}.mp3`,
      mimeType: 'audio/mpeg',
      sizeBytes: 5_000_000,
      durationSec: 200,
      performer: BANDS[(Number(id) * 3 + i) % BANDS.length],
      title: `Песня №${Number(id) * 10 + i}`,
    }));
    this.bot.send({ kind: 'files', from: roleSender(id), files });
  }

  private track(judge: UserId, prefix: string, artist?: number, title?: number): void {
    this.press(judge, `${prefix}issue`);
    this.press(judge, `${prefix}start`);
    if (artist !== undefined) this.press(judge, `${prefix}aw:a:${artist}`);
    if (title !== undefined) this.press(judge, `${prefix}aw:t:${title}`);
    this.press(judge, `${prefix}close`);
  }

  private confirm(prefix: string, people: UserId[]): void {
    for (const id of people) if (this.has(id, `${prefix}confirm`)) this.press(id, `${prefix}confirm`);
  }

  private nextMatch(): string | undefined {
    const draw = this.bot.state.draw!;
    return openMatches(draw.bracket!, draw.results)[0]?.id;
  }

  private players(matchId: string): [UserId, UserId] {
    return matchPlayers(this.bot.state.draw!, matchId)! as [UserId, UserId];
  }
}

const BANDS = ['Северные огни', 'Тёплый ламповый', 'Кошка Мурка', 'Пятый этаж', 'Синий трамвай', 'Ночной рейс', 'Сухой лёд', 'Гараж 17', 'Белый шум', 'Медленный поезд'];
