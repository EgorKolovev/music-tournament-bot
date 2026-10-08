import { DEFAULT_RULESET } from '../domain/match/ruleset.ts';
import type { LibrarySong, MatchSessionConfig } from '../bot/matchSession.ts';

// Вымышленные участники и только метаданные песен — без аудио, симулятор публичный.
export const DEMO_USERS = {
  judge: { id: 'u-vika', name: 'Вика' },
  p0: { id: 'u-anya', name: 'Аня' },
  p1: { id: 'u-boris', name: 'Борис' },
} as const;

const OTHER = 'u-other';

const SONGS: [artist: string, title: string, owner: string, accepted?: string[]][] = [
  ['Queen', 'Bohemian Rhapsody', DEMO_USERS.p0.id],
  ['Кино', 'Группа крови', DEMO_USERS.p0.id, ['Виктор Цой']],
  ['ABBA', 'Dancing Queen', DEMO_USERS.p0.id],
  ['Nirvana', 'Smells Like Teen Spirit', DEMO_USERS.p1.id],
  ['Земфира', 'Искала', DEMO_USERS.p1.id],
  ['Daft Punk', 'Get Lucky', DEMO_USERS.p1.id, ['Daft Punk feat. Pharrell Williams']],
  ['The Beatles', 'Hey Jude', OTHER, ['Битлз']],
  ['Michael Jackson', 'Billie Jean', OTHER],
  ['Сплин', 'Выхода нет', OTHER],
  ['Radiohead', 'Creep', OTHER],
  ['Би-2', 'Полковнику никто не пишет', OTHER, ['Би 2', 'Би два']],
  ['Coldplay', 'Viva la Vida', OTHER],
  ['Ленинград', 'WWW', OTHER],
  ['Adele', 'Rolling in the Deep', OTHER],
  ['Мумий Тролль', 'Владивосток 2000', OTHER],
  ['Eminem', 'Lose Yourself', OTHER],
  ['Король и Шут', 'Кукла колдуна', OTHER, ['КиШ']],
  ['Arctic Monkeys', 'Do I Wanna Know?', OTHER],
  ['Сектор Газа', 'Лирика', OTHER],
  ['Linkin Park', 'Numb', OTHER],
  ['Ария', 'Беспечный ангел', OTHER],
  ['Imagine Dragons', 'Believer', OTHER],
  ['ДДТ', 'Что такое осень', OTHER],
  ['Red Hot Chili Peppers', 'Californication', OTHER, ['RHCP']],
  ['Звери', 'Районы-кварталы', OTHER],
  ['Gorillaz', 'Feel Good Inc.', OTHER],
  ['Агата Кристи', 'Как на войне', OTHER],
  ['The Weeknd', 'Blinding Lights', OTHER],
  ['Ночные Снайперы', '31-я весна', OTHER],
  ['Muse', 'Uprising', OTHER],
  ['Машина времени', 'Поворот', OTHER],
  ['Billie Eilish', 'Bad Guy', OTHER],
  ['Чиж & Co', 'Перекрёсток', OTHER],
  ['Depeche Mode', 'Enjoy the Silence', OTHER],
  ['Пикник', 'Египтянин', OTHER],
  ['Dua Lipa', 'Levitating', OTHER],
  ['Наутилус Помпилиус', 'Прогулки по воде', OTHER, ['Наутилус']],
  ['AC/DC', 'Highway to Hell', OTHER, ['ACDC']],
  ['Алла Пугачёва', 'Миллион алых роз', OTHER],
  ['Rammstein', 'Du hast', OTHER],
];

export const DEMO_LIBRARY: LibrarySong[] = SONGS.map(([artist, title, owner, accepted], index) => ({
  id: `song-${String(index + 1).padStart(2, '0')}`,
  artist,
  title,
  ownerIds: [owner],
  acceptedAnswers: accepted,
}));

export function demoConfig(overrides: Partial<MatchSessionConfig> = {}): MatchSessionConfig {
  return {
    matchNo: 7,
    players: [DEMO_USERS.p0, DEMO_USERS.p1],
    judge: DEMO_USERS.judge,
    library: DEMO_LIBRARY,
    ruleset: DEFAULT_RULESET,
    seed: 2026,
    ...overrides,
  };
}
