import { render as renderDraw } from '../bot/drawSession.ts';
import { renderStage } from '../bot/finalSession.ts';
import { render as renderIntake } from '../bot/intakeSession.ts';
import { render as renderMatch } from '../bot/matchSession.ts';
import type { OutgoingMessage, UserId } from '../bot/protocol.ts';
import { scope, scopeMatch } from './helpers.ts';
import type { TournamentState } from './state.ts';

// Сообщения этапов, которые сейчас висят у людей: вводное и список песен, карточки пар и приглашения,
// панели открытых матчей и финала. Порядок — как они появлялись в чате.
export function stageMessages(state: TournamentState): OutgoingMessage[] {
  const out = [...scope(state, renderIntake(state.intake), 'i:')];
  if (state.draw) out.push(...scope(state, renderDraw(state.draw), 'd:'));
  for (const [matchId, runtime] of Object.entries(state.matches)) {
    if (!runtime.closed) out.push(...scopeMatch(state, matchId, runtime.attempt, renderMatch(runtime.session)));
  }
  if (state.final) out.push(...scope(state, renderStage(state.final), 'f:'));
  return out.filter((o): o is OutgoingMessage => o.kind === 'message');
}

// Уже показанные сообщения правятся на месте после смены стиля или имени — только изменившиеся.
export function redrawShown(before: TournamentState, after: TournamentState): OutgoingMessage[] {
  const previous = new Map(stageMessages(before).map((m) => [`${m.to}/${m.slot}`, JSON.stringify(m)]));
  return stageMessages(after).filter((m) => previous.get(`${m.to}/${m.slot}`) !== JSON.stringify(m));
}

// Человек удалил переписку с ботом и нажал «Старт»: всё, что у него должно висеть, — заново внизу чата.
// Вводное к сбору — только пока сбор открыт: после закрытия оно уже не про то.
export function restoreChat(state: TournamentState, id: UserId): OutgoingMessage[] {
  return stageMessages(state)
    .filter((m) => m.to === id && !(state.intake.closed && m.slot === 'i:welcome'))
    .map((m) => ({ ...m, bump: true }));
}
