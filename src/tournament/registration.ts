import { inviteByLink, registerPerson } from '../bot/drawSession.ts';
import { joinIntake } from '../bot/intakeSession.ts';
import type { Outgoing, OutgoingMessage, UserId } from '../bot/protocol.ts';
import { formatPoints } from '../domain/match/ruleset.ts';
import type { Sender } from './events.ts';
import { canAdmin, message, say, scope, textsTo, toast } from './helpers.ts';
import { resendPanels } from './panels.ts';
import { finalistIds } from './stages.ts';
import type { PendingRegistration, Person, Step, TournamentState } from './state.ts';

// Регистрация по ссылкам: участник t_<код>, судья матча judge_<матч>, судья финала fjudge_<код>.

export function handleStart(state: TournamentState, from: Sender, payload: string, at: number): Step {
  const registered = state.people[from.id];
  const invite = payload === `t_${state.config.code}`;
  const judgeLink = /^judge_(r\d+-\d+)$/.exec(payload);
  const finalJudgeLink = payload === `fjudge_${state.config.code}`;

  if (!registered) {
    if (invite || judgeLink || finalJudgeLink) return startRegistration(state, from, invite ? undefined : payload);
    if (canAdmin(state, from.id)) return resendPanels(state, from.id);
    return say(state, from.id, textsTo(state, from.id).registration.stranger);
  }
  if (judgeLink) return judgeInvite(state, from.id, judgeLink[1]!);
  if (finalJudgeLink) return assignFinalJudge(state, from.id, at);
  const panels = canAdmin(state, from.id) ? resendPanels(state, from.id).out : [];
  const texts = textsTo(state, from.id).registration;
  const text = `${texts.already({ number: registered.number, name: registered.name })}\n${texts.commands}`;
  return { state, out: [message(from.id, text), ...panels] };
}

function startRegistration(state: TournamentState, from: Sender, payload?: string): Step {
  const pending: PendingRegistration = { step: 'name', suggested: from.name, username: from.username, payload };
  const next = { ...state, registration: { ...state.registration, [from.id]: pending } };
  return { state: next, out: [registrationMessage(state, from.id, pending)] };
}

function registrationMessage(state: TournamentState, to: UserId, pending: PendingRegistration, bump = false): OutgoingMessage {
  const texts = textsTo(state, to).registration;
  const { buttons } = texts;
  if (pending.step === 'name') {
    return {
      kind: 'message',
      to,
      slot: 'r:reg',
      bump,
      text: [texts.hello({ title: state.config.title }), '', texts.askName].join('\n'),
      buttons: [[{ label: buttons.profileName({ name: pending.suggested }), data: 'r:name' }]],
    };
  }
  const ruleset = state.config.qualifierRuleset;
  return {
    kind: 'message',
    to,
    slot: 'r:reg',
    bump,
    text: [
      texts.name({ name: pending.name! }),
      '',
      texts.rulesTitle,
      texts.rules({ artist: formatPoints(ruleset.artistPoints), title: formatPoints(ruleset.titlePoints) }),
      '',
      texts.privacy,
      ...(canChooseRole(state, pending) ? ['', texts.songsOnlyOffer] : []),
    ].join('\n'),
    // «Играю» — те же данные, что у прежней «Принимаю правила»: старые события значат то же.
    buttons: canChooseRole(state, pending)
      ? [[{ label: buttons.play, data: 'r:accept' }], [{ label: buttons.songsOnly, data: 'r:songs' }], [{ label: buttons.rename, data: 'r:rename' }]]
      : [[{ label: buttons.accept, data: 'r:accept' }], [{ label: buttons.rename, data: 'r:rename' }]],
  };
}

// Выбор есть, пока идёт сбор и человек пришёл по приглашению, а не по ссылке судьи.
function canChooseRole(state: TournamentState, pending: PendingRegistration): boolean {
  return state.phase === 'intake' && !state.intake.closed && !pending.payload;
}

export function registrationButton(state: TournamentState, from: Sender, data: string, at: number): Step {
  const pending = state.registration[from.id];
  const { toast: texts } = textsTo(state, from.id).registration;
  if (!pending) return toast(state, from.id, texts.done);
  const setPending = (p: PendingRegistration): Step => ({
    state: { ...state, registration: { ...state.registration, [from.id]: p } },
    out: [registrationMessage(state, from.id, p)],
  });
  if (data === 'name' && pending.step === 'name') return setPending({ ...pending, step: 'rules', name: pending.suggested });
  if (data === 'rename') return setPending({ ...pending, step: 'name' });
  if (data === 'accept' && pending.step === 'rules') return register(state, from, pending, at);
  if (data === 'songs' && pending.step === 'rules') {
    if (!canChooseRole(state, pending)) return toast(state, from.id, texts.closed);
    return register(state, from, pending, at, true);
  }
  return toast(state, from.id, texts.unavailable);
}

export function registrationText(state: TournamentState, from: Sender, text: string): Step {
  const pending = state.registration[from.id]!;
  const name = text.trim().replace(/\s+/g, ' ');
  if (pending.step !== 'name') return { state, out: [registrationMessage(state, from.id, pending, true)] };
  if (name.length < 2 || name.length > 32 || name.startsWith('/')) {
    return say(state, from.id, textsTo(state, from.id).registration.badName);
  }
  const next: PendingRegistration = { ...pending, step: 'rules', name };
  return {
    state: { ...state, registration: { ...state.registration, [from.id]: next } },
    out: [registrationMessage(state, from.id, next, true)],
  };
}

function register(state: TournamentState, from: Sender, pending: PendingRegistration, at: number, songsOnly = false): Step {
  const person: Person = {
    id: from.id,
    name: pending.name!,
    username: pending.username,
    profileName: pending.suggested,
    number: state.nextNumber,
    registeredAt: at,
  };
  const { [from.id]: _, ...registration } = state.registration;
  let next: TournamentState = {
    ...state,
    people: { ...state.people, [person.id]: person },
    nextNumber: state.nextNumber + 1,
    registration,
    journal: [...state.journal, `Регистрация: №${person.number} ${person.name}${songsOnly ? ' (только песни)' : ''}`],
  };
  const texts = textsTo(next, person.id).registration;
  const registered = texts.registered({ title: state.config.title, number: person.number, name: person.name });
  const welcome = texts.welcome({ number: person.number });
  const out: Outgoing[] = [
    {
      kind: 'message',
      to: person.id,
      slot: 'r:reg',
      text: [welcome ? `${registered} ${welcome}` : registered, ...(songsOnly ? [texts.songsOnly] : []), texts.commands, texts.styleHint].join('\n'),
    },
  ];

  if (next.phase === 'intake' && !next.intake.closed && !pending.payload) {
    const joined = joinIntake(next.intake, { id: person.id, name: person.name }, songsOnly);
    next = { ...next, intake: joined.session };
    out.push(...scope(next, joined.out, 'i:'));
  } else {
    if (next.draw) {
      const added = registerPerson(next.draw, { id: person.id, name: person.name }, person.username);
      next = { ...next, draw: added.session };
      out.push(...scope(next, added.out, 'd:'));
    }
    if (!pending.payload) out.push(message(person.id, texts.late));
  }

  if (pending.payload) {
    const judge = /^judge_(r\d+-\d+)$/.exec(pending.payload);
    const step = judge ? judgeInvite(next, person.id, judge[1]!) : assignFinalJudge(next, person.id, at);
    return { state: step.state, out: [...out, ...step.out] };
  }
  return { state: next, out };
}

function judgeInvite(state: TournamentState, userId: UserId, matchId: string): Step {
  if (!state.draw?.bracket) return say(state, userId, textsTo(state, userId).registration.noPairs);
  const step = inviteByLink(state.draw, matchId, userId);
  return { state: { ...state, draw: step.session }, out: scope(state, step.out, 'd:') };
}

function assignFinalJudge(state: TournamentState, userId: UserId, at: number): Step {
  const texts = textsTo(state, userId).registration;
  if (state.phase !== 'final' || state.final) return say(state, userId, texts.finalJudgeNotNow);
  if (finalistIds(state).includes(userId)) return say(state, userId, texts.finalistJudge);
  const person = state.people[userId]!;
  const next = {
    ...state,
    finalJudge: { id: person.id, name: person.name },
    journal: [...state.journal, `Судья финала: ${person.name} (${new Date(at).toISOString().slice(0, 10)})`],
  };
  return say(next, userId, texts.finalJudge);
}
