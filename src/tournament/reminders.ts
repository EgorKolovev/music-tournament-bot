import { confirmedJudge, matchLabel, matchPlayers } from '../bot/drawSession.ts';
import type { Outgoing } from '../bot/protocol.ts';
import { DAY_MS, matchTitle, message, MSK_OFFSET_MS, panelHolders, participant, textsTo } from './helpers.ts';
import type { Step, TournamentState } from './state.ts';

// Напоминания и сроки: трек без закрытия, неподтверждённый результат, срок круга (если он есть).

const TRACK_REMINDER_MS = 60_000;

const CONFIRM_ESCALATION_MS = 10 * 60_000;

// О сроке круга пишем в 10 утра по Москве, не ночью: в последний день — паре и судье,
// на следующее утро — организатору, если матчи так и не сыграны.
const MORNING_MS = 10 * 3_600_000;

export function tick(state: TournamentState, at: number): Step {
  let next = state;
  const out: Outgoing[] = [];

  for (const [matchId, runtime] of Object.entries(state.matches)) {
    if (runtime.closed) continue;
    const { phase } = runtime.session.match;
    const { config } = runtime.session;
    let updated = runtime;
    if (phase.kind === 'track' && runtime.trackStartedAt !== undefined && !runtime.trackReminded && at - runtime.trackStartedAt >= TRACK_REMINDER_MS) {
      out.push(message(config.judge.id, textsTo(state, config.judge.id).events.reminders.track({ match: config.matchNo })));
      updated = { ...updated, trackReminded: true };
    }
    if (phase.kind === 'decided' && runtime.decidedAt !== undefined && !runtime.confirmEscalated && at - runtime.decidedAt >= CONFIRM_ESCALATION_MS) {
      const pending = [
        !phase.judgeConfirmed && config.judge.id,
        !phase.playersConfirmed[0] && config.players[0].id,
        !phase.playersConfirmed[1] && config.players[1].id,
      ].filter((id): id is string => Boolean(id));
      for (const id of pending) out.push(message(id, textsTo(state, id).events.reminders.confirm({ match: config.matchNo })));
      updated = { ...updated, confirmEscalated: true };
      next = { ...next, journal: [...next.journal, `Матч ${matchTitle(state, matchId)}: результат не подтверждён 10 минут, передано организатору`] };
    }
    if (updated !== runtime) next = { ...next, matches: { ...next.matches, [matchId]: updated } };
  }

  const draw = next.draw;
  if (next.phase === 'qualifiers' && draw?.bracket) {
    draw.deadlines.forEach((iso, index) => {
      const round = index + 1;
      const end = deadlineEnd(iso);
      const open = draw.bracket!.rounds[index]!.filter((m) => !m.isBye && !draw.results[m.id]);
      if (open.length === 0) return;
      if (at >= end - DAY_MS + MORNING_MS && at < end && next.remindedDeadlines[round] !== iso) {
        for (const match of open) {
          const players = matchPlayers(draw, match.id) ?? [];
          const name = (id: string) => participant(next, id).name;
          for (const id of players) {
            const opponent = players.find((p) => p !== id);
            const text = textsTo(next, id).events.reminders.lastDay({ match: matchLabel(match), opponent: opponent && name(opponent) });
            out.push(message(id, text));
          }
          const judge = confirmedJudge(draw, match.id);
          if (judge) {
            const text = textsTo(next, judge).events.reminders.lastDayJudge({ match: matchLabel(match), pair: players.map(name).join(' — ') });
            out.push(message(judge, text));
          }
        }
        next = { ...next, remindedDeadlines: { ...next.remindedDeadlines, [round]: iso } };
      }
      if (at >= end + MORNING_MS && next.overdueReported[round] !== iso) {
        const list = open.map((m) => `• ${matchTitle(next, m.id)}`).join('\n');
        const text = `⌛ ${round}-й круг закончился, а эти матчи так и не сыграны:\n${list}\n\nМожно продлить круг на два дня в «Сетке» или засчитать техническую победу в «Матчах».`;
        for (const id of panelHolders(next)) out.push(message(id, text));
        next = { ...next, overdueReported: { ...next.overdueReported, [round]: iso } };
      }
    });
  }
  return { state: next, out };
}

// Срок «до 15 октября» включительно: круг заканчивается в полночь с 15-го на 16-е по Москве.
function deadlineEnd(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`) + DAY_MS - MSK_OFFSET_MS;
}
