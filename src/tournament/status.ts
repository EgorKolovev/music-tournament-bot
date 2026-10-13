import { eliminated, formatDate, matchLabel, matchPlayers, qualifiedIds } from '../bot/drawSession.ts';
import { matchTitle as finalMatchTitle } from '../bot/finalSession.ts';
import { acceptedCount, isSongsOnly } from '../bot/intakeSession.ts';
import type { UserId } from '../bot/protocol.ts';
import { openMatches, playedMatches, playersOf, qualified, resolveSlot } from '../domain/bracket/bracket.ts';
import { hasLeft, matchTitle, participant, scoreLine } from './helpers.ts';
import { finalistIds } from './stages.ts';
import type { TournamentState } from './state.ts';

// Где человек сейчас: его матч, кого он судит, финал. Нужно и /status, и панели админа.

export function personalStatus(state: TournamentState, id: UserId): string[] {
  switch (state.phase) {
    case 'intake': {
      const inIntake = state.intake.config.participants.some((p) => p.id === id);
      const max = state.config.intakeRules.maxSubmissions;
      if (!inIntake) return [];
      const songs = `🎵 Песен принято: ${acceptedCount(state.intake, id)} из ${max}`;
      return isSongsOnly(state.intake, id) ? ['🎁 Ты только присылаешь песни — не играешь.', songs] : [songs];
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
  const withdrawn = state.withdrawn.includes(id) ? [hasLeft(state, id) ? '🚪 Ты вышел из турнира.' : '🚪 Ты снят с турнира.'] : [];
  if (!draw.bracket) return [...withdrawn, '🎲 Жеребьёвка ещё не проведена.'];
  const lines: string[] = [];
  if (isSongsOnly(state.intake, id)) lines.push('🎁 Твои песни в игре, сам ты не играешь.');
  if (withdrawn.length > 0) lines.push(...withdrawn);
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
export function matchProgress(state: TournamentState, matchId: string, forJudge = false): string {
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
