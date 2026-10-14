import { eliminated, formatDate, matchLabel, matchPlayers, qualifiedIds, roundDeadline } from '../bot/drawSession.ts';
import { matchTitle as finalMatchTitle } from '../bot/finalSession.ts';
import { acceptedCount, isSongsOnly } from '../bot/intakeSession.ts';
import type { UserId } from '../bot/protocol.ts';
import { openMatches, playedMatches, playersOf, qualified, resolveSlot } from '../domain/bracket/bracket.ts';
import { hasLeft, matchTitle, participant, scoreLine, textsTo } from './helpers.ts';
import { finalistIds } from './stages.ts';
import type { TournamentState } from './state.ts';

// Где человек сейчас: его матч, кого он судит, финал. Нужно и /status, и панели админа.
// Тексты — в стиле того, кто спрашивает.

export function personalStatus(state: TournamentState, id: UserId): string[] {
  const texts = textsTo(state, id).commands.status;
  switch (state.phase) {
    case 'intake': {
      const inIntake = state.intake.config.participants.some((p) => p.id === id);
      const max = state.config.intakeRules.maxSubmissions;
      if (!inIntake) return [];
      const songs = texts.songs({ accepted: acceptedCount(state.intake, id), max });
      return isSongsOnly(state.intake, id) ? [texts.songsOnlyIntake, songs] : [songs];
    }
    case 'qualifiers':
      return qualifierStatus(state, id);
    case 'final':
      return finalStatus(state, id);
    case 'archive': {
      const champion = state.final && qualified(state.final.bracket, state.final.results)[0];
      return champion ? [texts.champion({ name: participant(state, champion).name })] : [];
    }
  }
}

function qualifierStatus(state: TournamentState, id: UserId): string[] {
  const draw = state.draw!;
  const texts = textsTo(state, id).commands.status;
  const withdrawn = state.withdrawn.includes(id) ? [hasLeft(state, id) ? texts.left : texts.removed] : [];
  if (!draw.bracket) return [...withdrawn, texts.noDraw];
  const lines: string[] = [];
  if (isSongsOnly(state.intake, id)) lines.push(texts.songsOnly);
  if (withdrawn.length > 0) lines.push(...withdrawn);
  else if (draw.config.players.some((p) => p.id === id)) lines.push(ownMatchLine(state, id));

  for (const match of playedMatches(draw.bracket)) {
    const assignment = draw.judges[match.id];
    if (assignment?.candidate !== id || draw.results[match.id]) continue;
    const runtime = state.matches[match.id];
    const title = matchTitle(state, match.id);
    if (runtime && !runtime.closed) lines.push(texts.judging({ title, progress: matchProgress(state, match.id, true, id) }));
    else if (!assignment.accepted) lines.push(texts.invited({ title }));
    else lines.push(texts.judgingWait({ title }));
  }
  return lines;
}

// Матч игрока отбора: текущая пара, ожидание соперника или итог.
function ownMatchLine(state: TournamentState, id: UserId): string {
  const draw = state.draw!;
  const bracket = draw.bracket!;
  const all = textsTo(state, id);
  const texts = all.commands.status;
  const name = (userId: UserId) => participant(state, userId).name;
  // Без сроков дату не пишем вовсе.
  const until = (round: number) => {
    const deadline = roundDeadline(draw, round);
    return deadline ? texts.until({ until: all.draw.until({ date: formatDate(deadline) }) }) : '';
  };

  const current = openMatches(bracket, draw.results).find((m) => matchPlayers(draw, m.id)!.includes(id));
  if (current) {
    const opponent = matchPlayers(draw, current.id)!.find((p) => p !== id)!;
    const progress = matchProgress(state, current.id, false, id);
    return texts.current({ match: matchLabel(current), opponent: name(opponent), until: until(current.round), progress });
  }
  if (eliminated(draw, id)) {
    const lost = playedMatches(bracket).find((m) => draw.results[m.id] && draw.results[m.id] !== id && matchPlayers(draw, m.id)?.includes(id))!;
    return texts.eliminated({ match: matchLabel(lost), winner: name(draw.results[lost.id]!) });
  }
  if (qualifiedIds(draw).includes(id)) return texts.finalist;
  const next = playedMatches(bracket).find(
    (m) => !draw.results[m.id] && m.slots.some((slot) => resolveSlot(bracket, draw.results, slot) === id),
  );
  if (!next) return texts.nextRound;
  const feeder = next.slots.find((slot) => slot.kind === 'winnerOf' && resolveSlot(bracket, draw.results, slot) === undefined);
  const from = feeder?.kind === 'winnerOf' ? texts.from({ title: matchTitle(state, feeder.matchId) }) : '';
  return texts.next({ match: matchLabel(next), from, until: until(next.round) });
}

// Шаг, на котором матч: выбор судьи, ожидание, игра, подтверждение, спор. Судье своё имя не называем.
// viewer — кто читает: в его стиле; организатору — основной.
export function matchProgress(state: TournamentState, matchId: string, forJudge = false, viewer = state.config.organizerId): string {
  const texts = textsTo(state, viewer).commands.progress;
  const runtime = state.matches[matchId];
  const assignment = state.draw!.judges[matchId];
  if (runtime && !runtime.closed) {
    const { session } = runtime;
    const judge = forJudge ? '' : texts.judge({ name: session.config.judge.name });
    if (runtime.dispute) return texts.dispute;
    if (session.match.phase.kind === 'lobby') return texts.lobby({ judge });
    if (session.match.phase.kind === 'decided') return texts.decided({ score: scoreLine(session) });
    return texts.live({ score: scoreLine(session), judge });
  }
  if (!assignment) return texts.noJudge;
  const judge = participant(state, assignment.candidate).name;
  return assignment.accepted ? texts.agreed({ judge }) : texts.waitJudge({ judge });
}

function finalStatus(state: TournamentState, id: UserId): string[] {
  const texts = textsTo(state, id).commands.status;
  const lines: string[] = [];
  if (state.finalJudge?.id === id) lines.push(texts.finalJudge);
  if (!finalistIds(state).includes(id)) return lines;
  const final = state.final;
  if (!final) return [...lines, texts.finalist];
  const mine = playedMatches(final.bracket).filter((m) => playersOf(final.bracket, final.results, m.id)?.includes(id));
  const open = mine.find((m) => !final.results[m.id]);
  if (open) {
    const onStage = final.current?.matchId === open.id ? texts.onStage({ score: scoreLine(final.current.session) }) : texts.waitStage;
    lines.push(`${texts.finalMatch({ title: finalMatchTitle(final, open.id) })}${onStage}`);
  } else if (qualified(final.bracket, final.results)[0] === id) lines.push(texts.winner);
  else if (mine.length > 0) lines.push(texts.finalOver);
  else lines.push(texts.finalWaiting);
  return lines;
}
