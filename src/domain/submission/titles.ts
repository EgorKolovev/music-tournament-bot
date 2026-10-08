// Извлечение «Исполнитель — Название» из тегов, имени файла или текста участника.
// Чистая версия идёт в ответы судье, исходное написание остаётся допустимым вариантом.

export interface SongMeta {
  artist: string;
  title: string;
  // Допустимые варианты ответа: исходные теги, полное имя с featuring и т. п.
  variants: string[];
}

const PLACEHOLDER_TAGS = new Set(['unknown', 'unknown artist', 'unknown title', 'неизвестен', 'неизвестный исполнитель', 'без названия', 'track', 'audio']);

// Шум в скобках: ремастеры, «официальное видео», метки сайтов.
const NOISE_IN_BRACKETS =
  /\s*[([](?:[^)\]]*\b(?:remaster(?:ed)?|official|video|audio|lyrics?|visuali[sz]er|explicit|clean|radio edit|hd|hq)\b[^)\]]*|\d{4}|[\w-]+\.(?:com|ru|net|org|fm|me|cc|biz|info|io|pro|to|su))[)\]]/gi;
const NOISE_AFTER_DASH = /\s+[-–—]\s+(?:\d{4}\s+)?(?:remaster(?:ed)?(?:\s+\d{4})?|radio edit|single version|official (?:music )?video)\s*$/i;
const FEAT = /\s*[([]?\s*\b(?:feat\.?|ft\.?|featuring)\s+[^)\]]*[)\]]?/i;
const SEPARATOR = /\s+[-–—]\s+|\s*[–—]\s*/;

export function cleanTitle(raw: string): string {
  return collapse(raw.replace(NOISE_IN_BRACKETS, '').replace(NOISE_AFTER_DASH, '').replace(FEAT, ''));
}

export function cleanArtist(raw: string): string {
  return collapse(raw.replace(NOISE_IN_BRACKETS, '').replace(FEAT, ''));
}

export function fromTags(performer: string | undefined, title: string | undefined): SongMeta | null {
  if (!isMeaningful(performer) || !isMeaningful(title)) return null;
  return build(performer!, title!);
}

// «03. Сплин - Выхода нет.mp3» → Сплин — Выхода нет. Имена вроде track_04.mp3 не разбираются.
export function fromFileName(fileName: string | undefined): SongMeta | null {
  if (!fileName) return null;
  const base = fileName
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/_/g, ' ')
    .replace(/^\s*\d{1,3}\s*[.)-]?\s+/, '');
  return parsePair(base);
}

// Ответ участника текстом: «Исполнитель — Название» с любым тире или дефисом.
export function fromText(text: string): SongMeta | null {
  return parsePair(text);
}

function parsePair(value: string): SongMeta | null {
  const match = SEPARATOR.exec(value);
  if (!match) return null;
  const artist = value.slice(0, match.index);
  const title = value.slice(match.index + match[0].length);
  if (!isMeaningful(artist) || !isMeaningful(title)) return null;
  return build(artist, title);
}

function build(rawArtist: string, rawTitle: string): SongMeta | null {
  const artist = cleanArtist(rawArtist);
  const title = cleanTitle(rawTitle);
  if (!artist || !title) return null;
  const variants = [collapse(rawArtist), collapse(rawTitle)].filter((v) => v !== artist && v !== title);
  return { artist, title, variants: [...new Set(variants)] };
}

function isMeaningful(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = collapse(value).toLowerCase();
  if (!normalized || PLACEHOLDER_TAGS.has(normalized)) return false;
  // Технические имена вроде audio_2023-11-02 или track 04.
  return !/^(?:track|audio|аудио|трек|voice|file)[\s_-]*[\d\s_.-]*$/i.test(normalized);
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

// Ключ музыкальной идентичности для поиска дублей: регистр, ё/е, артикль, пунктуация не важны.
export function songKey(artist: string, title: string): string {
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/&/g, ' and ')
      .replace(/^the\s+/, '')
      .replace(/[^\p{L}\p{N}]+/gu, '');
  return `${normalize(cleanArtist(artist))}|${normalize(cleanTitle(title))}`;
}
