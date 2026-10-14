import { eliminated, removePlayer } from '../bot/drawSession.ts';
import { isSongsOnly, leaveIntake } from '../bot/intakeSession.ts';
import type { Button, Outgoing, OutgoingMessage, UserId } from '../bot/protocol.ts';
import { isParticipant, message, panelHolders, say, scope, textsTo, toast } from './helpers.ts';
import { withdraw } from './organizer.ts';
import { finalistIds } from './stages.ts';
import type { Step, TournamentState } from './state.ts';

// Участник сам выходит из турнира (/leave): подтверждение, затем то же, что снятие админом.
// На сборе выход — «только песни»: присланные песни остаются в пулах, вернуться можно до закрытия
// сбора. После сбора выход необратим — поэтому второй шаг: «вернуться будет нельзя». До жеребьёвки
// участник просто не попадает в сетку. Финал очный: финалист выходит только через организатора.

const SLOT = 'l:confirm';

type Leave = { kind: 'intake' } | { kind: 'draw' } | { kind: 'bracket' } | { kind: 'no'; text: string };

function leaveOf(state: TournamentState, id: UserId): Leave {
  const no = (text: string): Leave => ({ kind: 'no', text });
  const texts = textsTo(state, id).leave;
  if (!state.people[id]) return no(texts.stranger);
  if (state.phase === 'intake') {
    if (!isParticipant(state, id)) return no(texts.notPlaying);
    if (isSongsOnly(state.intake, id)) return no(texts.songsOnly);
    return { kind: 'intake' };
  }
  const draw = state.draw;
  if (state.phase === 'qualifiers' && draw) {
    if (state.withdrawn.includes(id)) return no(texts.alreadyOut);
    if (!draw.config.players.some((p) => p.id === id)) return no(texts.notPlaying);
    if (!draw.bracket) {
      // Сетку строят минимум на столько игроков, сколько мест в финале.
      if (draw.config.players.length - 1 < state.config.finalists) return no(texts.tooFew);
      return { kind: 'draw' };
    }
    if (finalistIds(state).includes(id)) return no(texts.finalist);
    if (eliminated(draw, id)) return no(texts.eliminated);
    return { kind: 'bracket' };
  }
  if (state.phase === 'final' && finalistIds(state).includes(id)) return no(texts.finalist);
  return no(texts.over);
}

// Выход отменяется, только пока сбор открыт: передумать можно кнопкой под списком песен.
// Иначе он необратим, и перед ним второй шаг.
function reversible(state: TournamentState, leave: Leave): boolean {
  return leave.kind === 'intake' && !state.intake.closed;
}

export function askLeave(state: TournamentState, id: UserId): Step {
  const leave = leaveOf(state, id);
  if (leave.kind === 'no') return say(state, id, leave.text);
  const texts = textsTo(state, id).leave;
  let text = texts.question[leave.kind];
  if (leave.kind === 'intake') text += `\n${reversible(state, leave) ? texts.reversible : texts.irreversible}`;
  // Этап — в данных кнопки: если он сменится, пока человек думает, бот спросит заново.
  const buttons: Button[][] = [
    [
      { label: texts.buttons.leave, data: `l:ok:${leave.kind}` },
      { label: texts.buttons.stay, data: 'l:cancel' },
    ],
  ];
  return { state, out: [{ kind: 'message', to: id, slot: SLOT, bump: true, text, buttons }] };
}

export function leaveButton(state: TournamentState, id: UserId, data: string): Step {
  const reply = (text: string): OutgoingMessage => ({ kind: 'message', to: id, slot: SLOT, text });
  const texts = textsTo(state, id).leave;
  if (data === 'cancel') return { state, out: [reply(texts.stay({ n: state.journal.length }) || texts.buttons.stay)] };
  const action = /^(ok|final)(?::(\w+))?$/.exec(data);
  if (!action) return toast(state, id, texts.stale);
  const [, step, asked] = action;

  const leave = leaveOf(state, id);
  if (leave.kind === 'no') return { state, out: [reply(leave.text)] };
  if (asked !== undefined && asked !== leave.kind) return askLeave(state, id);
  // l:ok без этапа — из сообщений прошлой версии: там второго шага не было на всём сборе.
  const final = asked === undefined ? leave.kind !== 'intake' : !reversible(state, leave);
  if (step === 'ok' && final) {
    const buttons: Button[][] = [
      [
        { label: texts.buttons.leaveFinal, data: `l:final:${leave.kind}` },
        { label: texts.buttons.stay, data: 'l:cancel' },
      ],
    ];
    return { state, out: [{ ...reply(texts.lastStep), buttons }] };
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
        reply(texts.done.intake),
        ...scope(next, left.out, 'i:'),
        ...notify(`🎁 ${who} больше не играет — песни остаются в турнире.`),
      ],
    };
  }
  if (leave.kind === 'draw') {
    const removed = removePlayer(state.draw!, id);
    // В сетке его нет, но в «Участниках» и /status он — «вышел сам», как и вышедшие с отбора.
    const next: TournamentState = {
      ...state,
      draw: removed.session,
      withdrawn: [...state.withdrawn, id],
      left: [...(state.left ?? []), id],
      journal: [...state.journal, `Выход из турнира до жеребьёвки: ${person.name}`],
    };
    return {
      state: next,
      out: [
        reply(texts.done.draw),
        ...scope(next, removed.out, 'd:'),
        ...notify(`🚪 ${who} покидает турнир до жеребьёвки.`),
      ],
    };
  }
  const left = withdraw(state, id, 'self');
  return {
    state: left.state,
    out: [reply(texts.done.bracket), ...left.out, ...notify(`🚪 ${who} покидает турнир по своему желанию.`)],
  };
}
