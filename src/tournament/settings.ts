import { render as renderIntake } from '../bot/intakeSession.ts';
import type { OutgoingMessage, UserId } from '../bot/protocol.ts';
import { formatPoints, type MatchFormat, minLeadOf, regularTracks, type Ruleset } from '../domain/match/ruleset.ts';
import { activeCount, recutAll } from '../domain/submission/intake.ts';
import { plural } from '../shared/text.ts';
import { scope, toast } from './helpers.ts';
import type { Step, TournamentConfig, TournamentState } from './state.ts';

// Настройки турнира по ходу (docs/decisions/2026-10-13-tournaments-in-bot.md). У каждой есть момент,
// когда она расходится по сбору, сетке или матчам: до него менять безопасно, после — она под замком.
// Сбор хранит свою копию лимита песен, фрагмента, пула и числа финалистов — меняются обе разом.
// Изменение — обычное нажатие кнопки в журнале: повтор журнала приходит к тем же настройкам.

export type SettingKey = 'songs' | 'fragment' | 'pool' | 'finalists' | 'round' | 'tracks' | 'lead' | 'points' | 'finalTo';

interface Setting {
  icon: string;
  name: string;
  options: readonly number[];
  value(config: TournamentConfig): number;
  show(value: number): string;
  // Подпись кнопки на экране выбора, если show длинный.
  short?(value: number): string;
  // Когда застывает и что станет с уже собранным.
  hint: string;
  lock(state: TournamentState): string | null;
  optionLock?(state: TournamentState, value: number): string | null;
  apply(state: TournamentState, value: number): TournamentState;
}

const CLOSED_INTAKE = 'сбор закрыт';

function intakeOpen(state: TournamentState): string | null {
  return state.phase === 'intake' && !state.intake.closed ? null : CLOSED_INTAKE;
}

function beforeDraw(reason: string) {
  return (state: TournamentState): string | null => (state.phase === 'intake' ? null : reason);
}

// Регламент уходит в каждый матч при его открытии: после первого матча пары играли бы по разным правилам.
function beforeMatches(state: TournamentState): string | null {
  if (state.phase === 'intake') return null;
  return state.phase === 'qualifiers' && Object.keys(state.matches).length === 0 ? null : 'матчи отбора уже начались';
}

// Очки исполнитель/название одним числом: 912 — 0,9 и 1,2; 1015 — 1,0 и 1,5.
const pointsOf = (ruleset: Ruleset) => ruleset.artistPoints * 100 + ruleset.titlePoints;
const withPoints = (ruleset: Ruleset, value: number): Ruleset => ({
  ...ruleset,
  artistPoints: Math.floor(value / 100),
  titlePoints: value % 100,
});

// Формат отбора целиком: число треков и отрыв меняются по отдельности и не теряют друг друга.
// У отбора формат всегда fixed; иначе — fixed с тем же числом треков.
function fixedFormat(ruleset: Ruleset): Extract<MatchFormat, { kind: 'fixed' }> {
  return ruleset.format.kind === 'fixed' ? ruleset.format : { kind: 'fixed', tracks: regularTracks(ruleset.format) };
}

const SETTINGS: Record<SettingKey, Setting> = {
  songs: {
    icon: '🎵',
    name: 'Песен на игрока',
    options: [5, 7, 10, 12, 15],
    value: (config) => config.intakeRules.maxSubmissions,
    show: (v) => `до ${v}`,
    short: (v) => String(v),
    hint: 'Застывает при закрытии сбора. Меньше, чем уже прислал кто-то из участников, поставить нельзя.',
    lock: intakeOpen,
    optionLock: (state, v) => {
      const owners = new Set(state.intake.intake.submissions.map((s) => s.owner));
      const most = Math.max(0, ...[...owners].map((id) => activeCount(state.intake.intake, id)));
      return v < most ? `У кого-то уже ${most} ${plural(most, 'песня', 'песни', 'песен')} — меньше нельзя` : null;
    },
    apply: (state, v) => {
      const rules = { ...state.config.intakeRules, maxSubmissions: v };
      const { intake } = state;
      return {
        ...state,
        config: { ...state.config, intakeRules: rules },
        intake: { ...intake, config: { ...intake.config, rules }, intake: { ...intake.intake, rules } },
      };
    },
  },
  fragment: {
    icon: '⏱',
    name: 'Длина фрагмента',
    options: [30, 45, 60, 90],
    value: (config) => config.fragmentSec,
    show: (v) => `${v} с`,
    hint: 'Сколько звучит песня у судьи. Застывает при закрытии сбора. Уже нарезанные песни нарежутся заново.',
    lock: intakeOpen,
    apply: (state, v) => ({
      ...state,
      config: { ...state.config, fragmentSec: v },
      intake: { ...state.intake, config: { ...state.intake.config, fragmentSec: v }, intake: recutAll(state.intake.intake) },
    }),
  },
  pool: {
    icon: '🏆',
    name: 'Финальный пул',
    options: [10, 20, 40, 60, 120],
    value: (config) => config.finalPoolTarget,
    show: (v) => `${v} ${plural(v, 'песня', 'песни', 'песен')}`,
    short: (v) => String(v),
    hint: 'Сколько песен уходит в финал. Застывает при закрытии сбора: тогда песни делятся на пулы.',
    lock: intakeOpen,
    apply: (state, v) => ({
      ...state,
      config: { ...state.config, finalPoolTarget: v },
      intake: { ...state.intake, config: { ...state.intake.config, finalPoolTarget: v } },
    }),
  },
  finalists: {
    icon: '👥',
    name: 'Финалистов',
    options: [2, 4, 8, 16],
    value: (config) => config.finalists,
    show: (v) => String(v),
    hint: 'Застывает при переходе к жеребьёвке: по нему строится сетка.',
    lock: beforeDraw('жеребьёвка уже началась'),
    apply: (state, v) => ({
      ...state,
      config: { ...state.config, finalists: v },
      intake: { ...state.intake, config: { ...state.intake.config, finalists: v } },
    }),
  },
  round: {
    icon: '📅',
    name: 'Срок круга',
    options: [0, 1, 2, 3, 5, 7],
    value: (config) => config.roundDays,
    show: (v) => (v === 0 ? 'без срока' : `${v} ${plural(v, 'день', 'дня', 'дней')}`),
    short: (v) => (v === 0 ? 'без срока' : `${v} д`),
    hint: [
      'Сколько дней даётся на круг отбора, считая от жеребьёвки. Застывает при переходе к жеребьёвке, потом срок можно продлить в «Сетке».',
      '«Без срока» — дат нет вовсе: пары договариваются сами, бот не напоминает и не торопит. Подходит, если весь турнир пройдёт за день-два.',
    ].join('\n\n'),
    lock: (state) => (state.phase === 'intake' ? null : state.config.roundDays === 0 ? 'жеребьёвка уже началась' : 'сроки назначены — их двигают в «Сетке»'),
    apply: (state, v) => ({ ...state, config: { ...state.config, roundDays: v } }),
  },
  tracks: {
    icon: '🎤',
    name: 'Треков в матче отбора',
    options: [3, 5, 7],
    value: (config) => (config.qualifierRuleset.format.kind === 'fixed' ? config.qualifierRuleset.format.tracks : 0),
    show: (v) => String(v),
    hint: 'Застывает с первым матчем отбора — иначе пары играли бы по разным правилам.',
    lock: beforeMatches,
    apply: (state, v) => {
      const ruleset = state.config.qualifierRuleset;
      return { ...state, config: { ...state.config, qualifierRuleset: { ...ruleset, format: { ...fixedFormat(ruleset), tracks: v } } } };
    },
  },
  lead: {
    icon: '📏',
    name: 'Отрыв в отборе',
    options: [0, 10, 20, 30],
    value: (config) => minLeadOf(config.qualifierRuleset.format),
    show: (v) => (v === 0 ? 'любой' : `от ${formatPoints(v)}`),
    short: (v) => (v === 0 ? 'любой' : formatPoints(v)),
    hint: [
      'Сколько баллов отрыва нужно для победы, когда основные треки сыграны. Меньше — пара играет ещё по треку, пока отрыв не дойдёт до нужного; лимита нет, матч остановится, только если кончатся песни.',
      '«Любой» — прежнее правило: дополнительные треки только при ничьей. С отрывом матчи длиннее, песен на матч нужно больше. Финал не меняется. Застывает с первым матчем отбора — иначе пары играли бы по разным правилам.',
    ].join('\n\n'),
    lock: beforeMatches,
    apply: (state, v) => {
      const ruleset = state.config.qualifierRuleset;
      return { ...state, config: { ...state.config, qualifierRuleset: { ...ruleset, format: { ...fixedFormat(ruleset), minLead: v } } } };
    },
  },
  points: {
    icon: '🎯',
    name: 'Очки',
    options: [912, 1015],
    value: (config) => pointsOf(config.qualifierRuleset),
    show: (v) => `исполнитель ${formatPoints(Math.floor(v / 100))}, название ${formatPoints(v % 100)}`,
    short: (v) => `${formatPoints(Math.floor(v / 100))} и ${formatPoints(v % 100)}`,
    hint: 'За исполнителя и за название, в отборе и в финале. Застывает с первым матчем отбора.',
    lock: beforeMatches,
    apply: (state, v) => ({
      ...state,
      config: {
        ...state.config,
        qualifierRuleset: withPoints(state.config.qualifierRuleset, v),
        finalRuleset: withPoints(state.config.finalRuleset, v),
      },
    }),
  },
  finalTo: {
    icon: '🏁',
    name: 'Финал',
    options: [60, 90, 120],
    value: (config) => (config.finalRuleset.format.kind === 'first_to' ? config.finalRuleset.format.winThreshold : 0),
    show: (v) => `до ${formatPoints(v)}`,
    hint: 'До скольких баллов идёт матч финала. Застывает при открытии финала.',
    lock: (state) => (state.final ? 'финал уже открыт' : null),
    apply: (state, v) => {
      const { format } = state.config.finalRuleset;
      const trackLimit = format.kind === 'first_to' ? format.trackLimit : 20;
      const finalRuleset: Ruleset = { ...state.config.finalRuleset, format: { kind: 'first_to', winThreshold: v, trackLimit } };
      return { ...state, config: { ...state.config, finalRuleset } };
    },
  },
};

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

export function isSettingKey(key: string): key is SettingKey {
  return key in SETTINGS;
}

export function settingName(key: SettingKey): string {
  const { icon, name } = SETTINGS[key];
  return `${icon} ${name}`;
}

// Почему настройку уже не поменять; null — можно.
export function lockReason(state: TournamentState, key: SettingKey): string | null {
  if (state.phase === 'archive') return 'турнир завершён';
  return SETTINGS[key].lock(state);
}

// Строка для экрана настроек и /game.
export function settingLine(state: TournamentState, key: SettingKey): string {
  const setting = SETTINGS[key];
  const lock = lockReason(state, key);
  return `${settingName(key)}: ${setting.show(setting.value(state.config))}${lock ? ` · 🔒 ${lock}` : ''}`;
}

// Значение без замка — для нового турнира, который берёт настройки у текущего.
export function settingSummary(config: TournamentConfig, key: SettingKey): string {
  const setting = SETTINGS[key];
  return `${settingName(key)}: ${setting.show(setting.value(config))}`;
}

// Экран выбора значения: текущее, подсказка и варианты. Текущее значение из окружения может
// не совпасть ни с одним вариантом — оно всё равно в списке.
export function settingChoice(state: TournamentState, key: SettingKey): { lines: string[]; options: { label: string; value: number }[] } {
  const setting = SETTINGS[key];
  const current = setting.value(state.config);
  const lock = lockReason(state, key);
  const lines = [settingName(key), `Сейчас: ${setting.show(current)}`, '', setting.hint];
  if (lock) lines.push('', `🔒 Уже не поменять: ${lock}.`);
  const options = lock
    ? []
    : optionsOf(state, key).map((value) => {
        const label = (setting.short ?? setting.show)(value);
        const mark = value === current ? '✅ ' : setting.optionLock?.(state, value) ? '🔒 ' : '';
        return { label: `${mark}${label}`, value };
      });
  return { lines, options };
}

function optionsOf(state: TournamentState, key: SettingKey): number[] {
  const setting = SETTINGS[key];
  const current = setting.value(state.config);
  return [...new Set([...setting.options, current])].sort((a, b) => a - b);
}

// Одна точка изменения: замок проверяется при самом нажатии — две открытые панели его не обойдут.
// Изменившиеся списки песен участников правятся на месте.
export function changeSetting(state: TournamentState, actor: UserId, key: SettingKey, value: number): Step {
  const setting = SETTINGS[key];
  const lock = lockReason(state, key);
  if (lock) return toast(state, actor, `🔒 ${setting.name}: ${lock}`);
  if (!optionsOf(state, key).includes(value)) return toast(state, actor, 'Кнопка устарела');
  const optionLock = setting.optionLock?.(state, value);
  if (optionLock) return toast(state, actor, optionLock);
  const current = setting.value(state.config);
  if (value === current) return toast(state, actor, `${setting.name}: уже ${setting.show(value)}`);

  const changed = setting.apply(state, value);
  const next: TournamentState = {
    ...changed,
    panels: { ...changed.panels, [actor]: 'settings' },
    journal: [...changed.journal, `Организатор: ${setting.name.toLowerCase()} ${setting.show(current)} → ${setting.show(value)}`],
  };
  const lists = diff(renderIntake(state.intake), renderIntake(next.intake));
  return { state: next, out: [...scope(next, lists, 'i:'), { kind: 'toast', to: actor, text: `✅ ${setting.name}: ${setting.show(value)}` }] };
}

// Название меняется всегда: уже отправленные сообщения остаются со старым.
export function renameTournament(state: TournamentState, text: string): TournamentState | undefined {
  const title = text.trim().replace(/\s+/g, ' ');
  if (title.length < 2 || title.length > 48 || title.startsWith('/')) return undefined;
  return {
    ...state,
    config: { ...state.config, title },
    journal: [...state.journal, `Организатор переименовал турнир: «${state.config.title}» → «${title}»`],
  };
}

function diff(before: OutgoingMessage[], after: OutgoingMessage[]): OutgoingMessage[] {
  const previous = new Map(before.map((m) => [`${m.to}/${m.slot}`, JSON.stringify(m)]));
  return after.filter((m) => previous.get(`${m.to}/${m.slot}`) !== JSON.stringify(m));
}
