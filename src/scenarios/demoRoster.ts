import type { Participant } from '../bot/matchSession.ts';
import type { AudioFile } from '../domain/submission/intake.ts';
import { DEMO_USERS } from './demoConfig.ts';

// Общий состав демо-турнира: 20 участников. Аня и Борис действуют в симуляторе,
// остальные «уже сдали» песни. Имена и группы вымышленные.

export const BACKGROUND_PLAYERS: Participant[] = [
  'Вика', 'Гена', 'Дима', 'Егор', 'Женя', 'Зоя', 'Игорь', 'Катя', 'Лёша',
  'Маша', 'Никита', 'Оля', 'Петя', 'Рита', 'Саша', 'Таня', 'Феликс', 'Юля',
].map((name, i) => (name === 'Вика' ? DEMO_USERS.judge : { id: `u-bg-${i}`, name }));

export const ROSTER: Participant[] = [DEMO_USERS.p0, DEMO_USERS.p1, ...BACKGROUND_PLAYERS];

export const USERNAMES: Record<string, string> = Object.fromEntries(
  ROSTER.map((p, i) => [p.id, `@${['anya', 'boris'][i] ?? `player${i + 1}`}_music`]),
);

const ARTISTS = [
  'Северный ветер', 'Полярная ночь', 'Бумажные змеи', 'Город 312', 'Тёплый лёд', 'Шестая линия', 'Сад камней',
  'Лётчики', 'Пятница', 'Белый шум', 'Вторая смена', 'Красный трамвай', 'Ночной экспресс', 'Медные трубы',
  'Сухой закон', 'Капитан Немо', 'Гости из будущего', 'Кот Шрёдингера', 'Мятный чай', 'Сорок оборотов',
  'The Paper Lanterns', 'Velvet Harbor', 'Neon Orchard', 'Glass Animals Club', 'Silver Coast', 'Midnight Ferry',
  'Northern Static', 'Copper Moth', 'Low Tide Choir', 'Wild Honey Union',
];

const TITLES = [
  'Ночь без сна', 'Последний трамвай', 'Песня о ветре', 'Дым над рекой', 'Не уходи', 'Тише', 'Снова лето',
  'Звёзды в лужах', 'Мой город', 'Белые ночи', 'Без тебя', 'Дорога домой', 'Пять минут', 'Осенний блюз',
  'Северное сияние', 'Golden Hour', 'Paper Planes', 'Slow Motion', 'Electric Blue', 'Midnight Call',
  'Lost in Static', 'Summer Rain', 'Heavy Heart', 'Open Road', 'Wildfire', 'Afterglow', 'Satellites',
  'Second Chance', 'Glass House', 'Echoes',
];

// Сколько песен «сдал» фоновый участник; остальные — по 10.
const SHORT_SUBMISSIONS: Record<string, number> = { Гена: 7, Оля: 4 };

// Совпадения с каталогом симулятора: дубли склеятся молча, когда Аня или Борис пришлют эти песни.
const SHARED_SONGS: Record<string, [string, string][]> = {
  Дима: [['Queen', 'Bohemian Rhapsody']],
  Катя: [['Кино', 'Группа крови']],
  Рита: [['The Beatles', 'Hey Jude']],
};

export function backgroundSubmissions(): { participant: Participant; files: AudioFile[] }[] {
  return BACKGROUND_PLAYERS.map((participant, p) => {
    const count = SHORT_SUBMISSIONS[participant.name] ?? 10;
    const pairs: [string, string][] = [...(SHARED_SONGS[participant.name] ?? [])];
    for (let j = 0; pairs.length < count; j++) {
      pairs.push([ARTISTS[(p * 7 + j * 3) % ARTISTS.length]!, TITLES[(p * 11 + j * 7) % TITLES.length]!]);
    }
    const files = pairs.map(([performer, title], j) => ({
      fileId: `bg-${p}-${j}`,
      fileUniqueId: `bg-uniq-${p}-${j}`,
      fileName: `${performer} - ${title}.mp3`,
      mimeType: 'audio/mpeg',
      sizeBytes: 6_500_000,
      durationSec: 200,
      performer,
      title,
    }));
    return { participant, files };
  });
}
