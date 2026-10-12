import { eliminated, qualifiedIds } from '../bot/drawSession.ts';
import { isSongsOnly, leaveIntake } from '../bot/intakeSession.ts';
import type { Button, Outgoing, OutgoingMessage, UserId } from '../bot/protocol.ts';
import { isParticipant, message, panelHolders, say, scope, toast } from './helpers.ts';
import { leaveTournament } from './organizer.ts';
import { finalistIds } from './stages.ts';
import type { Step, TournamentState } from './state.ts';

// Участник сам выходит из турнира (/leave): подтверждение, затем то же, что снятие админом.
// На сборе выход — «только песни»: присланные песни остаются в пулах, вернуться можно до закрытия
// сбора. После сбора выход необратим — поэтому второй шаг: «вернуться будет нельзя». До жеребьёвки
// участник просто не попадает в сетку. Финал очный: финалист выходит только через организатора.

const SLOT = 'l:confirm';
const FINALIST = 'Ты в финале. Он очный — если не сможешь прийти, напиши организатору.';

type Leave = { kind: 'intake' } | { kind: 'draw' } | { kind: 'bracket' } | { kind: 'no'; text: string };

function leaveOf(state: TournamentState, id: UserId): Leave {
  const no = (text: string): Leave => ({ kind: 'no', text });
  if (!state.people[id]) return no('Ты не в турнире.');
  if (state.phase === 'intake') {
    if (!isParticipant(state, id)) return no('Ты не играешь в турнире — выходить не из чего.');
    if (isSongsOnly(state.intake, id)) return no('Ты и так не играешь — только присылаешь песни.');
    return { kind: 'intake' };
  }
  const draw = state.draw;
  if (state.phase === 'qualifiers' && draw) {
    if (!draw.config.players.some((p) => p.id === id)) return no('Ты не играешь в турнире — выходить не из чего.');
    if (!draw.bracket) return { kind: 'draw' };
    if (state.withdrawn.includes(id)) return no('Ты уже не в турнире.');
    if (qualifiedIds(draw).includes(id)) return no(FINALIST);
    if (eliminated(draw, id)) return no('Отбор для тебя уже закончен — выходить не из чего.');
    return { kind: 'bracket' };
  }
  if (state.phase === 'final' && finalistIds(state).includes(id)) return no(FINALIST);
  return no('Турнир для тебя уже закончен — выходить не из чего.');
}

const QUESTION: Record<Exclude<Leave['kind'], 'no'>, string> = {
  intake: '🚪 Точно не играешь? Присланные песни останутся в турнире, а в жеребьёвку ты не попадёшь.',
  draw: '🚪 Точно выходишь из турнира? В жеребьёвку ты не попадёшь, отменить нельзя. Судить по-прежнему можно.',
  bracket:
    '🚪 Точно выходишь из турнира? Текущий матч засчитается сопернику, в следующих парах — техническое поражение. Отменить нельзя. Судить по-прежнему можно.',
};

export function askLeave(state: TournamentState, id: UserId): Step {
  const leave = leaveOf(state, id);
  if (leave.kind === 'no') return say(state, id, leave.text);
  const closed = leave.kind === 'intake' && state.intake.closed;
  const text = leave.kind === 'intake' && !closed ? `${QUESTION.intake}\nПередумать можно, пока идёт сбор, — кнопкой под списком песен.` : QUESTION[leave.kind];
  const buttons: Button[][] = [
    [
      { label: '🚪 Да, выхожу', data: 'l:ok' },
      { label: 'Остаться', data: 'l:cancel' },
    ],
  ];
  return { state, out: [{ kind: 'message', to: id, slot: SLOT, bump: true, text, buttons }] };
}

export function leaveButton(state: TournamentState, id: UserId, data: string): Step {
  const reply = (text: string): OutgoingMessage => ({ kind: 'message', to: id, slot: SLOT, text });
  if (data === 'cancel') return { state, out: [reply('Остаёшься в турнире 👍')] };
  if (data !== 'ok' && data !== 'final') return toast(state, id, 'Кнопка устарела');

  const leave = leaveOf(state, id);
  if (leave.kind === 'no') return { state, out: [reply(leave.text)] };
  if (leave.kind !== 'intake' && data === 'ok') {
    const text = '⚠️ Последний шаг. Вернуться в турнир будет нельзя — ни тебе, ни организатору. Выходишь?';
    const buttons: Button[][] = [
      [
        { label: '🚪 Выйти окончательно', data: 'l:final' },
        { label: 'Остаться', data: 'l:cancel' },
      ],
    ];
    return { state, out: [{ ...reply(text), buttons }] };
  }
  const person = state.people[id]!;
  const who = `№${person.number} ${person.name}`;
  const notify = (text: string): Outgoing[] => panelHolders(state).map((holder) => message(holder, text));

  if (leave.kind === 'intake') {
    const left = leaveIntake(state.intake, id);
    const next = { ...state, intake: left.session, journal: [...state.journal, `Больше не играет, песни остаются: ${person.name}`] };
    return {
      state: next,
      out: [
        reply('🎁 Готово: ты больше не играешь, присланные песни остаются в турнире.'),
        ...scope(next, left.out, 'i:'),
        ...notify(`🎁 ${who} больше не играет — песни остаются в турнире.`),
      ],
    };
  }
  if (leave.kind === 'draw') {
    const draw = state.draw!;
    const players = draw.config.players.filter((p) => p.id !== id);
    return {
      state: {
        ...state,
        draw: { ...draw, config: { ...draw.config, players } },
        journal: [...state.journal, `Вышел из турнира до жеребьёвки: ${person.name}`],
      },
      out: [reply('🚪 Ты вышел из турнира — в жеребьёвку не попадёшь. Судить по-прежнему можно.'), ...notify(`🚪 ${who} вышел из турнира до жеребьёвки.`)],
    };
  }
  const left = leaveTournament(state, id);
  return {
    state: left.state,
    out: [reply('🚪 Ты вышел из турнира. Спасибо за игру! Судить по-прежнему можно.'), ...left.out, ...notify(`🚪 ${who} вышел из турнира сам.`)],
  };
}
