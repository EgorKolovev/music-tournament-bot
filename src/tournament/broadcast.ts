import { eliminated, matchPlayers } from '../bot/drawSession.ts';
import { isSongsOnly, underSubmitted } from '../bot/intakeSession.ts';
import type { Button, OutgoingMessage, UserId } from '../bot/protocol.ts';
import { openMatches } from '../domain/bracket/bracket.ts';
import { message, participant } from './helpers.ts';
import { finalistIds } from './stages.ts';
import type { TournamentState } from './state.ts';

// Рассылка из панели, раздел «✉️ Рассылка»: организатор или админ выбирает, кому писать, присылает
// текст, видит, как его получат, и отправляет. /broadcast — то же, всем участникам. Получатели
// считаются в момент отправки, а не выбора: за минуту кто-то мог найти судью или выбыть.

export type AudienceKey = 'all' | 'playing' | 'short' | 'noJudge' | 'inGame' | 'finalists';

interface Audience {
  key: AudienceKey;
  label: string;
  // null — к этому этапу группа не относится.
  ids(state: TournamentState): UserId[] | null;
}

const AUDIENCES: readonly Audience[] = [
  { key: 'all', label: '👥 Всем участникам', ids: (state) => Object.keys(state.people) },
  {
    key: 'playing',
    label: '🎤 Играющим',
    ids: (state) =>
      state.phase === 'intake' || state.phase === 'qualifiers'
        ? Object.keys(state.people).filter((id) => !isSongsOnly(state.intake, id) && !state.withdrawn.includes(id))
        : null,
  },
  {
    key: 'short',
    label: '🎵 Прислали не все песни',
    ids: (state) => (state.phase === 'intake' && !state.intake.closed ? underSubmitted(state.intake).map((p) => p.id) : null),
  },
  {
    key: 'noJudge',
    label: '⚖️ Парам без судьи',
    ids: (state) => {
      const draw = state.draw;
      if (state.phase !== 'qualifiers' || !draw?.bracket) return null;
      return openMatches(draw.bracket, draw.results)
        .filter((m) => !draw.judges[m.id])
        .flatMap((m) => matchPlayers(draw, m.id) ?? []);
    },
  },
  {
    key: 'inGame',
    label: '🎯 Ещё в турнире',
    ids: (state) => {
      const draw = state.draw;
      if (state.phase !== 'qualifiers' || !draw?.bracket) return null;
      return draw.config.players.map((p) => p.id).filter((id) => !eliminated(draw, id));
    },
  },
  {
    key: 'finalists',
    label: '🏆 Финалистам',
    ids: (state) => (state.phase === 'final' ? finalistIds(state) : null),
  },
];

// Telegram принимает до 4096 символов; запас — на пометку и предпросмотр в панели.
export const MAX_BROADCAST_CHARS = 3500;

export function isAudienceKey(key: string): key is AudienceKey {
  return AUDIENCES.some((a) => a.key === key);
}

// Кто получит сейчас: только зарегистрированные, без снятых и вышедших (кроме «всем»), без повторов.
export function recipients(state: TournamentState, key: AudienceKey): UserId[] | null {
  const ids = audience(key).ids(state);
  if (!ids) return null;
  const out = key === 'all' ? ids : ids.filter((id) => !state.withdrawn.includes(id));
  return [...new Set(out)].filter((id) => state.people[id]);
}

export function audienceLabel(key: AudienceKey): string {
  return audience(key).label;
}

// Отправить: каждому — сообщение с пометкой 📣, в журнал — кому и сколько.
export function sendBroadcast(state: TournamentState, key: AudienceKey, text: string): { state: TournamentState; out: OutgoingMessage[]; count: number } {
  const ids = recipients(state, key) ?? [];
  const out = ids.map((id) => message(id, `📣 ${text}`));
  const journal = [...state.journal, `✉️ Рассылка «${plainLabel(key)}»: ${ids.length}`];
  return { state: { ...state, journal }, out, count: ids.length };
}

// --- Экраны панели ------------------------------------------------------------------

const HOME: Button = { label: '⬅️ К турниру', data: 'o:v:home' };
const BACK: Button = { label: 'Отмена', data: 'o:v:broadcast' };

export function broadcastScreen(state: TournamentState): { text: string; buttons: Button[][] } {
  const lines = ['✉️ Рассылка', 'Сообщение придёт от бота с пометкой 📣. Кому написать?'];
  const last = state.journal.findLast((line) => line.startsWith('✉️ Рассылка «'));
  if (last) lines.push('', `Последняя: ${last.slice('✉️ Рассылка '.length)}`);
  const buttons: Button[][] = [];
  for (const { key, label } of AUDIENCES) {
    const ids = recipients(state, key);
    if (ids && ids.length > 0) buttons.push([{ label: `${label} · ${ids.length}`, data: `o:bc:${key}` }]);
  }
  if (buttons.length === 0) lines.push('', 'В турнире пока никого нет — писать некому.');
  return { text: lines.join('\n'), buttons: [...buttons, [HOME]] };
}

// Группа выбрана — бот ждёт текст сообщением.
export function audienceScreen(state: TournamentState, key: AudienceKey): { text: string; buttons: Button[][] } {
  const ids = recipients(state, key) ?? [];
  const lines = [header(key, ids.length), names(state, ids), '', 'Пришлите текст одним сообщением — перед отправкой покажу, как его получат.'];
  return { text: lines.join('\n'), buttons: [[BACK]] };
}

// Текст пришёл — предпросмотр и подтверждение.
export function confirmScreen(state: TournamentState, key: AudienceKey, text: string): { text: string; buttons: Button[][] } {
  const ids = recipients(state, key) ?? [];
  const lines = [header(key, ids.length), names(state, ids), '', 'Так получат:', `📣 ${text}`];
  const buttons: Button[][] = [
    ids.length > 0 ? [{ label: `✅ Отправить · ${ids.length}`, data: `o:bcSend:${key}` }] : [],
    [
      { label: '✏️ Другой текст', data: `o:bc:${key}` },
      { label: 'Отмена', data: BACK.data },
    ],
  ].filter((row) => row.length > 0);
  if (ids.length === 0) lines.push('', 'В этой группе сейчас никого — отправлять некому.');
  return { text: lines.join('\n'), buttons };
}

function header(key: AudienceKey, count: number): string {
  return `✉️ Рассылка · ${plainLabel(key)} — ${count}`;
}

const NAMES_SHOWN = 30;

function names(state: TournamentState, ids: UserId[]): string {
  const shown = ids.slice(0, NAMES_SHOWN).map((id) => participant(state, id).name);
  return ids.length > NAMES_SHOWN ? `${shown.join(', ')} и ещё ${ids.length - NAMES_SHOWN}` : shown.join(', ');
}

// Подпись без значка — для заголовков и журнала.
function plainLabel(key: AudienceKey): string {
  return audienceLabel(key).replace(/^\S+\s/, '');
}

function audience(key: AudienceKey): Audience {
  return AUDIENCES.find((a) => a.key === key)!;
}
