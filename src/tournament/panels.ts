import { matchPlayers, qualifiersDone, render as renderDraw } from '../bot/drawSession.ts';
import { renderOrganizer as renderFinalOrganizer } from '../bot/finalSession.ts';
import { admittedPlayers, readyForDraw, render as renderIntake } from '../bot/intakeSession.ts';
import type { Button, Outgoing, OutgoingMessage, UserId } from '../bot/protocol.ts';
import { playedMatches, qualified } from '../domain/bracket/bracket.ts';
import { matchTitle, participant, scope, scoreLine } from './helpers.ts';
import { techCandidates, withdrawCandidates } from './organizer.ts';
import { finalistIds } from './stages.ts';
import { ORG, type MatchRuntime, type Step, type TournamentState } from './state.ts';

// Панели оркестратора у организатора: этап, споры и неподтверждённые результаты, меню технической
// победы и снятия игрока; у игроков — кнопка спора.

// Сообщения, которые рисует сам оркестратор, а не сессии этапов. Отправляются только изменившиеся.
export function renderExtras(state: TournamentState): OutgoingMessage[] {
  const out: OutgoingMessage[] = [phasePanel(state)];
  for (const [matchId, runtime] of Object.entries(state.matches)) {
    if (runtime.decidedAt === undefined) continue;
    const { config, match } = runtime.session;
    const { phase } = match;
    config.players.forEach((player, slot) => {
      const confirmed = (phase.kind === 'decided' && phase.playersConfirmed[slot]) || phase.kind === 'finished';
      let text: string;
      let buttons: Button[][] | undefined;
      if (runtime.dispute) text = runtime.dispute.by === player.id ? '⚠️ Спор передан организатору.' : '⚠️ Соперник оспорил результат — решает организатор.';
      else if (runtime.closed || confirmed) text = `Матч №${config.matchNo}: результат зафиксирован.`;
      else {
        text = `Не согласен с результатом матча №${config.matchNo}? Организатор разберётся.`;
        buttons = [[{ label: '⚠️ Оспорить', data: `x:dispute:${matchId}` }]];
      }
      out.push({ kind: 'message', to: player.id, slot: `x:${matchId}#${runtime.attempt}`, text, buttons });
    });
    if (runtime.dispute || runtime.confirmEscalated) out.push(issuePanel(state, matchId, runtime));
  }
  return out;
}

function issuePanel(state: TournamentState, matchId: string, runtime: MatchRuntime): OutgoingMessage {
  const { config, match } = runtime.session;
  const { phase } = match;
  const title = matchTitle(state, matchId);
  const score = scoreLine(runtime.session);
  const lines = [runtime.dispute ? `⚠️ Спор по матчу ${title}` : `⏳ Результат матча ${title} не подтверждён 10 минут`, score];
  if (runtime.dispute) lines.push(`Оспорил: ${participant(state, runtime.dispute.by).name}. Судья: ${config.judge.name}.`);
  let buttons: Button[][] | undefined;
  if (runtime.closed) lines.push('', '✅ Решено.');
  else if (phase.kind === 'decided' || phase.kind === 'finished') {
    lines.push('', `По протоколу побеждает ${config.players[phase.winner].name}.`);
    buttons = [
      [{ label: '✅ Оставить результат', data: `o:keep:${matchId}` }],
      [{ label: '🔁 Переиграть матч', data: `o:replay:${matchId}` }],
    ];
  }
  return { kind: 'message', to: state.config.organizerId, slot: `o:issue:${matchId}#${runtime.attempt}`, text: lines.join('\n'), buttons };
}

function phasePanel(state: TournamentState): OutgoingMessage {
  const { config } = state;
  const people = Object.values(state.people);
  const lines = [`📣 ${config.title}`, ''];
  const buttons: Button[][] = [];
  switch (state.phase) {
    case 'intake': {
      lines.push(
        'Этап: регистрация и сбор песен',
        `Ссылка-приглашение: https://t.me/${config.botUsername}?start=t_${config.code}`,
        `Зарегистрировано: ${people.length}`,
      );
      if (readyForDraw(state.intake)) {
        lines.push('', `Допущено к жеребьёвке: ${admittedPlayers(state.intake).length}, финалистов: ${config.finalists}`);
        buttons.push([{ label: '🎲 К жеребьёвке', data: 'o:toDraw' }]);
      }
      break;
    }
    case 'qualifiers': {
      const draw = state.draw!;
      const total = draw.bracket ? playedMatches(draw.bracket).length : 0;
      const played = Object.keys(draw.results).length;
      lines.push('Этап: отбор', draw.bracket ? `Сыграно матчей: ${played} из ${total}` : 'Жеребьёвка ещё не проведена');
      const live = Object.entries(state.matches).filter(([, m]) => !m.closed);
      for (const [matchId, runtime] of live) lines.push(`🎤 ${matchTitle(state, matchId)} · ${scoreLine(runtime.session)}`);
      if (state.withdrawn.length > 0) lines.push(`🚪 Сняты: ${state.withdrawn.map((id) => participant(state, id).name).join(', ')}`);
      lines.push('', 'Команды: /tech — технический результат с причиной, /broadcast — сообщение всем.');
      if (draw.bracket && qualifiersDone(draw)) buttons.push([{ label: '🏆 Отбор завершён — к финалу', data: 'o:toFinal' }]);
      else if (draw.bracket) adminMenuPanel(state, lines, buttons);
      break;
    }
    case 'final': {
      lines.push('Этап: финал', `Финалисты: ${finalistIds(state).map((id) => participant(state, id).name).join(', ')}`);
      if (!state.final) {
        lines.push(
          state.finalJudge
            ? `Судья финала: ${state.finalJudge.name}`
            : `Судья финала не назначен. Отправьте ему ссылку: https://t.me/${config.botUsername}?start=fjudge_${config.code}`,
        );
        if (state.finalJudge) buttons.push([{ label: '▶️ Открыть финал', data: 'o:openFinal' }]);
      } else if (qualified(state.final.bracket, state.final.results)[0]) {
        buttons.push([{ label: '🏁 Завершить турнир', data: 'o:archive' }]);
      }
      break;
    }
    case 'archive':
      lines.push('🏁 Турнир завершён.');
      break;
  }
  return { kind: 'message', to: config.organizerId, slot: 'o:phase', text: lines.join('\n'), buttons: buttons.length ? buttons : undefined };
}

// Меню технической победы и снятия игрока под панелью этапа.
function adminMenuPanel(state: TournamentState, lines: string[], buttons: Button[][]): void {
  const menu = state.adminMenu;
  const cancel = [{ label: 'Отмена', data: 'o:menu:close' }];
  const name = (id: UserId) => participant(state, id).name;
  if (!menu) {
    buttons.push([
      { label: '⚖️ Техническая победа', data: 'o:menu:tech' },
      { label: '🚪 Снять игрока', data: 'o:menu:withdraw' },
    ]);
    return;
  }
  lines.push('');
  switch (menu.kind) {
    case 'tech': {
      const matches = techCandidates(state);
      lines.push(matches.length ? '⚖️ Техническая победа — в каком матче?' : '⚖️ Сейчас нет матчей, где известны оба игрока.');
      for (const id of matches) buttons.push([{ label: matchTitle(state, id), data: `o:techMatch:${id}` }]);
      break;
    }
    case 'techWinner':
      lines.push(`⚖️ ${matchTitle(state, menu.matchId)} — кому засчитать победу?`);
      buttons.push(matchPlayers(state.draw!, menu.matchId)!.map((id) => ({ label: `🏆 ${name(id)}`, data: `o:techWin:${menu.matchId}:${id}` })));
      break;
    case 'techConfirm':
      lines.push(`⚖️ Засчитать техническую победу: ${name(menu.winner)}, матч ${matchTitle(state, menu.matchId)}?`, 'Матч закроется, отменить нельзя.');
      buttons.push([{ label: '✅ Засчитать', data: 'o:techOk' }]);
      break;
    case 'withdraw': {
      const players = withdrawCandidates(state);
      lines.push(players.length ? '🚪 Кого снять с турнира?' : '🚪 Снимать некого: все выбыли или уже в финале.');
      for (const id of players) buttons.push([{ label: `№${state.people[id]!.number} ${name(id)}`, data: `o:withdrawPick:${id}` }]);
      break;
    }
    case 'withdrawConfirm':
      lines.push(
        `🚪 Снять ${name(menu.userId)} с турнира?`,
        'Текущий матч засчитается сопернику, в каждом следующем — техническое поражение. Отменить нельзя.',
      );
      buttons.push([{ label: '🚪 Снять', data: 'o:withdrawOk' }]);
      break;
  }
  buttons.push(cancel);
}

// Организатор потерял панели в ленте — присылаем их заново внизу.
export function resendPanels(state: TournamentState): Step {
  const own = (messages: OutgoingMessage[], prefix: string) => scope(state, messages.filter((m) => m.to === ORG), prefix);
  let panels: Outgoing[] = [];
  if (state.phase === 'intake') panels = own(renderIntake(state.intake), 'i:');
  else if (state.phase === 'qualifiers' && state.draw) panels = own(renderDraw(state.draw), 'd:');
  else if (state.phase === 'final' && state.final) panels = scope(state, [renderFinalOrganizer(state.final)], 'f:');
  const all = [...panels, phasePanel(state)].map((m) => (m.kind === 'message' ? { ...m, bump: true } : m));
  return { state, out: all };
}
