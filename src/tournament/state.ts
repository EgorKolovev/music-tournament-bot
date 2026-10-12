import type { DrawSession } from '../bot/drawSession.ts';
import type { FinalSession } from '../bot/finalSession.ts';
import type { IntakeSession } from '../bot/intakeSession.ts';
import type { MatchSession, Participant } from '../bot/matchSession.ts';
import type { Outgoing, UserId } from '../bot/protocol.ts';
import type { Ruleset } from '../domain/match/ruleset.ts';
import type { IntakeRules } from '../domain/submission/intake.ts';

// Состояние турнира и его части. Логика — в соседних модулях, точка входа — tournament.ts.

// Внутри сессий организатор — отдельный «пользователь»: так его панель не путается с его же
// чатом участника. При отправке подменяется на настоящий Telegram ID.
export const ORG = '@org';

export interface TournamentConfig {
  code: string;
  title: string;
  organizerId: UserId;
  // Могут выполнять команды организатора; панели приходят только организатору.
  adminIds: UserId[];
  botUsername: string;
  finalists: number;
  seed: number;
  // Срок круга отбора в днях от жеребьёвки.
  roundDays: number;
  intakeRules: IntakeRules;
  // Длина игрового фрагмента, секунд; одна на турнир.
  fragmentSec: number;
  finalPoolTarget: number;
  qualifierRuleset: Ruleset;
  finalRuleset: Ruleset;
}

export type Phase = 'intake' | 'qualifiers' | 'final' | 'archive';

export interface Person {
  id: UserId;
  name: string;
  // Ник и имя из профиля Telegram — обновляются, когда человек пишет боту.
  username?: string;
  profileName?: string;
  // Номер внутри турнира — по нему организатор указывает игрока в командах.
  number: number;
  registeredAt: number;
}

export interface PendingRegistration {
  step: 'name' | 'rules';
  name?: string;
  suggested: string;
  username?: string;
  // Что открыть после регистрации: приглашение судьи и т. п.
  payload?: string;
}

export interface MatchRuntime {
  session: MatchSession;
  // Номер переигровки: входит в slot, чтобы новый матч не правил сообщения старого.
  attempt: number;
  trackStartedAt?: number;
  trackReminded: boolean;
  decidedAt?: number;
  confirmEscalated: boolean;
  dispute?: { by: UserId; at: number };
  // Результат внесён в сетку или матч снят организатором.
  closed: boolean;
}

// Меню организатора в панели этапа: техническая победа и снятие игрока — в несколько нажатий.
export type AdminMenu =
  | { kind: 'tech' }
  | { kind: 'techWinner'; matchId: string }
  | { kind: 'techConfirm'; matchId: string; winner: UserId }
  | { kind: 'withdraw' }
  | { kind: 'withdrawConfirm'; userId: UserId };

export interface TournamentState {
  config: TournamentConfig;
  phase: Phase;
  people: Record<UserId, Person>;
  nextNumber: number;
  registration: Record<UserId, PendingRegistration>;
  intake: IntakeSession;
  draw: DrawSession | null;
  matches: Record<string, MatchRuntime>;
  // Кто с какой песней познакомился в матчах: судья — при выдаче, игроки — при старте трека.
  known: Record<UserId, string[]>;
  // Круг → срок, о котором уже напомнили; перенос срока даёт новое напоминание.
  remindedDeadlines: Record<number, string>;
  overdueReported: Record<number, string>;
  finalJudge: Participant | null;
  final: FinalSession | null;
  // Сняты с турнира организатором: каждый их матч отбора — техническое поражение.
  withdrawn: UserId[];
  // Из них вышли сами (/leave). В снимках прошлых версий поля нет.
  left?: UserId[];
  adminMenu: AdminMenu | null;
  // Раздел панели, открытый у каждого админа. Снимки прошлых версий поля не содержат.
  panels?: Record<UserId, PanelScreen>;
  journal: string[];
}

// Разделы панели админа; у карточек матча и участника — id после двоеточия.
export type PanelScreen =
  | 'home'
  | 'intake'
  | 'bracket'
  | 'matches'
  | 'players'
  | 'final'
  | 'settings'
  | `match:${string}`
  | `player:${string}`;

export interface Step {
  state: TournamentState;
  out: Outgoing[];
}
