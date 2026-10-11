import { applyOutgoing, type Chat, type Chats } from '../bot/chat.ts';
import { limitViolations, type Outgoing, type UserId } from '../bot/protocol.ts';
import { QUALIFIER_RULESET, FINAL_RULESET } from '../domain/match/ruleset.ts';
import { DEFAULT_INTAKE_RULES, type AudioFile } from '../domain/submission/intake.ts';
import type { TournamentEvent } from './events.ts';
import { createTournament, handleEvent, type TournamentConfig, type TournamentState } from './tournament.ts';

// Тестовый стенд оркестратора: прогоняет события и ведёт чаты так, как их увидит Telegram
// (правка по slot, перенос вниз по bump). Кнопки нажимаются только видимые.

export const ORGANIZER = '900';

export function testConfig(overrides: Partial<TournamentConfig> = {}): TournamentConfig {
  return {
    code: 'test',
    title: 'Тестовый турнир',
    organizerId: ORGANIZER,
    adminIds: [],
    botUsername: 'test_bot',
    finalists: 2,
    seed: 42,
    roundDays: 7,
    intakeRules: { ...DEFAULT_INTAKE_RULES, maxSubmissions: 10 },
    fragmentSec: 60,
    finalPoolTarget: 15,
    qualifierRuleset: QUALIFIER_RULESET,
    finalRuleset: FINAL_RULESET,
    ...overrides,
  };
}

export class TestBot {
  state: TournamentState;
  chats: Chats = {};
  toasts: { to: UserId; text: string }[] = [];
  outLog: Outgoing[] = [];
  now = Date.parse('2026-10-10T10:00:00Z');
  private nextId = 1;

  constructor(config = testConfig()) {
    const created = createTournament(config);
    this.state = created.state;
    this.apply(created.out);
  }

  send(event: TournamentEvent, advanceMs = 1000): Outgoing[] {
    this.now += advanceMs;
    const step = handleEvent(this.state, { at: this.now, event });
    this.state = step.state;
    this.apply(step.out);
    return step.out;
  }

  command(id: UserId, text: string): Outgoing[] {
    const [, command, payload] = /^\/(\w+)\s*(.*)$/s.exec(text)!;
    return this.send({ kind: 'command', from: sender(id), command: command!, payload: payload ?? '' });
  }

  text(id: UserId, text: string): Outgoing[] {
    return this.send({ kind: 'text', from: sender(id), text });
  }

  // Нажать видимую кнопку, чьё действие (data без |vN) равно `action`.
  press(id: UserId, action: string): Outgoing[] {
    const data = this.findButton(id, action);
    if (!data) throw new Error(`У ${id} нет кнопки «${action}». Видны: ${this.buttons(id).join(', ')}`);
    return this.send({ kind: 'button', from: sender(id), data });
  }

  hasButton(id: UserId, action: string): boolean {
    return this.findButton(id, action) !== undefined;
  }

  buttons(id: UserId): string[] {
    return botMessages(this.chats[id]).flatMap((m) => (m.buttons ?? []).flat().map((b) => b.data));
  }

  lastText(id: UserId): string {
    return botMessages(this.chats[id]).at(-1)?.text ?? '';
  }

  allText(id: UserId): string {
    return botMessages(this.chats[id])
      .map((m) => m.text)
      .join('\n---\n');
  }

  register(id: UserId, payload = 't_test'): void {
    this.command(id, `/start ${payload}`);
    this.press(id, 'r:name');
    this.press(id, 'r:accept');
  }

  submitSongs(id: UserId, count: number): void {
    const files: AudioFile[] = Array.from({ length: count }, (_, i) => ({
      fileId: `F-${id}-${i}`,
      fileUniqueId: `U-${id}-${i}`,
      fileName: `track${i}.mp3`,
      mimeType: 'audio/mpeg',
      sizeBytes: 5_000_000,
      durationSec: 180,
      performer: `Группа ${id}-${i}`,
      title: `Песня ${i}`,
    }));
    this.send({ kind: 'files', from: sender(id), files });
  }

  // cut: false — режим без нарезки (AUDIO_MODE=skip): игровых версий нет.
  processAudio({ cut = true } = {}): void {
    const pending = this.state.intake.intake.submissions.filter((s) => s.processing === 'pending' && !s.rejection);
    if (pending.length === 0) return;
    const results = pending.map((s) => ({
      submissionId: s.id,
      ok: true,
      startSec: s.startSec,
      gameFileId: cut ? `G-${s.id}@${s.startSec}` : undefined,
    }));
    this.send({ kind: 'worker', results });
  }

  private findButton(id: UserId, action: string): string | undefined {
    for (const message of [...botMessages(this.chats[id])].reverse()) {
      for (const button of (message.buttons ?? []).flat()) {
        if (button.data.split('|')[0] === action) return button.data;
      }
    }
    return undefined;
  }

  private apply(out: Outgoing[]): void {
    this.outLog.push(...out);
    for (const o of out) if (o.kind === 'toast') this.toasts.push({ to: o.to, text: o.text });
    this.chats = applyOutgoing(this.chats, out, () => this.nextId++);
  }
}

export function sender(id: UserId) {
  return { id, name: `Игрок ${id}`, username: `user${id}` };
}

function botMessages(chat: Chat | undefined) {
  return (chat?.messages ?? []).flatMap((m) => (m.author === 'bot' ? [m] : []));
}

// Все нарушения лимитов Bot API за прогон.
export function violations(out: readonly Outgoing[]): string[] {
  return out.flatMap((o) => (o.kind === 'message' ? limitViolations(o) : []));
}
