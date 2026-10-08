import { applyOutgoing, findButton, type Chats } from '../bot/chat.ts';
import {
  handleIncoming,
  openMatchSession,
  type MatchSession,
  type MatchSessionConfig,
} from '../bot/matchSession.ts';
import type { Incoming, Outgoing } from '../bot/protocol.ts';
import type { Role, Scenario, ScenarioStep } from './scenarios.ts';

// Кадр симуляции: состояние сессии и то, что видит каждый участник в своём чате.
export interface Frame {
  session: MatchSession;
  chats: Chats;
  input?: Incoming;
  step?: ScenarioStep;
  out: Outgoing[];
  nextMessageId: number;
}

export function initialFrame(config: MatchSessionConfig): Frame {
  const { session, out } = openMatchSession(config);
  return withOutgoing({ session, chats: {}, out: [], nextMessageId: 1 }, session, out);
}

export function nextFrame(frame: Frame, input: Incoming, step?: ScenarioStep): Frame {
  const { session, out } = handleIncoming(frame.session, input);
  return { ...withOutgoing(frame, session, out), input, step };
}

function withOutgoing(frame: Frame, session: MatchSession, out: Outgoing[]): Frame {
  let id = frame.nextMessageId;
  const chats = applyOutgoing(frame.chats, out, () => id++);
  return { session, chats, out, nextMessageId: id, input: undefined, step: undefined };
}

export function userIdOf(config: MatchSessionConfig, role: Role): string {
  return role === 'judge' ? config.judge.id : config.players[role === 'p0' ? 0 : 1].id;
}

// Шаг сценария нажимает кнопку, которую участник реально видит в своём чате.
export function resolveStep(frame: Frame, step: ScenarioStep): Incoming {
  const from = userIdOf(frame.session.config, step.as);
  const button = findButton(frame.chats[from], step.press);
  if (!button) throw new Error(`У «${step.as}» нет кнопки «${step.press}»`);
  return { kind: 'button', from, data: button.data };
}

export function runScenario(config: MatchSessionConfig, scenario: Scenario): Frame[] {
  const frames = [initialFrame(config)];
  for (const step of scenario.steps) {
    const frame = frames.at(-1)!;
    frames.push(nextFrame(frame, resolveStep(frame, step), step));
  }
  return frames;
}
