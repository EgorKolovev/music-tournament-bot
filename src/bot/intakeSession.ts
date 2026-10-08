import {
  completeProcessing,
  createIntake,
  moveToOtherPool,
  pendingProcessing,
  receiveFiles,
  remove,
  setTitle,
  statusOf,
  submissionsOf,
  swapPools,
  type IntakeRules,
  type IntakeState,
  type Pool,
  type RejectReason,
  type Submission,
} from '../domain/submission/intake.ts';
import { fromText } from '../domain/submission/titles.ts';
import type { Participant } from './matchSession.ts';
import type { Button, Incoming, Outgoing, OutgoingMessage, UserId } from './protocol.ts';

// Сбор треков в чате с ботом. У участника одно живое сообщение-список: файлы можно пересылать
// пачкой, названия берутся из тегов, бот спрашивает только то, что не смог понять сам.

export interface IntakeSessionConfig {
  participants: Participant[];
  organizer: Participant;
  rules: IntakeRules;
}

type Mode =
  | { kind: 'idle' }
  | { kind: 'pick'; action: 'edit' | 'move' | 'remove' }
  | { kind: 'swap'; submissionId: string }
  | { kind: 'awaitTitle'; submissionId: string };

interface UserUi {
  mode: Mode;
  // Разовая строка над списком: итог последнего действия или подсказка.
  notice: string | null;
  // Счётчики позиции: если пользователь писал после списка, список переезжает вниз.
  activity: number;
  listPostedAt: number;
}

export interface IntakeSession {
  config: IntakeSessionConfig;
  intake: IntakeState;
  ui: Record<UserId, UserUi>;
}

export interface IntakeStep {
  session: IntakeSession;
  out: Outgoing[];
}

const POOL_LABEL: Record<Pool, string> = { main: 'Отбор', final: 'Финал' };

const REJECT_TEXT: Record<RejectReason, string> = {
  too_large: 'больше 20 МБ',
  bad_format: 'нужен MP3 или M4A',
  corrupt: 'файл не читается',
  duplicate_other: 'эта песня уже есть у другого участника',
  duplicate_own: 'уже есть в твоём списке',
  quota_full: 'сверх 10 треков',
};

const TITLE_FORMAT = 'Ответь сообщением в формате «Исполнитель — Название».';

export function openIntakeSession(config: IntakeSessionConfig): IntakeStep {
  const ui: Record<UserId, UserUi> = {};
  for (const p of config.participants) ui[p.id] = { mode: { kind: 'idle' }, notice: null, activity: 0, listPostedAt: 0 };
  const session: IntakeSession = { config, intake: createIntake(config.rules), ui };
  const welcome: OutgoingMessage[] = config.participants.map((p) => ({
    kind: 'message',
    to: p.id,
    slot: 'welcome',
    text: [
      `Привет, ${p.name}! Собираем песни для турнира.`,
      '',
      `Нужно ${total(config.rules)}: ${config.rules.quota.main} в отбор и ${config.rules.quota.final} в финал.`,
      'Пересылай аудио пачкой — хоть все сразу, из @Music_to_you_bot или откуда удобно.',
      'Исполнителя и название возьму из файла; если не получится — спрошу.',
    ].join('\n'),
  }));
  return { session, out: [...welcome, ...render(session)] };
}

export function handleIntake(session: IntakeSession, input: Incoming): IntakeStep {
  const before = render(session);
  let next = session;

  if (input.kind === 'worker') {
    let intake = session.intake;
    for (const { submissionId, ok } of input.results) intake = completeProcessing(intake, submissionId, ok);
    next = { ...session, intake };
  } else {
    const ui = session.ui[input.from];
    if (!ui) return { session, out: [] };
    if (input.kind === 'button') {
      const result = handleButton(session, input.from, input.data);
      if ('toast' in result) return { session, out: [{ kind: 'toast', to: input.from, text: result.toast }] };
      next = result.session;
    } else {
      next = input.kind === 'files' ? handleFiles(session, input.from, input) : handleText(session, input.from, input.text);
      next = setUi(next, input.from, { activity: ui.activity + 1 });
    }
  }

  return emit(next, before, input.kind === 'text' || input.kind === 'files' ? input.from : undefined);
}

// Готовые вердикты для фейкового worker в симуляторе; в проде их присылает настоящий worker с ffprobe.
export function pendingSubmissions(session: IntakeSession): Submission[] {
  return pendingProcessing(session.intake);
}

function handleFiles(session: IntakeSession, from: UserId, input: Extract<Incoming, { kind: 'files' }>): IntakeSession {
  // Отклонённые ранее файлы убираем из списка: участник прислал замену.
  let intake = session.intake;
  for (const s of submissionsOf(intake, from)) if (s.rejection) intake = remove(intake, s.id);
  const known = new Set(submissionsOf(intake, from).map((s) => s.id));
  intake = receiveFiles(intake, from, input.files);

  const added = submissionsOf(intake, from).filter((s) => !known.has(s.id));
  const rejected = added.filter((s) => s.rejection).length;
  const word = plural(added.length, 'файл', 'файла', 'файлов');
  const notice = `Получил ${added.length} ${word}${rejected ? `, не подошло: ${rejected}` : ''}.`;
  return setUi({ ...session, intake }, from, { notice, mode: { kind: 'idle' } });
}

function handleText(session: IntakeSession, from: UserId, text: string): IntakeSession {
  const target = titleTarget(session, from);
  if (!target) {
    return setUi(session, from, { notice: 'Чтобы поправить название, нажми «✏️ Исправить» под списком.' });
  }
  const meta = fromText(text);
  if (!meta) return setUi(session, from, { notice: `Не разобрал «${text}»: исполнителя и название нужно разделить тире.` });

  const intake = setTitle(session.intake, target.id, meta);
  const updated = intake.submissions.find((s) => s.id === target.id)!;
  const notice = updated.rejection
    ? `«${meta.artist} — ${meta.title}»: ${REJECT_TEXT[updated.rejection]}. Пришли другую песню.`
    : `Записал: ${meta.artist} — ${meta.title}.`;
  return setUi({ ...session, intake }, from, { notice, mode: { kind: 'idle' } });
}

type ButtonResult = { session: IntakeSession } | { toast: string };

function handleButton(session: IntakeSession, from: UserId, data: string): ButtonResult {
  const ui = session.ui[from]!;
  if (data === 'cancel') return { session: setUi(session, from, { mode: { kind: 'idle' }, notice: null }) };

  const pick = /^pick:(edit|move|remove)$/.exec(data);
  if (pick) {
    const action = pick[1] as 'edit' | 'move' | 'remove';
    if (candidates(session, from, action).length === 0) return { toast: 'Пока нечего выбирать' };
    return { session: setUi(session, from, { mode: { kind: 'pick', action }, notice: null }) };
  }

  const chosen = /^n:(\w+)$/.exec(data);
  const submission = chosen && session.intake.submissions.find((s) => s.id === chosen[1] && s.owner === from);
  if (!submission) return { toast: 'Этого трека уже нет в списке' };
  const label = labelOf(submission);
  const { mode } = ui;

  if (mode.kind === 'swap') {
    const result = swapPools(session.intake, mode.submissionId, submission.id);
    if (!result.ok) return { toast: 'Не получилось поменять' };
    return { session: done({ ...session, intake: result.state }, from, 'Поменял треки местами.') };
  }
  if (mode.kind !== 'pick') return { toast: 'Сначала выбери действие под списком' };

  switch (mode.action) {
    case 'edit':
      return {
        session: setUi(session, from, { mode: { kind: 'awaitTitle', submissionId: submission.id }, notice: null }),
      };
    case 'remove':
      return { session: done({ ...session, intake: remove(session.intake, submission.id) }, from, `Убрал «${label}».`) };
    case 'move': {
      const result = moveToOtherPool(session.intake, submission.id);
      if (result.ok) {
        const pool = result.state.submissions.find((s) => s.id === submission.id)!.pool!;
        return { session: done({ ...session, intake: result.state }, from, `«${label}» теперь в пуле «${POOL_LABEL[pool]}».`) };
      }
      return { session: setUi(session, from, { mode: { kind: 'swap', submissionId: submission.id }, notice: null }) };
    }
  }
}

function done(session: IntakeSession, userId: UserId, notice: string): IntakeSession {
  return setUi(session, userId, { mode: { kind: 'idle' }, notice });
}

function setUi(session: IntakeSession, userId: UserId, patch: Partial<UserUi>): IntakeSession {
  return { ...session, ui: { ...session.ui, [userId]: { ...session.ui[userId]!, ...patch } } };
}

// Трек, для которого бот ждёт название: выбранный вручную или первый без названия.
function titleTarget(session: IntakeSession, userId: UserId): Submission | undefined {
  const { mode } = session.ui[userId]!;
  if (mode.kind === 'awaitTitle') return session.intake.submissions.find((s) => s.id === mode.submissionId);
  return ordered(session, userId).find((s) => statusOf(s) === 'needs_title');
}

function candidates(session: IntakeSession, userId: UserId, action: 'edit' | 'move' | 'remove'): Submission[] {
  const list = ordered(session, userId);
  if (action === 'remove') return list;
  if (action === 'move') return list.filter((s) => s.pool !== null);
  return list.filter((s) => !s.rejection);
}

// Порядок в списке и номера: отбор, финал, затем не принятые.
function ordered(session: IntakeSession, userId: UserId): Submission[] {
  const own = submissionsOf(session.intake, userId);
  return [...own.filter((s) => s.pool === 'main'), ...own.filter((s) => s.pool === 'final'), ...own.filter((s) => !s.pool)];
}

// --- Рендер ---------------------------------------------------------------

// Отправляем только изменившиеся сообщения. Список того, кто сам что-то написал, переотправляется
// всегда: иначе на сообщение без изменений участник не увидит реакции.
function emit(next: IntakeSession, before: OutgoingMessage[], author?: UserId): IntakeStep {
  const previous = new Map(before.map((m) => [`${m.to}/${m.slot}`, JSON.stringify(m)]));
  const out: OutgoingMessage[] = [];
  let session = next;
  for (const message of render(next)) {
    const unchanged = previous.get(`${message.to}/${message.slot}`) === JSON.stringify(message);
    if (unchanged && !(message.to === author && message.slot === 'list')) continue;
    const ui = session.ui[message.to];
    if (ui && message.slot === 'list' && ui.activity > ui.listPostedAt) {
      out.push({ ...message, bump: true });
      session = setUi(session, message.to, { listPostedAt: ui.activity });
    } else {
      out.push(message);
    }
  }
  return { session, out };
}

export function render(session: IntakeSession): OutgoingMessage[] {
  return [
    ...session.config.participants.map((p) => renderList(session, p.id)),
    renderOrganizer(session),
  ];
}

function renderList(session: IntakeSession, userId: UserId): OutgoingMessage {
  const { rules } = session.config;
  const ui = session.ui[userId]!;
  const list = ordered(session, userId);
  const number = new Map(list.map((s, i) => [s.id, i + 1]));
  const accepted = list.filter((s) => statusOf(s) === 'accepted').length;
  const lines: string[] = [];

  if (accepted === total(rules)) {
    lines.push(`✅ Все ${total(rules)} треков приняты`, 'Можно менять до закрытия сбора.');
  } else {
    lines.push(`🎵 Твои треки · принято ${accepted} из ${total(rules)}`, 'Проверь названия — по ним судья засчитывает ответы.');
  }

  for (const pool of ['main', 'final'] as const) {
    const inPool = list.filter((s) => s.pool === pool);
    lines.push('', `${POOL_LABEL[pool]} · ${inPool.length} из ${rules.quota[pool]}`);
    for (const s of inPool) lines.push(`${number.get(s.id)}. ${labelOf(s)} ${statusMark(s)}`);
  }
  const rejected = list.filter((s) => s.rejection);
  if (rejected.length > 0) {
    lines.push('', 'Не подошло — пришли замену:');
    for (const s of rejected) lines.push(`${number.get(s.id)}. ${labelOf(s)} — ${REJECT_TEXT[s.rejection!]}`);
  }

  const footer: string[] = [];
  if (ui.notice) footer.push(ui.notice);
  const target = titleTarget(session, userId);
  const { mode } = ui;
  if (target && (mode.kind === 'idle' || mode.kind === 'awaitTitle')) {
    footer.push(
      mode.kind === 'awaitTitle'
        ? `✏️ Трек ${number.get(target.id)}: сейчас «${labelOf(target)}». ${TITLE_FORMAT}`
        : `✏️ Трек ${number.get(target.id)} (${target.file.fileName ?? 'без имени'}): не нашёл название. ${TITLE_FORMAT}`,
    );
  }
  if (mode.kind === 'pick') {
    const verb = { edit: 'исправить', move: 'перенести в другой пул', remove: 'убрать' }[mode.action];
    footer.push(`Какой трек ${verb}?`);
  }
  if (mode.kind === 'swap') {
    const moving = list.find((s) => s.id === mode.submissionId);
    const target = moving?.pool === 'main' ? 'финале' : 'отборе';
    footer.push(`В ${target} нет места. С каким треком поменять «${moving ? labelOf(moving) : ''}»?`);
  }
  if (footer.length > 0) lines.push('', ...footer);

  return { kind: 'message', to: userId, slot: 'list', text: lines.join('\n'), buttons: listButtons(session, userId, list, number) };
}

function listButtons(
  session: IntakeSession,
  userId: UserId,
  list: Submission[],
  number: Map<string, number>,
): Button[][] | undefined {
  const { mode } = session.ui[userId]!;
  const numberRows = (items: Submission[]): Button[][] => {
    const rows: Button[][] = [];
    for (let i = 0; i < items.length; i += 5) {
      rows.push(items.slice(i, i + 5).map((s) => ({ label: String(number.get(s.id)), data: `n:${s.id}` })));
    }
    return [...rows, [{ label: 'Отмена', data: 'cancel' }]];
  };

  if (mode.kind === 'pick') return numberRows(candidates(session, userId, mode.action));
  if (mode.kind === 'swap') {
    const moving = list.find((s) => s.id === mode.submissionId);
    return numberRows(list.filter((s) => s.pool !== null && s.pool !== moving?.pool));
  }
  if (mode.kind === 'awaitTitle') return [[{ label: 'Отмена', data: 'cancel' }]];
  if (list.length === 0) return undefined;
  return [
    [
      { label: '✏️ Исправить', data: 'pick:edit' },
      { label: '⇄ Пул', data: 'pick:move' },
      { label: '🗑 Убрать', data: 'pick:remove' },
    ],
  ];
}

function renderOrganizer(session: IntakeSession): OutgoingMessage {
  const { participants, rules } = session.config;
  const all = session.intake.submissions;
  const count = (status: string) => all.filter((s) => statusOf(s) === status).length;
  const lines = ['📥 Сбор треков', ''];
  for (const p of participants) {
    const own = submissionsOf(session.intake, p.id);
    const accepted = own.filter((s) => statusOf(s) === 'accepted').length;
    const waiting = own.filter((s) => statusOf(s) === 'needs_title').length;
    lines.push(`${accepted === total(rules) ? '✅' : '•'} ${p.name} — ${accepted} из ${total(rules)}${waiting ? ` · ждёт названий: ${waiting}` : ''}`);
  }
  const duplicates = all.filter((s) => s.rejection === 'duplicate_other').length;
  lines.push(
    '',
    `Принято ${count('accepted')} · в обработке ${count('processing')} · без названия ${count('needs_title')} · не подошло ${count('rejected')}`,
    `Дубли между участниками: ${duplicates}`,
  );
  return { kind: 'message', to: session.config.organizer.id, slot: 'intake', text: lines.join('\n') };
}

function labelOf(s: Submission): string {
  return s.meta ? `${s.meta.artist} — ${s.meta.title}` : (s.file.fileName ?? 'без имени');
}

function statusMark(s: Submission): string {
  switch (statusOf(s)) {
    case 'accepted':
      return '✅';
    case 'processing':
      return '⏳';
    case 'needs_title':
      return '✏️';
    case 'rejected':
      return '⚠️';
  }
}

function total(rules: IntakeRules): number {
  return rules.quota.main + rules.quota.final;
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
