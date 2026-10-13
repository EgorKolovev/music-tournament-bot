import { matchLabel } from '../bot/drawSession.ts';
import { matchTitle as finalMatchTitle } from '../bot/finalSession.ts';
import type { UserId } from '../bot/protocol.ts';
import { openMatches, playedMatches, playersOf, qualified } from '../domain/bracket/bracket.ts';
import type { Sender } from './events.ts';
import { canAdmin, isOrganizer, matchTitle, message, participant, say, scoreLine } from './helpers.ts';
import { technicalResult } from './organizer.ts';
import { resendPanels, settingsText } from './panels.ts';
import { askLeave } from './leave.ts';
import { handleStart } from './registration.ts';
import { finalistIds } from './stages.ts';
import type { Phase, Step, TournamentState } from './state.ts';
import { renameTournament } from './settings.ts';
import { personalStatus } from './status.ts';

// Команды из чата: /start, /help, /status, /matches и команды организатора.

export function handleCommand(state: TournamentState, from: Sender, command: string, payload: string, at: number): Step {
  if (command === 'start') return handleStart(state, from, payload, at);
  if (command === 'help') return say(state, from.id, helpText(state, from.id));
  if (command === 'panel' && canAdmin(state, from.id)) return resendPanels(state, from.id);
  if (command === 'status') return say(state, from.id, statusText(state, from.id));
  if (command === 'matches') return say(state, from.id, matchesText(state));
  if (command === 'leave') return askLeave(state, from.id);
  if (command === 'game' && canAdmin(state, from.id)) return say(state, from.id, settingsText(state));
  if (command === 'rename' && isOrganizer(state, from.id)) return rename(state, from.id, payload);
  if (command === 'tech' && canAdmin(state, from.id)) return technicalResult(state, from.id, payload);
  if (command === 'broadcast' && canAdmin(state, from.id)) return broadcast(state, from.id, payload);
  return say(state, from.id, 'Не знаю такой команды. /help — что я умею.');
}

// /rename <название> — только организатор. Уже отправленные сообщения остаются со старым названием.
function rename(state: TournamentState, from: UserId, payload: string): Step {
  const next = renameTournament(state, payload);
  if (!next) return say(state, from, 'Формат: /rename <название>, от 2 до 48 символов.');
  return say(next, from, `✏️ Турнир теперь называется «${next.config.title}».`);
}

function broadcast(state: TournamentState, from: UserId, text: string): Step {
  if (!text.trim()) return say(state, from, 'Формат: /broadcast <текст>');
  const out = Object.keys(state.people).map((id) => message(id, `📣 ${text.trim()}`));
  return { state, out: [...out, message(from, `Отправлено: ${out.length}`)] };
}

function helpText(state: TournamentState, id: UserId): string {
  const lines = [
    'Я веду турнир: сбор песен, жеребьёвку, матчи и финал. Все действия — кнопками в сообщениях.',
    '',
    '/status — где ты сейчас',
    '/matches — кто с кем играет',
    '/leave — выйти из турнира',
  ];
  if (canAdmin(state, id)) {
    lines.push(
      '',
      'Организатору и админам:',
      '/panel — прислать панель заново',
      '/game — настройки турнира',
      '/tech <матч> <номер победителя> <причина> — технический результат (неявка, снятие)',
      '/broadcast <текст> — сообщение всем участникам',
    );
    if (isOrganizer(state, id)) lines.push('/rename <название> — переименовать турнир');
  }
  return lines.join('\n');
}

// /matches — кто с кем играет. Видят все: пары и так знают соперников и судей.
function matchesText(state: TournamentState): string {
  switch (state.phase) {
    case 'intake':
      return '🎵 Идёт сбор песен — матчей пока нет.';
    case 'qualifiers':
      return qualifierMatchesText(state);
    case 'final':
      return finalMatchesText(state);
    case 'archive': {
      const champion = state.final && qualified(state.final.bracket, state.final.results)[0];
      return `🏁 Турнир завершён${champion ? `. Победитель — ${participant(state, champion).name}` : ''}.`;
    }
  }
}

function qualifierMatchesText(state: TournamentState): string {
  const draw = state.draw!;
  if (!draw.bracket) return '🎲 Жеребьёвка ещё не проведена.';
  const all = playedMatches(draw.bracket);
  const live = all.filter((m) => state.matches[m.id] && !state.matches[m.id]!.closed);
  const waiting = openMatches(draw.bracket, draw.results).filter((m) => !live.includes(m));
  const done = all.filter((m) => draw.results[m.id]);
  const lines = [`🎤 Отбор · сыграно ${done.length} из ${all.length}`];
  if (live.length > 0) {
    lines.push('', 'Сейчас играют:');
    for (const m of live) {
      const runtime = state.matches[m.id]!;
      const dispute = runtime.dispute ? ' · ⚠️ спор' : '';
      lines.push(`🎤 ${matchLabel(m)}: ${scoreLine(runtime.session)} · судья ${runtime.session.config.judge.name}${dispute}`);
    }
  }
  if (waiting.length > 0) lines.push('', 'Ждут начала:', ...waiting.map((m) => `⏳ ${matchTitle(state, m.id)} · выбирают судью`));
  if (done.length > 0) {
    lines.push('', 'Сыграно:', ...done.map((m) => `✅ ${matchTitle(state, m.id)} → ${participant(state, draw.results[m.id]!).name}`));
  }
  if (state.withdrawn.length > 0) lines.push('', `🚪 Сняты: ${state.withdrawn.map((id) => participant(state, id).name).join(', ')}`);
  return lines.join('\n');
}

function finalMatchesText(state: TournamentState): string {
  const final = state.final;
  if (!final) {
    const names = finalistIds(state).map((id) => participant(state, id).name);
    return `🏆 Финал ещё не начался. Финалисты: ${names.join(', ')}.`;
  }
  const lines = ['🏆 Финал'];
  for (const m of playedMatches(final.bracket)) {
    const title = finalMatchTitle(final, m.id);
    const winner = final.results[m.id];
    if (winner) lines.push(`✅ ${title} → ${participant(state, winner).name}`);
    else if (final.current?.matchId === m.id) lines.push(`🎤 На сцене: ${scoreLine(final.current.session)}`);
    else if (playersOf(final.bracket, final.results, m.id)) lines.push(`⏳ ${title}`);
  }
  return lines.join('\n');
}

// /status — где человек сейчас: его матч, кого он судит; организатору — ещё сводка.
function statusText(state: TournamentState, id: UserId): string {
  const person = state.people[id];
  const phase: Record<Phase, string> = { intake: 'сбор песен', qualifiers: 'отбор', final: 'финал', archive: 'турнир завершён' };
  const lines = [`Турнир «${state.config.title}» · этап: ${phase[state.phase]}`];
  if (person) lines.push(`Ты: №${person.number}, ${person.name}`, ...personalStatus(state, id));
  else if (isOrganizer(state, id)) lines.push('Ты организатор турнира.');
  else lines.push(canAdmin(state, id) ? 'Ты админ турнира.' : 'Ты не зарегистрирован.');
  if (canAdmin(state, id)) lines.push('', ...organizerSummary(state));
  lines.push('', commandsHint(state, id));
  return lines.join('\n');
}

// Сводка для организатора и админов: где стоит турнир и что требует внимания.
function organizerSummary(state: TournamentState): string[] {
  const lines = [`👥 Участников: ${Object.keys(state.people).length}`];
  const draw = state.draw;
  if (state.phase !== 'qualifiers' || !draw?.bracket) return lines;
  const all = playedMatches(draw.bracket);
  const live = Object.values(state.matches).filter((m) => !m.closed);
  const noJudge = openMatches(draw.bracket, draw.results).filter((m) => !draw.judges[m.id]).length;
  const disputes = live.filter((m) => m.dispute).length;
  const done = all.filter((m) => draw.results[m.id]).length;
  lines.push(
    `🎤 Матчи: сыграно ${done} из ${all.length} · идут ${live.length} · без судьи ${noJudge}` +
      (disputes > 0 ? ` · ⚠️ споры: ${disputes}` : ''),
  );
  return lines;
}

function commandsHint(state: TournamentState, id: UserId): string {
  const hint = 'Команды: /matches — кто с кем играет, /help — что я умею.';
  if (isOrganizer(state, id)) return `${hint}\nОрганизатору: /panel — панель заново, /game, /rename, /tech, /broadcast — подробнее в /help.`;
  if (canAdmin(state, id)) return `${hint}\nАдмину: /panel — панель заново, /game, /tech, /broadcast — подробнее в /help.`;
  return hint;
}
