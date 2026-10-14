import { describe, expect, it } from 'vitest';
import { STYLE_IDS, styleOf, textsFor } from './index.ts';

// Подставляет в любую фразу одинаковые параметры: число 3 годится и как имя, и как счёт.
const ANY = new Proxy({}, { get: () => 3 });

// У каждого параметра своя метка из четырёх цифр — по ней видно, дошёл ли он до текста.
const MARKS = ['name', 'match', 'n', 'max', 'accepted', 'count', 'total', 'title', 'judge', 'opponent', 'until', 'date', 'winner', 'score', 'a', 'b', 'by', 'start', 'sec', 'label', 'number', 'round', 'points', 'tracks', 'artist', 'p0', 'p1', 'progress', 'champion', 'names', 'reason', 'duration', 'latest', 'file', 'link', 'contact', 'pair', 'command', 'answers', 'available', 'needed', 'played', 'of', 'changed', 'kept', 'from', 'done', 'all', 'phase', 'mark', 'text', 'rejected', 'max'];
const MARKED = new Proxy(
  {},
  { get: (_, key) => (typeof key === 'string' && MARKS.includes(key) ? 1000 + MARKS.indexOf(key) : 3) },
);

function phrases(node: unknown, path: string, out: { path: string; text: unknown }[], params: object = ANY): void {
  if (typeof node === 'string') out.push({ path, text: node });
  else if (typeof node === 'function') out.push({ path, text: (node as (p: unknown) => unknown)(params) });
  else for (const [key, value] of Object.entries(node as object)) phrases(value, `${path}.${key}`, out, params);
}

describe('тексты бота', () => {
  it.each(STYLE_IDS)('стиль %s: все фразы собираются — без undefined и не длиннее сообщения Telegram', (style) => {
    expect(styleOf(style).name).not.toBe('');
    for (const viewer of ['1', '2', '3']) {
      const all: { path: string; text: unknown }[] = [];
      phrases(textsFor(style, viewer), style, all);
      for (const { path, text } of all) {
        expect(typeof text, path).toBe('string');
        expect(text as string, path).not.toMatch(/undefined|\[object|NaN/);
        expect((text as string).length, path).toBeLessThan(1000);
      }
    }
  });

  // Стиль меняет подачу, не содержание: каждый параметр, который есть во фразе основного стиля
  // (номер матча, имя, счёт, срок), должен остаться и во фразе стиля — во всех её вариантах.
  it.each(STYLE_IDS.filter((s) => s !== 'base'))('стиль %s не теряет ни имён, ни цифр основного', (style) => {
    const missing: string[] = [];
    for (const viewer of Array.from({ length: 40 }, (_, i) => String(i))) {
      const base: { path: string; text: unknown }[] = [];
      const styled: { path: string; text: unknown }[] = [];
      phrases(textsFor('base', viewer), '', base, MARKED);
      phrases(textsFor(style, viewer), '', styled, MARKED);
      const styledText = new Map(styled.map((p) => [p.path, p.text as string]));
      for (const { path, text } of base) {
        const markers = (text as string).match(/\d{4}/g) ?? [];
        const own = styledText.get(path)!;
        for (const marker of markers) if (!own.includes(marker)) missing.push(`${path}: нет ${marker} в «${own}»`);
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });

  it('вариант зависит от параметров, но не меняется при перерисовке', () => {
    const texts = textsFor('base', '42');
    expect(texts.match.player.won({ match: '1.2' })).toBe(textsFor('base', '42').match.player.won({ match: '1.2' }));
    const picked = new Set(Array.from({ length: 20 }, (_, i) => texts.match.player.won({ match: `1.${i}` })));
    expect(picked.size).toBeGreaterThan(1);
  });

  it('число и слово согласованы: 3 трека, 1 файл, «нихуя» при нуле', () => {
    const base = textsFor('base', '1');
    expect(base.match.judge.fixed({ tracks: 3 })).toMatch(/^3 трека,/);
    expect(base.match.judge.limit({ tracks: 21 })).toMatch(/^Не больше 21 трека;/);
    expect(base.intake.list.full({ max: 3 })).toBe('✅ Все 3 песни приняты');
    for (const viewer of Array.from({ length: 20 }, (_, i) => String(i))) {
      const rude = textsFor('rude', viewer);
      expect(rude.intake.notice.received({ count: 1, rejected: 0 })).not.toMatch(/Прилетел[ои] 1 /);
      expect(rude.intake.notice.received({ count: 3, rejected: 0 })).not.toMatch(/Прилетел 3 |Прилетело 3 /);
      expect(rude.intake.list.progress({ accepted: 0, max: 15 })).toContain('0 из 15 — то есть нихуя');
      expect(rude.intake.list.progress({ accepted: 2, max: 15 })).not.toContain('нихуя');
    }
  });

  it('неизвестный стиль — основной', () => {
    expect(textsFor('нет-такого', '1').intake.toast.closed).toBe(textsFor(undefined, '1').intake.toast.closed);
  });
});
