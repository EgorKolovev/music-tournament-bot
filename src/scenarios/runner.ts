import { applyOutgoing, applyUserMessage, findButton, type Chats } from '../bot/chat.ts';
import type { Incoming, Outgoing } from '../bot/protocol.ts';
import type { Engine, Role, Scenario, ScenarioStep } from './engine.ts';

// Кадр симуляции: состояние бота и то, что видит каждый участник в своём чате.
export interface Frame<S> {
  session: S;
  chats: Chats;
  input?: Incoming;
  step?: ScenarioStep;
  out: Outgoing[];
  nextMessageId: number;
}

export function initialFrame<S>(engine: Engine<S>): Frame<S> {
  const { session, out } = engine.open();
  let id = 1;
  const chats = applyOutgoing({}, out, () => id++);
  return { session, chats, out, nextMessageId: id };
}

export function nextFrame<S>(engine: Engine<S>, frame: Frame<S>, input: Incoming, step?: ScenarioStep): Frame<S> {
  let id = frame.nextMessageId;
  let chats = frame.chats;
  if (input.kind !== 'worker') chats = applyUserMessage(chats, input, id++);
  const { session, out } = engine.handle(frame.session, input);
  chats = applyOutgoing(chats, out, () => id++);
  return { session, chats, out, input, step, nextMessageId: id };
}

export function userIdOf<S>(engine: Engine<S>, role: Role): string {
  const column = engine.columns.find((c) => c.role === role);
  if (!column) throw new Error(`В «${engine.title}» нет участника «${role}»`);
  return column.user.id;
}

// Шаг сценария нажимает только ту кнопку, которую участник реально видит в своём чате.
export function resolveStep<S>(engine: Engine<S>, frame: Frame<S>, step: ScenarioStep): Incoming {
  if ('worker' in step) {
    const event = engine.workerEvent(frame.session);
    if (!event) throw new Error('Очередь обработки пуста');
    return event;
  }
  const from = userIdOf(engine, step.as);
  if ('send' in step) return { kind: 'text', from, text: step.send };
  if ('forward' in step) {
    const files = step.forward.map((key) => {
      const entry = engine.catalog[key];
      if (!entry) throw new Error(`В каталоге нет файла «${key}»`);
      return entry.file;
    });
    return { kind: 'files', from, files };
  }
  const button = findButton(frame.chats[from], step.press);
  if (!button) throw new Error(`У «${step.as}» нет кнопки «${step.press}»`);
  return { kind: 'button', from, data: button.data };
}

export function runScenario<S>(engine: Engine<S>, scenario: Scenario): Frame<S>[] {
  const frames = [initialFrame(engine)];
  for (const step of scenario.steps) {
    const frame = frames.at(-1)!;
    frames.push(nextFrame(engine, frame, resolveStep(engine, frame, step), step));
  }
  return frames;
}
