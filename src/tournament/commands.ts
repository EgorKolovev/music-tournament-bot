import { matchLabel } from '../bot/drawSession.ts';
import { matchTitle as finalMatchTitle } from '../bot/finalSession.ts';
import type { UserId } from '../bot/protocol.ts';
import { openMatches, playedMatches, playersOf, qualified } from '../domain/bracket/bracket.ts';
import { sendBroadcast } from './broadcast.ts';
import type { Sender } from './events.ts';
import { canAdmin, isOrganizer, matchTitle, message, participant, say, scoreLine, textsTo } from './helpers.ts';
import { technicalResult } from './organizer.ts';
import { resendPanels, settingsText } from './panels.ts';
import { askLeave } from './leave.ts';
import { askName } from './name.ts';
import { handleStart } from './registration.ts';
import { finalistIds } from './stages.ts';
import type { Step, TournamentState } from './state.ts';
import { renameTournament } from './settings.ts';
import { askStyle } from './style.ts';
import { personalStatus } from './status.ts';

// Команды из чата: /start, /help, /status, /matches, /name, /style, /leave и команды организатора.

export function handleCommand(state: TournamentState, from: Sender, command: string, payload: string, at: number): Step {
  if (command === 'start') return handleStart(state, from, payload, at);
  if (command === 'help') return say(state, from.id, helpText(state, from.id));
  if (command === 'panel' && canAdmin(state, from.id)) return resendPanels(state, from.id);
  if (command === 'status') return say(state, from.id, statusText(state, from.id));
  if (command === 'matches') return say(state, from.id, matchesText(state, from.id));
  if (command === 'leave') return askLeave(state, from.id);
  if (command === 'style') return askStyle(state, from.id);
  if (command === 'name') return askName(state, from.id, payload);
  if (command === 'game' && canAdmin(state, from.id)) return say(state, from.id, settingsText(state));
  if (command === 'rename' && isOrganizer(state, from.id)) return rename(state, from.id, payload);
  if (command === 'tech' && canAdmin(state, from.id)) return technicalResult(state, from.id, payload);
  if (command === 'broadcast' && canAdmin(state, from.id)) return broadcast(state, from.id, payload);
  const texts = textsTo(state, from.id).commands;
  return say(state, from.id, [texts.unknown({ command }), texts.helpRef].filter(Boolean).join(' '));
}

// /rename <название> — только организатор. Уже отправленные сообщения остаются со старым названием.
function rename(state: TournamentState, from: UserId, payload: string): Step {
  const next = renameTournament(state, payload);
  if (!next) return say(state, from, 'Формат: /rename <название>, от 2 до 48 символов.');
  return say(next, from, `✏️ Турнир теперь называется «${next.config.title}».`);
}

// Всем участникам — то же, что «✉️ Рассылка» → «Всем участникам» в панели.
function broadcast(state: TournamentState, from: UserId, text: string): Step {
  if (!text.trim()) return say(state, from, 'Формат: /broadcast <текст>. Выбрать, кому писать, — в панели, «✉️ Рассылка».');
  const sent = sendBroadcast(state, 'all', text.trim());
  return { state: sent.state, out: [...sent.out, message(from, `Отправлено: ${sent.count}`)] };
}

function helpText(state: TournamentState, id: UserId): string {
  const { help } = textsTo(state, id).commands;
  const lines = [help.intro, '', help.status, help.matches, help.name, help.style, help.leave];
  if (canAdmin(state, id)) {
    lines.push(
      '',
      'Организатору и админам:',
      '/panel — прислать панель заново',
      '/game — настройки турнира',
      '/tech <матч> <номер победителя> <причина> — технический результат (неявка, снятие)',
      '/broadcast <текст> — сообщение всем участникам; выбрать, кому, — «✉️ Рассылка» в панели',
    );
    if (isOrganizer(state, id)) lines.push('/rename <название> — переименовать турнир');
  }
  return lines.join('\n');
}

// /matches — кто с кем играет. Видят все: пары и так знают соперников и судей.
function matchesText(state: TournamentState, viewer: UserId): string {
  const texts = textsTo(state, viewer).commands.matches;
  switch (state.phase) {
    case 'intake':
      return texts.intake;
    case 'qualifiers':
      return qualifierMatchesText(state, viewer);
    case 'final':
      return finalMatchesText(state, viewer);
    case 'archive': {
      const champion = state.final && qualified(state.final.bracket, state.final.results)[0];
      return texts.finished({ champion: champion ? participant(state, champion).name : undefined });
    }
  }
}

function qualifierMatchesText(state: TournamentState, viewer: UserId): string {
  const texts = textsTo(state, viewer).commands.matches;
  const draw = state.draw!;
  if (!draw.bracket) return texts.noDraw;
  const all = playedMatches(draw.bracket);
  const live = all.filter((m) => state.matches[m.id] && !state.matches[m.id]!.closed);
  const waiting = openMatches(draw.bracket, draw.results).filter((m) => !live.includes(m));
  const done = all.filter((m) => draw.results[m.id]);
  const lines = [texts.qualifiers({ done: done.length, all: all.length })];
  if (live.length > 0) {
    lines.push('', texts.live);
    for (const m of live) {
      const { session, dispute } = state.matches[m.id]!;
      lines.push(texts.liveMatch({ match: matchLabel(m), score: scoreLine(session), judge: session.config.judge.name, dispute: Boolean(dispute) }));
    }
  }
  if (waiting.length > 0) lines.push('', texts.waiting, ...waiting.map((m) => texts.waitingMatch({ title: matchTitle(state, m.id) })));
  if (done.length > 0) {
    const winner = (matchId: string) => participant(state, draw.results[matchId]!).name;
    lines.push('', texts.done, ...done.map((m) => texts.doneMatch({ title: matchTitle(state, m.id), winner: winner(m.id) })));
  }
  if (state.withdrawn.length > 0) lines.push('', texts.out({ names: state.withdrawn.map((id) => participant(state, id).name).join(', ') }));
  return lines.join('\n');
}

function finalMatchesText(state: TournamentState, viewer: UserId): string {
  const texts = textsTo(state, viewer).commands.matches;
  const final = state.final;
  if (!final) return texts.finalNotStarted({ names: finalistIds(state).map((id) => participant(state, id).name).join(', ') });
  const lines = [texts.final];
  for (const m of playedMatches(final.bracket)) {
    const title = finalMatchTitle(final, m.id);
    const winner = final.results[m.id];
    if (winner) lines.push(texts.doneMatch({ title, winner: participant(state, winner).name }));
    else if (final.current?.matchId === m.id) lines.push(texts.onStage({ score: scoreLine(final.current.session) }));
    else if (playersOf(final.bracket, final.results, m.id)) lines.push(texts.finalWaiting({ title }));
  }
  return lines.join('\n');
}

// /status — где человек сейчас: его матч, кого он судит; организатору — ещё сводка.
function statusText(state: TournamentState, id: UserId): string {
  const person = state.people[id];
  const texts = textsTo(state, id).commands.status;
  const lines = [texts.header({ title: state.config.title, phase: texts.phases[state.phase] })];
  if (person) lines.push(texts.you({ number: person.number, name: person.name }), ...personalStatus(state, id));
  else if (isOrganizer(state, id)) lines.push(texts.organizer);
  else lines.push(canAdmin(state, id) ? texts.admin : texts.stranger);
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
  const { hint } = textsTo(state, id).commands;
  if (isOrganizer(state, id)) return `${hint}\nОрганизатору: /panel — панель заново, /game, /rename, /tech, /broadcast — подробнее в /help.`;
  if (canAdmin(state, id)) return `${hint}\nАдмину: /panel — панель заново, /game, /tech, /broadcast — подробнее в /help.`;
  return hint;
}
