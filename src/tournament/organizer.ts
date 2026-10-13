import { eliminated, matchPlayers } from '../bot/drawSession.ts';
import type { Outgoing, UserId } from '../bot/protocol.ts';
import { openMatches } from '../domain/bracket/bracket.ts';
import { hasLeft, matchTitle, message, participant, say, toast } from './helpers.ts';
import { closeWithResult } from './qualifiers.ts';
import { finalistIds } from './stages.ts';
import type { AdminMenu, Step, TournamentState } from './state.ts';

// Инструменты организатора на отборе: техническая победа и снятие игрока
// (docs/decisions/2026-10-12-organizer-tools.md).

// /tech 1.3 <номер игрока> <причина> — неявка, снятие: технический результат без статистики.
export function technicalResult(state: TournamentState, from: UserId, payload: string): Step {
  const parsed = /^(\d+)\.(\d+)\s+(\d+)\s*(.*)$/s.exec(payload.trim());
  if (!parsed || !state.draw?.bracket) {
    return say(state, from, 'Формат: /tech <матч, напр. 1.3> <номер победителя> <причина>');
  }
  const matchId = `r${parsed[1]}-${parsed[2]}`;
  const winner = Object.values(state.people).find((p) => p.number === Number(parsed[3]));
  const players = matchPlayers(state.draw, matchId);
  if (!players || !winner || !players.includes(winner.id) || state.draw.results[matchId]) {
    return say(state, from, 'Не нашёл такой открытый матч с этим игроком.');
  }
  const awarded = awardTechnical(state, matchId, winner.id, parsed[4]!.trim() || 'без причины');
  return { state: awarded.state, out: [...awarded.out, message(from, 'Готово.')] };
}

// Технический результат: матч закрывается, победитель проходит дальше, участникам — уведомление.
// Снятому и вышедшему про их пары не пишем: о снятии они уже знают.
function awardTechnical(state: TournamentState, matchId: string, winner: UserId, reason: string, byOrganizer = true): Step {
  const players = matchPlayers(state.draw!, matchId)!.filter((id) => !state.withdrawn.includes(id));
  const runtime = state.matches[matchId];
  const people = runtime && !runtime.closed ? [runtime.session.config.judge.id, ...players] : players;
  const note = `технический результат: ${reason}`;
  const title = matchTitle(state, matchId);
  const closed = closeWithResult(
    { ...state, journal: [...state.journal, `${byOrganizer ? 'Организатор: ' : ''}${title} — ${note}`] },
    matchId,
    winner,
    note,
  );
  const name = participant(state, winner).name;
  const notices = people.map((id) => message(id, `Матч ${title} закрыт${byOrganizer ? ' организатором' : ''}: ${note}. Проходит ${name}.`));
  return { state: closed.state, out: [...closed.out, ...notices] };
}

// Снятие с турнира — организатором или самим игроком (/leave): текущий матч и каждый следующий —
// техническое поражение. Вышедшему сам ответ уходит в сообщении подтверждения выхода.
export function withdraw(state: TournamentState, userId: UserId, by: 'organizer' | 'self'): Step {
  const name = participant(state, userId).name;
  const self = by === 'self';
  const next: TournamentState = {
    ...state,
    withdrawn: [...state.withdrawn, userId],
    left: self ? [...(state.left ?? []), userId] : state.left,
    adminMenu: self ? state.adminMenu : null,
    journal: [...state.journal, self ? `Вышел из турнира сам: ${name}` : `Организатор снял с турнира: ${name}`],
  };
  const forfeits = forfeitWithdrawn(next);
  const notice = self ? [] : [message(userId, '🚪 Организатор снял тебя с турнира. Спасибо за игру!')];
  return { state: forfeits.state, out: [...notice, ...forfeits.out] };
}

// Пары, где есть снятый, закрываются в пользу соперника. Победа может открыть следующую пару
// с другим снятым — поэтому до тех пор, пока закрывать нечего.
export function forfeitWithdrawn(state: TournamentState): Step {
  if (state.phase !== 'qualifiers' || !state.draw?.bracket || state.withdrawn.length === 0) return { state, out: [] };
  let next = state;
  const out: Outgoing[] = [];
  for (;;) {
    const draw = next.draw!;
    const pair = openMatches(draw.bracket!, draw.results)
      .map((m) => ({ id: m.id, players: matchPlayers(draw, m.id)! }))
      .find(({ players }) => players.some((id) => next.withdrawn.includes(id)));
    if (!pair) return { state: next, out };
    // Сняты оба — дальше проходит первый и проиграет технически в следующей паре.
    const winner = pair.players.find((id) => !next.withdrawn.includes(id)) ?? pair.players[0];
    const loser = pair.players.find((id) => id !== winner)!;
    const self = hasLeft(next, loser);
    const awarded = awardTechnical(next, pair.id, winner, self ? 'соперник вышел из турнира' : 'соперник снят с турнира', !self);
    next = awarded.state;
    out.push(...awarded.out);
  }
}

// Шаги меню организатора; undefined — кнопка не из меню.
export function adminMenuButton(state: TournamentState, data: string): Step | undefined {
  const organizer = state.config.organizerId;
  const draw = state.draw;
  const setMenu = (adminMenu: AdminMenu | null): Step => ({ state: { ...state, adminMenu }, out: [] });
  const menu = state.adminMenu;

  if (data === 'menu:close') return setMenu(null);
  if (!data.startsWith('menu:') && !data.startsWith('tech') && !data.startsWith('withdraw')) return undefined;
  if (state.phase !== 'qualifiers' || !draw?.bracket) return toast(setMenu(null).state, organizer, 'Это доступно во время отбора');

  if (data === 'menu:tech') return setMenu({ kind: 'tech' });
  if (data === 'menu:withdraw') return setMenu({ kind: 'withdraw' });
  const techMatch = /^techMatch:(.+)$/.exec(data);
  if (techMatch) {
    if (!techCandidates(state).includes(techMatch[1]!)) return toast(state, organizer, 'Этот матч уже закрыт');
    return setMenu({ kind: 'techWinner', matchId: techMatch[1]! });
  }
  const techWin = /^techWin:(.+):(.+)$/.exec(data);
  if (techWin) {
    const matchId = techWin[1]!;
    const winner = techWin[2]!;
    if (!techCandidates(state).includes(matchId) || !matchPlayers(draw, matchId)!.includes(winner)) {
      return toast(setMenu(null).state, organizer, 'Этот матч уже закрыт');
    }
    return setMenu({ kind: 'techConfirm', matchId, winner });
  }
  // Подтверждения несут цель (techOk:<матч>:<победитель>, withdrawOk:<участник>); без цели — кнопки
  // прошлой версии из журнала, цель тогда берётся из меню.
  const techOk = /^techOk(?::([^:]+):(.+))?$/.exec(data);
  const confirmed = techOk && (techOk[1] ? { matchId: techOk[1], winner: techOk[2]! } : menu?.kind === 'techConfirm' ? menu : undefined);
  if (confirmed) {
    if (!techCandidates(state).includes(confirmed.matchId) || !matchPlayers(draw, confirmed.matchId)!.includes(confirmed.winner)) {
      return toast(setMenu(null).state, organizer, 'Этот матч уже закрыт');
    }
    return awardTechnical({ ...state, adminMenu: null }, confirmed.matchId, confirmed.winner, 'решение организатора');
  }
  const pick = /^withdrawPick:(.+)$/.exec(data);
  if (pick) {
    if (!withdrawCandidates(state).includes(pick[1]!)) return toast(state, organizer, 'Этого игрока снять уже нельзя');
    return setMenu({ kind: 'withdrawConfirm', userId: pick[1]! });
  }
  const withdrawOk = /^withdrawOk(?::(.+))?$/.exec(data);
  const target = withdrawOk && (withdrawOk[1] ?? (menu?.kind === 'withdrawConfirm' ? menu.userId : undefined));
  if (target) {
    if (!withdrawCandidates(state).includes(target)) return toast(setMenu(null).state, organizer, 'Этого игрока снять уже нельзя');
    return withdraw(state, target, 'organizer');
  }
  return toast(setMenu(null).state, organizer, 'Меню устарело — откройте заново');
}

// Матчи, где можно засчитать техническую победу: оба игрока известны, результата нет.
export function techCandidates(state: TournamentState): string[] {
  const draw = state.draw!;
  return openMatches(draw.bracket!, draw.results).map((m) => m.id);
}

// Кого можно снять: ещё играет в отборе — не выбыл, не снят и не прошёл в финал.
export function withdrawCandidates(state: TournamentState): UserId[] {
  const draw = state.draw!;
  const finalists = finalistIds(state);
  return draw.config.players
    .map((p) => p.id)
    .filter((id) => !state.withdrawn.includes(id) && !finalists.includes(id) && !eliminated(draw, id));
}
