import { inviteByLink, registerPerson } from '../bot/drawSession.ts';
import { joinIntake } from '../bot/intakeSession.ts';
import type { Outgoing, OutgoingMessage, UserId } from '../bot/protocol.ts';
import type { Sender } from './events.ts';
import { canAdmin, message, say, scope, toast } from './helpers.ts';
import { resendPanels } from './panels.ts';
import { finalistIds } from './stages.ts';
import type { PendingRegistration, Person, Step, TournamentState } from './state.ts';

// Регистрация по ссылкам: участник t_<код>, судья матча judge_<матч>, судья финала fjudge_<код>.

const COMMANDS_HINT = 'Команды: /status — где ты сейчас, /matches — кто с кем играет, /help — что я умею.';

export function handleStart(state: TournamentState, from: Sender, payload: string, at: number): Step {
  const registered = state.people[from.id];
  const invite = payload === `t_${state.config.code}`;
  const judgeLink = /^judge_(r\d+-\d+)$/.exec(payload);
  const finalJudgeLink = payload === `fjudge_${state.config.code}`;

  if (!registered) {
    if (invite || judgeLink || finalJudgeLink) return startRegistration(state, from, invite ? undefined : payload);
    if (canAdmin(state, from.id)) return resendPanels(state, from.id);
    return say(state, from.id, 'Это бот музыкального турнира. Чтобы участвовать, открой ссылку-приглашение от организатора.');
  }
  if (judgeLink) return judgeInvite(state, from.id, judgeLink[1]!);
  if (finalJudgeLink) return assignFinalJudge(state, from.id, at);
  const panels = canAdmin(state, from.id) ? resendPanels(state, from.id).out : [];
  return { state, out: [message(from.id, `Ты в турнире: №${registered.number}, ${registered.name}.\n${COMMANDS_HINT}`), ...panels] };
}

function startRegistration(state: TournamentState, from: Sender, payload?: string): Step {
  const pending: PendingRegistration = { step: 'name', suggested: from.name, username: from.username, payload };
  const next = { ...state, registration: { ...state.registration, [from.id]: pending } };
  return { state: next, out: [registrationMessage(state, from.id, pending)] };
}

function registrationMessage(state: TournamentState, to: UserId, pending: PendingRegistration, bump = false): OutgoingMessage {
  if (pending.step === 'name') {
    return {
      kind: 'message',
      to,
      slot: 'r:reg',
      bump,
      text: [
        `Привет! Это бот турнира «${state.config.title}».`,
        '',
        'Как тебя записать? Это имя увидят соперники и судьи. Пришли его одним сообщением или возьми имя из Telegram.',
      ].join('\n'),
      buttons: [[{ label: `👤 ${pending.suggested}`, data: 'r:name' }]],
    };
  }
  return {
    kind: 'message',
    to,
    slot: 'r:reg',
    bump,
    text: [
      `Имя: ${pending.name}`,
      '',
      'Правила коротко:',
      '• Отбор — очные матчи один на один, судья включает трек со своего телефона.',
      '• Исполнитель — 0,9 балла, название — 1,2. Свои песни тебе не выпадут.',
      '• Результат подтверждают судья и оба игрока; спор решает организатор.',
      '• Судить можно чужие матчи; песни, которые услышишь как судья, тебе потом не выпадут.',
      '',
      'Telegram ID используется только внутри турнира.',
      ...(canChooseRole(state, pending) ? ['', 'Можно не играть, а только прислать песни: они пойдут в игру, а тебя могут позвать судить.'] : []),
    ].join('\n'),
    // «Играю» — те же данные, что у прежней «Принимаю правила»: старые события значат то же.
    buttons: canChooseRole(state, pending)
      ? [
          [{ label: '🎤 Играю', data: 'r:accept' }],
          [{ label: '🎁 Только пришлю песни', data: 'r:songs' }],
          [{ label: '✏️ Другое имя', data: 'r:rename' }],
        ]
      : [
          [{ label: '✅ Принимаю правила', data: 'r:accept' }],
          [{ label: '✏️ Другое имя', data: 'r:rename' }],
        ],
  };
}

// Выбор есть, пока идёт сбор и человек пришёл по приглашению, а не по ссылке судьи.
function canChooseRole(state: TournamentState, pending: PendingRegistration): boolean {
  return state.phase === 'intake' && !state.intake.closed && !pending.payload;
}

export function registrationButton(state: TournamentState, from: Sender, data: string, at: number): Step {
  const pending = state.registration[from.id];
  if (!pending) return toast(state, from.id, 'Регистрация уже завершена');
  const setPending = (p: PendingRegistration): Step => ({
    state: { ...state, registration: { ...state.registration, [from.id]: p } },
    out: [registrationMessage(state, from.id, p)],
  });
  if (data === 'name' && pending.step === 'name') return setPending({ ...pending, step: 'rules', name: pending.suggested });
  if (data === 'rename') return setPending({ ...pending, step: 'name' });
  if (data === 'accept' && pending.step === 'rules') return register(state, from, pending, at);
  if (data === 'songs' && pending.step === 'rules') {
    if (!canChooseRole(state, pending)) return toast(state, from.id, 'Сбор уже закрыт');
    return register(state, from, pending, at, true);
  }
  return toast(state, from.id, 'Сейчас это действие недоступно');
}

export function registrationText(state: TournamentState, from: Sender, text: string): Step {
  const pending = state.registration[from.id]!;
  const name = text.trim().replace(/\s+/g, ' ');
  if (pending.step !== 'name') return { state, out: [registrationMessage(state, from.id, pending, true)] };
  if (name.length < 2 || name.length > 32 || name.startsWith('/')) {
    return say(state, from.id, 'Имя должно быть от 2 до 32 символов. Пришли ещё раз.');
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
  const out: Outgoing[] = [
    {
      kind: 'message',
      to: person.id,
      slot: 'r:reg',
      text: [
        `✅ Ты в турнире «${state.config.title}»: №${person.number}, ${person.name}.`,
        ...(songsOnly ? ['🎁 Присылаешь песни, но не играешь. Передумаешь — кнопка под списком песен, пока идёт сбор.'] : []),
        COMMANDS_HINT,
      ].join('\n'),
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
    if (!pending.payload) out.push(message(person.id, 'Сбор песен уже закрыт, поэтому сыграть не получится, но тебя могут позвать судить матчи.'));
  }

  if (pending.payload) {
    const judge = /^judge_(r\d+-\d+)$/.exec(pending.payload);
    const step = judge ? judgeInvite(next, person.id, judge[1]!) : assignFinalJudge(next, person.id, at);
    return { state: step.state, out: [...out, ...step.out] };
  }
  return { state: next, out };
}

function judgeInvite(state: TournamentState, userId: UserId, matchId: string): Step {
  if (!state.draw?.bracket) return say(state, userId, 'Это приглашение пока неактуально: жеребьёвки ещё не было.');
  const step = inviteByLink(state.draw, matchId, userId);
  return { state: { ...state, draw: step.session }, out: scope(state, step.out, 'd:') };
}

function assignFinalJudge(state: TournamentState, userId: UserId, at: number): Step {
  if (state.phase !== 'final' || state.final) return say(state, userId, 'Назначить судью финала сейчас нельзя.');
  if (finalistIds(state).includes(userId)) return say(state, userId, 'Финалист не может судить финал.');
  const person = state.people[userId]!;
  const next = {
    ...state,
    finalJudge: { id: person.id, name: person.name },
    journal: [...state.journal, `Судья финала: ${person.name} (${new Date(at).toISOString().slice(0, 10)})`],
  };
  return say(next, userId, '⚖️ Ты судья финала. Панель судьи придёт, когда организатор откроет финал.');
}
