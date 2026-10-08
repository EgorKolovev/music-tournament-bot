import { describe, expect, it } from 'vitest';
import { cleanTitle, fromFileName, fromTags, fromText, songKey } from './titles.ts';

describe('чистка тегов', () => {
  it.each([
    ['Bohemian Rhapsody (Remastered 2011)', 'Bohemian Rhapsody'],
    ['Bohemian Rhapsody - Remastered 2011', 'Bohemian Rhapsody'],
    ['Numb [Official Music Video] (muzofond.fm)', 'Numb'],
    ['Get Lucky (feat. Pharrell Williams) [Radio Edit]', 'Get Lucky'],
    ['Song 2 (2012)', 'Song 2'],
    ['Как на войне', 'Как на войне'],
    ['Live Forever', 'Live Forever'],
  ])('%s → %s', (raw, clean) => {
    expect(cleanTitle(raw)).toBe(clean);
  });

  it('featuring уходит из исполнителя, полное имя остаётся допустимым вариантом', () => {
    expect(fromTags('Daft Punk feat. Pharrell Williams', 'Get Lucky (Radio Edit)')).toEqual({
      artist: 'Daft Punk',
      title: 'Get Lucky',
      variants: ['Daft Punk feat. Pharrell Williams', 'Get Lucky (Radio Edit)'],
    });
  });

  it('заглушки вместо тегов считаются отсутствием тегов', () => {
    expect(fromTags('Unknown Artist', 'audio_2023-11-02')).toBeNull();
    expect(fromTags(undefined, 'Numb')).toBeNull();
  });
});

describe('имя файла', () => {
  it.each([
    ['03. Сплин - Выхода нет.mp3', 'Сплин', 'Выхода нет'],
    ['Кино_-_Группа_крови.mp3', 'Кино', 'Группа крови'],
    ['01 Queen — Bohemian Rhapsody.m4a', 'Queen', 'Bohemian Rhapsody'],
  ])('%s', (fileName, artist, title) => {
    expect(fromFileName(fileName)).toMatchObject({ artist, title });
  });

  it.each(['track_04.mp3', 'audio_2023-11-02.m4a', 'Bohemian Rhapsody.mp3'])('%s не разбирается', (fileName) => {
    expect(fromFileName(fileName)).toBeNull();
  });
});

describe('ответ участника', () => {
  it.each(['Би-2 — Полковнику никто не пишет', 'Би-2 - Полковнику никто не пишет', 'Би-2–Полковнику никто не пишет'])(
    '%s',
    (text) => {
      expect(fromText(text)).toMatchObject({ artist: 'Би-2', title: 'Полковнику никто не пишет' });
    },
  );

  it('без разделителя не принимается', () => {
    expect(fromText('Полковнику никто не пишет')).toBeNull();
  });
});

describe('ключ дубля', () => {
  it('регистр, ё, артикль, ремастер и пунктуация не делают песню новой', () => {
    expect(songKey('The Beatles', 'Hey Jude')).toBe(songKey('Beatles', 'Hey Jude (Remastered 2015)'));
    expect(songKey('Пугачёва', 'Миллион алых роз')).toBe(songKey('пугачева', 'миллион алых роз!'));
  });

  it('разные песни одного исполнителя различаются', () => {
    expect(songKey('Queen', 'Bohemian Rhapsody')).not.toBe(songKey('Queen', "Don't Stop Me Now"));
  });
});
