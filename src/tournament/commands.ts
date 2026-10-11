import { eliminated, formatDate, matchLabel, matchPlayers, qualifiedIds } from '../bot/drawSession.ts';
import { matchTitle as finalMatchTitle } from '../bot/finalSession.ts';
import { acceptedCount } from '../bot/intakeSession.ts';
import type { UserId } from '../bot/protocol.ts';
import { openMatches, playedMatches, playersOf, qualified, resolveSlot } from '../domain/bracket/bracket.ts';
import type { Sender } from './events.ts';
import { canAdmin, isOrganizer, matchTitle, message, participant, say, scoreLine } from './helpers.ts';
import { technicalResult } from './organizer.ts';
import { resendPanels } from './panels.ts';
import { handleStart } from './registration.ts';
import { finalistIds } from './stages.ts';
import type { Phase, Step, TournamentState } from './state.ts';

// Команды из чата: /start, /help, /status, /matches и команды организатора.

export function handleCommand(state: TournamentState, from: Sender, command: string, payload: string, at: number): Step {
  if (command === 'start') return handleStart(state, from, payload, at);
  if (command === 'help') return say(state, from.id, helpText(state, from.id));
  if (command === 'panel' && isOrganizer(state, from.id)) return resendPanels(state);
  if (command === 'status') return say(state, from.id, statusText(state, from.id));
  if (command === 'matches') return say(state, from.id, matchesText(state));
  if (command === 'tech' && canAdmin(state, from.id)) return technicalResult(state, from.id, payload);
  if (command === 'broadcast' && canAdmin(state, from.id)) return broadcast(state, from.id, payload);
  return say(state, from.id, 'Не знаю такой команды. /help — что я умею.');
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
  ];
  if (canAdmin(state, id)) {
    lines.push(
      '',
      'Организатору:',
      '/panel — прислать панели заново',
      '/tech <матч> <номер победителя> <причина> — технический результат (неявка, снятие)',
      '/broadcast <текст> — сообщение всем участникам',
    );
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
  else lines.push(isOrganizer(state, id) ? 'Ты организатор турнира.' : 'Ты не зарегистрирован.');
  if (canAdmin(state, id)) lines.push('', ...organizerSummary(state));
  lines.push('', commandsHint(state, id));
  return lines.join('\n');
}

function personalStatus(state: TournamentState, id: UserId): string[] {
  switch (state.phase) {
    case 'intake': {
      const playing = state.intake.config.participants.some((p) => p.id === id);
      const max = state.config.intakeRules.maxSubmissions;
      return playing ? [`🎵 Песен принято: ${acceptedCount(state.intake, id)} из ${max}`] : [];
    }
    case 'qualifiers':
      return qualifierStatus(state, id);
    case 'final':
      return finalStatus(state, id);
    case 'archive': {
      const champion = state.final && qualified(state.final.bracket, state.final.results)[0];
      return champion ? [`🏁 Победитель — ${participant(state, champion).name}`] : [];
    }
  }
}

function qualifierStatus(state: TournamentState, id: UserId): string[] {
  const draw = state.draw!;
  if (!draw.bracket) return ['🎲 Жеребьёвка ещё не проведена.'];
  const lines: string[] = [];
  if (state.withdrawn.includes(id)) lines.push('🚪 Ты снят с турнира.');
  else if (draw.config.players.some((p) => p.id === id)) lines.push(ownMatchLine(state, id));

  for (const match of playedMatches(draw.bracket)) {
    const assignment = draw.judges[match.id];
    if (assignment?.candidate !== id || draw.results[match.id]) continue;
    const runtime = state.matches[match.id];
    const title = matchTitle(state, match.id);
    if (runtime && !runtime.closed) lines.push(`⚖️ Судишь ${title}: ${matchProgress(state, match.id, true)}`);
    else if (!assignment.accepted) lines.push(`⚖️ Тебя зовут судить ${title} — ответь в приглашении.`);
    else lines.push(`⚖️ Судишь ${title}: ждём, пока пара подтвердит судью.`);
  }
  return lines;
}

// Матч игрока отбора: текущая пара, ожидание соперника или итог.
function ownMatchLine(state: TournamentState, id: UserId): string {
  const draw = state.draw!;
  const bracket = draw.bracket!;
  const name = (userId: UserId) => participant(state, userId).name;
  const deadline = (round: number) => formatDate(draw.deadlines[round - 1]!);

  const current = openMatches(bracket, draw.results).find((m) => matchPlayers(draw, m.id)!.includes(id));
  if (current) {
    const opponent = matchPlayers(draw, current.id)!.find((p) => p !== id)!;
    return `🎤 Твой матч ${matchLabel(current)}, соперник — ${name(opponent)}, до ${deadline(current.round)}: ${matchProgress(state, current.id)}`;
  }
  if (eliminated(draw, id)) {
    const lost = playedMatches(bracket).find((m) => draw.results[m.id] && draw.results[m.id] !== id && matchPlayers(draw, m.id)?.includes(id))!;
    return `Отбор для тебя закончен: в ${matchLabel(lost)} дальше проходит ${name(draw.results[lost.id]!)}.`;
  }
  if (qualifiedIds(draw).includes(id)) return '🏆 Ты в финале! Организатор сообщит дату и место.';
  const next = playedMatches(bracket).find(
    (m) => !draw.results[m.id] && m.slots.some((slot) => resolveSlot(bracket, draw.results, slot) === id),
  );
  if (!next) return '⏳ Ждёшь следующего круга.';
  const feeder = next.slots.find((slot) => slot.kind === 'winnerOf' && resolveSlot(bracket, draw.results, slot) === undefined);
  const from = feeder?.kind === 'winnerOf' ? ` — соперник определится в ${matchTitle(state, feeder.matchId)}` : '';
  return `⏳ Твой следующий матч ${matchLabel(next)}${from}, до ${deadline(next.round)}.`;
}

// Шаг, на котором матч: выбор судьи, ожидание, игра, подтверждение, спор. Судье своё имя не называем.
function matchProgress(state: TournamentState, matchId: string, forJudge = false): string {
  const runtime = state.matches[matchId];
  const assignment = state.draw!.judges[matchId];
  if (runtime && !runtime.closed) {
    const { session } = runtime;
    const judge = forJudge ? '' : `, судья ${session.config.judge.name}`;
    if (runtime.dispute) return 'спор — решает организатор';
    if (session.match.phase.kind === 'lobby') return `ждём «Все на месте»${judge}`;
    if (session.match.phase.kind === 'decided') return `сыгран, ${scoreLine(session)} — ждём подтверждения результата`;
    return `идёт, ${scoreLine(session)}${judge}`;
  }
  if (!assignment) return 'нужно выбрать судью — кнопка в карточке пары';
  const judge = participant(state, assignment.candidate).name;
  return assignment.accepted ? `судья ${judge} согласен — ждём подтверждения пары` : `ждём ответа судьи ${judge}`;
}

function finalStatus(state: TournamentState, id: UserId): string[] {
  const lines: string[] = [];
  if (state.finalJudge?.id === id) lines.push('⚖️ Ты судья финала.');
  if (!finalistIds(state).includes(id)) return lines;
  const final = state.final;
  if (!final) return [...lines, '🏆 Ты в финале! Организатор сообщит дату и место.'];
  const mine = playedMatches(final.bracket).filter((m) => playersOf(final.bracket, final.results, m.id)?.includes(id));
  const open = mine.find((m) => !final.results[m.id]);
  if (open) {
    const onStage = final.current?.matchId === open.id ? ` — на сцене, ${scoreLine(final.current.session)}` : ' — ждёт выхода на сцену';
    lines.push(`🏆 ${finalMatchTitle(final, open.id)}${onStage}`);
  } else if (qualified(final.bracket, final.results)[0] === id) lines.push('🏆 Ты победитель турнира!');
  else if (mine.length > 0) lines.push('Финал для тебя закончен. Спасибо за игру!');
  else lines.push('🏆 Ты в финале — соперник ещё определяется.');
  return lines;
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
  if (isOrganizer(state, id)) return `${hint}\nОрганизатору: /panel — панели заново, /tech, /broadcast — подробнее в /help.`;
  if (canAdmin(state, id)) return `${hint}\nАдмину: /tech, /broadcast — подробнее в /help.`;
  return hint;
}
