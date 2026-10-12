import { confirmedJudge, matchLabel, matchPlayers } from '../bot/drawSession.ts';
import type { Outgoing } from '../bot/protocol.ts';
import { DAY_MS, matchTitle, message, panelHolders } from './helpers.ts';
import type { Step, TournamentState } from './state.ts';

// Напоминания и сроки: трек без закрытия, неподтверждённый результат, срок круга.

const TRACK_REMINDER_MS = 60_000;

const CONFIRM_ESCALATION_MS = 10 * 60_000;

export function tick(state: TournamentState, at: number): Step {
  let next = state;
  const out: Outgoing[] = [];

  for (const [matchId, runtime] of Object.entries(state.matches)) {
    if (runtime.closed) continue;
    const { phase } = runtime.session.match;
    const { config } = runtime.session;
    let updated = runtime;
    if (phase.kind === 'track' && runtime.trackStartedAt !== undefined && !runtime.trackReminded && at - runtime.trackStartedAt >= TRACK_REMINDER_MS) {
      out.push(message(config.judge.id, `⏱ Трек идёт больше минуты — отметьте угаданное и закройте трек (матч №${config.matchNo}).`));
      updated = { ...updated, trackReminded: true };
    }
    if (phase.kind === 'decided' && runtime.decidedAt !== undefined && !runtime.confirmEscalated && at - runtime.decidedAt >= CONFIRM_ESCALATION_MS) {
      const pending = [
        !phase.judgeConfirmed && config.judge.id,
        !phase.playersConfirmed[0] && config.players[0].id,
        !phase.playersConfirmed[1] && config.players[1].id,
      ].filter((id): id is string => Boolean(id));
      for (const id of pending) out.push(message(id, `⏳ Подтвердите результат матча №${config.matchNo} — кнопка в сообщении матча выше.`));
      updated = { ...updated, confirmEscalated: true };
      next = { ...next, journal: [...next.journal, `Матч ${matchTitle(state, matchId)}: результат не подтверждён 10 минут, передано организатору`] };
    }
    if (updated !== runtime) next = { ...next, matches: { ...next.matches, [matchId]: updated } };
  }

  const draw = next.draw;
  if (next.phase === 'qualifiers' && draw?.bracket) {
    draw.deadlines.forEach((iso, index) => {
      const round = index + 1;
      const deadline = deadlineMoment(iso);
      const open = draw.bracket!.rounds[index]!.filter((m) => !m.isBye && !draw.results[m.id]);
      if (open.length === 0) return;
      if (at >= deadline - DAY_MS && at < deadline && next.remindedDeadlines[round] !== iso) {
        for (const match of open) {
          const players = matchPlayers(draw, match.id) ?? [];
          const judge = confirmedJudge(draw, match.id);
          for (const id of [...players, ...(judge ? [judge] : [])]) {
            out.push(message(id, `📅 Завтра последний день для матча ${matchLabel(match)}. Если не успеваете — напишите организатору.`));
          }
        }
        next = { ...next, remindedDeadlines: { ...next.remindedDeadlines, [round]: iso } };
      }
      if (at >= deadline && next.overdueReported[round] !== iso) {
        const list = open.map((m) => `• ${matchTitle(next, m.id)}`).join('\n');
        const text = `⌛ Срок ${round}-го круга истёк. Без результата:\n${list}\n\nПеренесите срок в панели, раздел «Сетка», или засчитайте техническую победу в «Матчах».`;
        for (const id of panelHolders(next)) out.push(message(id, text));
        next = { ...next, overdueReported: { ...next.overdueReported, [round]: iso } };
      }
    });
  }
  return { state: next, out };
}

// Срок «до 15 октября» включительно: конец дня по Москве и Тбилиси (UTC+3/+4) — 21:00 UTC.
function deadlineMoment(iso: string): number {
  return Date.parse(`${iso}T21:00:00Z`);
}
