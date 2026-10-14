import { hashText } from '../shared/random.ts';
import { base } from './base/index.ts';
import { disco } from './disco/index.ts';
import { rude } from './rude/index.ts';
import type { Variants } from './variants.ts';

export { pick, pickWith, type Variants } from './variants.ts';

// Тексты бота для участников — как переводы: каталог по ключам, стиль — как язык.
// Основной стиль (base/) содержит все тексты. Остальные стили переопределяют любые ключи,
// недостающие берутся из основного — новый текст достаточно написать один раз в base/.
// Панель организатора и журнал турнира в каталог не входят: там один стиль.
// Как писать тексты и стили — src/texts/README.md.

// Каталог так, как его видит код: варианты уже выбраны.
type Resolved<T> =
  T extends Variants<infer P, infer F>
    ? F extends false
      ? string
      : (p: P) => string
    : T extends (p: infer P) => string
      ? (p: P) => string
      : T extends string
        ? string
        : { [K in keyof T]: Resolved<T[K]> };

export type Texts = Resolved<typeof base>;

// Стиль задаёт только то, что хочет поменять: строку, функцию или список вариантов.
type Alternative<P> = string | ((p: P) => string) | readonly (string | ((p: P) => string))[];
type Override<T> =
  T extends Variants<infer P>
    ? Alternative<P>
    : T extends (p: infer P) => string
      ? Alternative<P>
      : T extends string
        ? string | readonly string[]
        : { [K in keyof T]?: Override<T[K]> };

export type StyleTexts = Override<typeof base>;

export interface Style {
  // Название на кнопке выбора.
  name: string;
  // Пример — показывается при выборе стиля.
  sample: string;
  // Пример с запиканным матом — в списке стилей у тех, кто этот стиль ещё не выбрал.
  sampleBleeped?: string;
  // Чего ждать — показывается перед включением, если стиль не для всех (например, с матом).
  // Его читают ещё в прежнем стиле, поэтому пишется нейтрально.
  warning?: string;
  texts: StyleTexts;
}

export const BASE_STYLE = 'base';

const STYLES: Record<string, Style> = {
  [BASE_STYLE]: { name: '🙂 Обычный', sample: 'Поздравляю с победой!', texts: {} },
  disco,
  rude,
};

export const STYLE_IDS = Object.keys(STYLES);

export function styleOf(id: string | undefined): Style {
  return (id && STYLES[id]) || STYLES[BASE_STYLE]!;
}

export function styleId(id: string | undefined): string {
  return id && STYLES[id] ? id : BASE_STYLE;
}

const resolved = new Map<string, Texts>();

// Тексты для человека в его стиле. Неизвестный стиль (например, убранный из бота) — основной.
// viewer — кому пишем: от него зависит выбор вариантов.
export function textsFor(style: string | undefined, viewer = ''): Texts {
  const id = styleId(style);
  const key = `${id}\u0000${viewer}`;
  let texts = resolved.get(key);
  if (!texts) {
    texts = resolve(base, STYLES[id]!.texts, '', viewer) as Texts;
    resolved.set(key, texts);
  }
  return texts;
}

// Тексты для конкретного человека по карте стилей сессии.
export function textsOf(styles: Readonly<Record<string, string>> | undefined, userId: string): Texts {
  return textsFor(styles?.[userId], userId);
}

// Форма — по основному стилю: строка остаётся строкой, функция — функцией, хоть бы стиль
// и дал вместо неё список вариантов.
function resolve(shape: unknown, override: unknown, path: string, viewer: string): unknown {
  if (isVariants(shape) || typeof shape === 'function' || typeof shape === 'string') {
    const options = optionsOf(override ?? shape);
    const takesParams = typeof shape === 'function' || (isVariants(shape) && shape.params);
    if (!takesParams) {
      const option = options[hashText(`${viewer}|${path}`) % options.length]!;
      return typeof option === 'function' ? option({}) : option;
    }
    return (params: object) => {
      const option = options[hashText(`${viewer}|${path}|${JSON.stringify(params)}`) % options.length]!;
      return typeof option === 'function' ? option(params) : option;
    };
  }
  const result: Record<string, unknown> = {};
  const patch = (override ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(shape as Record<string, unknown>)) {
    result[key] = resolve(value, patch[key], path ? `${path}.${key}` : key, viewer);
  }
  return result;
}

type Option = string | ((p: object) => string);

function optionsOf(node: unknown): Option[] {
  if (isVariants(node)) return [...node.variants] as Option[];
  if (Array.isArray(node)) return node.length > 0 ? (node as Option[]) : [''];
  return [node as Option];
}

function isVariants(node: unknown): node is Variants<object> {
  return typeof node === 'object' && node !== null && 'variants' in node && 'params' in node;
}
