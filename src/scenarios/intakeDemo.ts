import type { AudioFile } from '../domain/submission/intake.ts';
import type { CatalogFile } from './engine.ts';

// Фейковые файлы «как будто переслали из музыкального бота»: только то, что Telegram сообщает
// о файле. Аудио нет — симулятор публичный.

const MB = 1024 * 1024;

function file(key: string, overrides: Partial<AudioFile>): AudioFile {
  return {
    fileId: `file-${key}`,
    fileUniqueId: `uniq-${key}`,
    mimeType: 'audio/mpeg',
    sizeBytes: Math.round(7.4 * MB),
    durationSec: 215,
    ...overrides,
  };
}

function tagged(key: string, performer: string, title: string, note = 'теги в порядке'): [string, CatalogFile] {
  return [key, { file: file(key, { performer, title, fileName: `${performer} - ${title}.mp3` }), note }];
}

export const DEMO_CATALOG: Record<string, CatalogFile> = Object.fromEntries([
  tagged('queen', 'Queen', 'Bohemian Rhapsody (Remastered 2011)', 'мусор в названии — бот почистит'),
  tagged('kino', 'Кино', 'Группа крови'),
  tagged('abba', 'ABBA', 'Dancing Queen'),
  tagged('nirvana', 'Nirvana', 'Smells Like Teen Spirit'),
  tagged('zemfira', 'Земфира', 'Искала'),
  tagged('daftpunk', 'Daft Punk feat. Pharrell Williams', 'Get Lucky (Radio Edit)', 'featuring — уйдёт в варианты'),
  tagged('muse', 'Muse', 'Uprising'),
  tagged('rammstein', 'Rammstein', 'Du hast'),
  tagged('agata', 'Агата Кристи', 'Как на войне'),
  tagged('linkin', 'Linkin Park', 'Numb [Official Music Video] (muzofond.fm)', 'метка сайта в названии'),
  tagged('beatles', 'The Beatles', 'Hey Jude'),
  tagged('beatles2', 'Beatles', 'Hey Jude (Remastered 2015)', 'та же песня, другие теги'),
  tagged('ddt', 'ДДТ', 'Что такое осень'),
  tagged('splean-tagged', 'Сплин', 'Выхода нет'),
  [
    'splean',
    {
      file: file('splean', { fileName: '03. Сплин - Выхода нет.mp3' }),
      note: 'без тегов, название в имени файла',
    },
  ],
  [
    'track04',
    {
      file: file('track04', { fileName: 'track_04.mp3' }),
      note: 'без тегов, имя ни о чём',
    },
  ],
  [
    'unknown',
    {
      file: file('unknown', { performer: 'Unknown Artist', title: 'audio_2023-11-02', fileName: 'audio_2023-11-02.m4a', mimeType: 'audio/mp4' }),
      note: 'теги-заглушки',
    },
  ],
  [
    'radiohead-big',
    {
      file: file('radiohead-big', { performer: 'Radiohead', title: 'Creep', fileName: 'Radiohead - Creep (FLAC rip).mp3', sizeBytes: 24 * MB }),
      note: '24 МБ — больше лимита',
    },
  ],
  [
    'coldplay-ogg',
    {
      file: file('coldplay-ogg', { performer: 'Coldplay', title: 'Viva la Vida', fileName: 'viva.ogg', mimeType: 'audio/ogg' }),
      note: 'OGG — не тот формат',
    },
  ],
  [
    'billie-broken',
    {
      file: file('billie-broken', { performer: 'Billie Eilish', title: 'Bad Guy', fileName: 'Billie Eilish - Bad Guy.mp3' }),
      note: 'битый файл — worker отклонит',
      corrupt: true,
    },
  ],
]);
