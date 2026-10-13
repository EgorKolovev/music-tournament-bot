import { openDrawSession, qualifiedIds, qualifiersDone } from '../bot/drawSession.ts';
import { openFinalSession } from '../bot/finalSession.ts';
import { admittedPlayers, readyForDraw } from '../bot/intakeSession.ts';
import type { LibrarySong } from '../bot/matchSession.ts';
import type { UserId } from '../bot/protocol.ts';
import { buildQualifierBracket, qualified } from '../domain/bracket/bracket.ts';
import { acceptedSongs } from '../domain/submission/intake.ts';
import { DAY_MS, isoDate, message, participant, scope, toast } from './helpers.ts';
import { ORG, type Step, type TournamentState } from './state.ts';

// Переходы этапов: сбор → жеребьёвка и отбор → финал → архив.

export function openDraw(state: TournamentState, at: number): Step {
  const { config } = state;
  if (state.phase !== 'intake' || !readyForDraw(state.intake)) {
    return toast(state, config.organizerId, 'Сначала закройте сбор и решите по недобравшим');
  }
  const players = admittedPlayers(state.intake);
  if (players.length < config.finalists) {
    return toast(state, config.organizerId, `Игроков ${players.length}, а финалистов должно быть ${config.finalists}`);
  }
  const rounds = buildQualifierBracket(
    players.map((p) => p.id),
    config.finalists,
    config.seed,
  ).rounds.length;
  const deadlines = Array.from({ length: rounds }, (_, i) => isoDate(at + (i + 1) * config.roundDays * DAY_MS));
  const people = Object.values(state.people);
  const opened = openDrawSession({
    players,
    registered: people.map((p) => ({ id: p.id, name: p.name })),
    usernames: Object.fromEntries(people.filter((p) => p.username).map((p) => [p.id, `@${p.username}`])),
    organizer: { id: ORG, name: 'Организатор' },
    finalists: config.finalists,
    seed: config.seed,
    deadlines,
    botUsername: config.botUsername,
  });
  const next: TournamentState = {
    ...state,
    phase: 'qualifiers',
    draw: opened.session,
    journal: [...state.journal, `Сбор закрыт: ${players.length} игроков допущено`],
  };
  return { state: next, out: scope(next, opened.out, 'd:') };
}

export function toFinal(state: TournamentState): Step {
  if (state.phase !== 'qualifiers' || !state.draw || !qualifiersDone(state.draw)) {
    return toast(state, state.config.organizerId, 'Отбор ещё не закончен');
  }
  const out = finalistIds(state).map((id) => message(id, '🏆 Ты в финале! Организатор сообщит дату и место.'));
  return { state: { ...state, phase: 'final', journal: [...state.journal, 'Отбор завершён, финалисты определены'] }, out };
}

export function openFinal(state: TournamentState): Step {
  const organizer = state.config.organizerId;
  if (state.phase !== 'final' || state.final) return toast(state, organizer, 'Финал уже открыт');
  if (!state.finalJudge) return toast(state, organizer, 'Сначала назначьте судью финала');
  const split = state.intake.closed!.split;
  const opened = openFinalSession({
    finalists: finalistIds(state).map((id) => participant(state, id)),
    judge: state.finalJudge,
    organizer: { id: ORG, name: 'Организатор' },
    library: libraryOf(state, split.final),
    ruleset: state.config.finalRuleset,
    seed: state.config.seed + 7,
  });
  const next = { ...state, final: opened.session, journal: [...state.journal, 'Финал открыт'] };
  return { state: next, out: scope(next, opened.out, 'f:') };
}

export function archive(state: TournamentState): Step {
  const champion = state.final && qualified(state.final.bracket, state.final.results)[0];
  if (!champion) return toast(state, state.config.organizerId, 'Финал ещё не сыгран');
  const name = participant(state, champion).name;
  const next: TournamentState = { ...state, phase: 'archive', journal: [...state.journal, `Турнир завершён, победитель ${name}`] };
  const out = Object.keys(state.people).map((id) => message(id, `🏁 Турнир «${state.config.title}» завершён. Победитель — ${name}! Спасибо за игру.`));
  return { state: next, out };
}

export function finalistIds(state: TournamentState): UserId[] {
  return state.draw ? qualifiedIds(state.draw) : [];
}

// Песни пула для матча: id — музыкальная идентичность, авторы — все, кто её присылал.
// Звучит заявка, у которой есть игровая версия; без нарезки — первая, судья включает её сам с её начала.
export function libraryOf(state: TournamentState, keys: readonly string[]): LibrarySong[] {
  const { submissions } = state.intake.intake;
  const songs = new Map(acceptedSongs(state.intake.intake).map((s) => [s.key, s]));
  return keys.flatMap((key) => {
    const song = songs.get(key);
    if (!song) return [];
    const own = song.submissionIds.map((id) => submissions.find((s) => s.id === id)!);
    const source = own.find((s) => s.gameFileId) ?? own[0]!;
    return [
      {
        id: key,
        artist: song.meta.artist,
        title: song.meta.title,
        ownerIds: song.knownBy,
        audioFileId: source.gameFileId,
        startSec: source.startSec,
      },
    ];
  });
}
