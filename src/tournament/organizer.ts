import { eliminated, matchPlayers, qualifiedIds } from '../bot/drawSession.ts';
import type { Outgoing, UserId } from '../bot/protocol.ts';
import { openMatches } from '../domain/bracket/bracket.ts';
import { matchTitle, message, participant, say, toast } from './helpers.ts';
import { closeWithResult } from './qualifiers.ts';
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
function awardTechnical(state: TournamentState, matchId: string, winner: UserId, reason: string): Step {
  const players = matchPlayers(state.draw!, matchId)!;
  const runtime = state.matches[matchId];
  const people = runtime && !runtime.closed ? [runtime.session.config.judge.id, ...players] : players;
  const note = `технический результат: ${reason}`;
  const title = matchTitle(state, matchId);
  const closed = closeWithResult(
    { ...state, journal: [...state.journal, `Организатор: ${title} — ${note}`] },
    matchId,
    winner,
    note,
  );
  const name = participant(state, winner).name;
  const notices = people.map((id) => message(id, `Матч ${title} закрыт организатором: ${note}. Проходит ${name}.`));
  return { state: closed.state, out: [...closed.out, ...notices] };
}

// Снятие с турнира: текущий матч и каждый следующий — техническое поражение снятого.
function withdraw(state: TournamentState, userId: UserId): Step {
  const name = participant(state, userId).name;
  const next: TournamentState = {
    ...state,
    withdrawn: [...state.withdrawn, userId],
    adminMenu: null,
    journal: [...state.journal, `Организатор снял с турнира: ${name}`],
  };
  const forfeits = forfeitWithdrawn(next);
  return { state: forfeits.state, out: [message(userId, '🚪 Организатор снял тебя с турнира. Спасибо за игру!'), ...forfeits.out] };
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
    const awarded = awardTechnical(next, pair.id, winner, 'соперник снят с турнира');
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
  if (data === 'techOk' && menu?.kind === 'techConfirm') {
    if (!techCandidates(state).includes(menu.matchId)) return toast(setMenu(null).state, organizer, 'Этот матч уже закрыт');
    return awardTechnical({ ...state, adminMenu: null }, menu.matchId, menu.winner, 'решение организатора');
  }
  const pick = /^withdrawPick:(.+)$/.exec(data);
  if (pick) {
    if (!withdrawCandidates(state).includes(pick[1]!)) return toast(state, organizer, 'Этого игрока снять уже нельзя');
    return setMenu({ kind: 'withdrawConfirm', userId: pick[1]! });
  }
  if (data === 'withdrawOk' && menu?.kind === 'withdrawConfirm') {
    if (!withdrawCandidates(state).includes(menu.userId)) return toast(setMenu(null).state, organizer, 'Этого игрока снять уже нельзя');
    return withdraw(state, menu.userId);
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
  const finalists = qualifiedIds(draw);
  return draw.config.players
    .map((p) => p.id)
    .filter((id) => !state.withdrawn.includes(id) && !finalists.includes(id) && !eliminated(draw, id));
}
