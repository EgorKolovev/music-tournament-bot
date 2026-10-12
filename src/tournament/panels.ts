import { eliminated, formatDate, matchLabel, matchPlayers, qualifiedIds, qualifiersDone, render as renderDraw } from '../bot/drawSession.ts';
import { renderOrganizer as renderFinalOrganizer } from '../bot/finalSession.ts';
import { acceptedCount, admittedPlayers, isSongsOnly, readyForDraw, render as renderIntake } from '../bot/intakeSession.ts';
import type { Button, OutgoingMessage, UserId } from '../bot/protocol.ts';
import { findMatch, openMatches, playedMatches, qualified } from '../domain/bracket/bracket.ts';
import { formatPoints, type Ruleset } from '../domain/match/ruleset.ts';
import { plural } from '../shared/text.ts';
import { isoDate, isParticipant, matchTitle, panelHolders, participant, scoreLine, whoIs } from './helpers.ts';
import { techCandidates, withdrawCandidates } from './organizer.ts';
import { finalistIds } from './stages.ts';
import { ORG, type MatchRuntime, type PanelScreen, type Step, type TournamentState } from './state.ts';
import { matchProgress } from './status.ts';

// Панель админа (docs/decisions/2026-10-13-admin-panel.md): одно сообщение на админа, бот правит
// его на месте. Главный экран — этап и сводка; разделы — сбор, сетка, матчи, участники, финал,
// настройки. Панели сбора, сетки и финала рисуют сессии этапов — здесь они становятся разделами.
// Отдельными сообщениями приходят только уведомления о спорах; у игроков — кнопка спора.
//
// Кнопки действий — те же данные, что и до панели (o:closeIntake, o:techOk, o:shift:1…): бот
// восстанавливает турнир, повторяя журнал, и старые события должны значить то же самое.
// Новые — только переходы: o:v:<раздел>, o:m:<матч>, o:p:<участник>, o:open:<матч>.

const PANEL_SLOT = 'o:phase';
const HOME: Button = { label: '⬅️ К турниру', data: 'o:v:home' };
const CANCEL: Button = { label: 'Отмена', data: 'o:menu:close' };

interface Screen {
  text: string;
  buttons: Button[][];
}

// Сообщения, которые рисует сам оркестратор, а не сессии этапов. Отправляются только изменившиеся.
export function renderExtras(state: TournamentState): OutgoingMessage[] {
  const holders = panelHolders(state);
  const out: OutgoingMessage[] = holders.map((id) => adminPanel(state, id));
  for (const [matchId, runtime] of Object.entries(state.matches)) {
    if (runtime.decidedAt === undefined) continue;
    const { config, match } = runtime.session;
    const { phase } = match;
    config.players.forEach((player, slot) => {
      const confirmed = (phase.kind === 'decided' && phase.playersConfirmed[slot]) || phase.kind === 'finished';
      let text: string;
      let buttons: Button[][] | undefined;
      if (runtime.dispute) text = runtime.dispute.by === player.id ? '⚠️ Спор передан организатору.' : '⚠️ Соперник оспорил результат — решает организатор.';
      else if (runtime.closed || confirmed) text = `Матч №${config.matchNo}: результат зафиксирован.`;
      else {
        text = `Не согласен с результатом матча №${config.matchNo}? Организатор разберётся.`;
        buttons = [[{ label: '⚠️ Оспорить', data: `x:dispute:${matchId}` }]];
      }
      out.push({ kind: 'message', to: player.id, slot: `x:${matchId}#${runtime.attempt}`, text, buttons });
    });
    if (runtime.dispute || runtime.confirmEscalated) out.push(...holders.map((id) => issueNotice(state, matchId, runtime, id)));
  }
  return out;
}

// Панель админа на том разделе, где он её оставил.
export function adminPanel(state: TournamentState, holder: UserId): OutgoingMessage {
  const { text, buttons } = screen(state, screenOf(state, holder));
  return { kind: 'message', to: holder, slot: PANEL_SLOT, text, buttons: buttons.length ? buttons : undefined };
}

// Админ потерял панель в ленте или открыл её из уведомления — присылаем внизу.
export function resendPanels(state: TournamentState, holder: UserId): Step {
  return { state, out: [{ ...adminPanel(state, holder), bump: true }] };
}

// Уведомление о споре или неподтверждённом результате; решение — в карточке матча.
function issueNotice(state: TournamentState, matchId: string, runtime: MatchRuntime, to: UserId): OutgoingMessage {
  const { config } = runtime.session;
  const title = matchTitle(state, matchId);
  const lines = [runtime.dispute ? `⚠️ Спор по матчу ${title}` : `⏳ Результат матча ${title} не подтверждён 10 минут`, scoreLine(runtime.session)];
  if (runtime.dispute) lines.push(`Оспорил: ${participant(state, runtime.dispute.by).name}. Судья: ${config.judge.name}.`);
  if (runtime.closed) lines.push('', '✅ Решено.');
  const buttons = runtime.closed ? undefined : [[{ label: '🔎 Открыть в панели', data: `o:open:${matchId}` }]];
  return { kind: 'message', to, slot: `o:issue:${matchId}#${runtime.attempt}`, text: lines.join('\n'), buttons };
}

// Раздел, который можно показать сейчас: сетки ещё нет, матч или участник пропали — шаг назад.
export function screenOf(state: TournamentState, holder: UserId): PanelScreen {
  const saved = state.panels?.[holder] ?? 'home';
  const bracket = state.draw?.bracket;
  if (saved === 'bracket') return state.draw ? saved : 'home';
  if (saved === 'matches') return bracket ? saved : 'home';
  if (saved === 'final') return state.final ? saved : 'home';
  if (saved.startsWith('match:')) return bracket && findMatch(bracket, saved.slice(6)) ? saved : 'home';
  if (saved.startsWith('player:')) return state.people[saved.slice(7)] ? saved : 'players';
  return saved;
}

function screen(state: TournamentState, current: PanelScreen): Screen {
  if (current.startsWith('match:')) return matchScreen(state, current.slice(6));
  if (current.startsWith('player:')) return playerScreen(state, current.slice(7));
  switch (current) {
    case 'intake':
      return withBack(sessionPanel(renderIntake(state.intake), 'intake'));
    case 'bracket':
      return withBack(sessionPanel(renderDraw(state.draw!), 'draw'));
    case 'final':
      return withBack(sessionPanel([renderFinalOrganizer(state.final!)], 'final'));
    case 'matches':
      return matchesScreen(state);
    case 'players':
      return playersScreen(state);
    case 'settings':
      return settingsScreen(state);
    default:
      return homeScreen(state);
  }
}

// Панель, которую сессия этапа рисует для организатора, с кнопками в пространстве o:.
function sessionPanel(messages: OutgoingMessage[], slot: string): Screen {
  const panel = messages.find((m) => m.to === ORG && m.slot === slot);
  if (!panel) return { text: '—', buttons: [] };
  const buttons = (panel.buttons ?? []).map((row) => row.map((b) => ({ ...b, data: `o:${b.data}` })));
  return { text: panel.text, buttons };
}

function withBack({ text, buttons }: Screen, back: Button = HOME): Screen {
  return { text, buttons: [...buttons, [back]] };
}

// --- Главный экран ------------------------------------------------------------------

function homeScreen(state: TournamentState): Screen {
  const { config } = state;
  const people = Object.values(state.people);
  const lines = [`📣 ${config.title}`, ''];
  const buttons: Button[][] = [];
  switch (state.phase) {
    case 'intake': {
      lines.push(
        'Этап: регистрация и сбор песен',
        `Ссылка-приглашение: https://t.me/${config.botUsername}?start=t_${config.code}`,
        `Зарегистрировано: ${people.length}${songsOnlyCount(state) > 0 ? ` · только песни: ${songsOnlyCount(state)}` : ''}`,
      );
      buttons.push([
        { label: '🎵 Сбор', data: 'o:v:intake' },
        { label: '👥 Участники', data: 'o:v:players' },
      ]);
      if (readyForDraw(state.intake)) {
        lines.push('', `Допущено к жеребьёвке: ${admittedPlayers(state.intake).length}, финалистов: ${config.finalists}`);
        buttons.push([{ label: '🎲 К жеребьёвке', data: 'o:toDraw' }]);
      }
      break;
    }
    case 'qualifiers': {
      const draw = state.draw!;
      if (!draw.bracket) {
        lines.push('Этап: отбор', 'Жеребьёвка ещё не проведена — она в разделе «Сетка».');
        buttons.push([
          { label: '🎲 Сетка', data: 'o:v:bracket' },
          { label: '👥 Участники', data: 'o:v:players' },
        ]);
        break;
      }
      const all = playedMatches(draw.bracket);
      const live = Object.values(state.matches).filter((m) => !m.closed);
      const noJudge = openMatches(draw.bracket, draw.results).filter((m) => !draw.judges[m.id]);
      lines.push('Этап: отбор', `Сыграно ${Object.keys(draw.results).length} из ${all.length} · идут ${live.length} · без судьи ${noJudge.length}`);
      // Пара без судьи — обычный первый шаг матча, а не повод вмешаться: она только в счётчике.
      const attention = Object.entries(state.matches)
        .filter(([, m]) => !m.closed && (m.dispute || m.confirmEscalated))
        .map(([id, m]) => `${m.dispute ? 'спор' : 'не подтверждён'} ${matchCode(state, id)}`);
      if (attention.length > 0) lines.push('', `⚠️ Требует внимания: ${attention.join(', ')}`);
      if (state.withdrawn.length > 0) lines.push(`🚪 Сняты: ${state.withdrawn.map((id) => participant(state, id).name).join(', ')}`);
      buttons.push([
        { label: '🗺 Сетка', data: 'o:v:bracket' },
        { label: '🎤 Матчи', data: 'o:v:matches' },
        { label: '👥 Участники', data: 'o:v:players' },
      ]);
      if (qualifiersDone(draw)) buttons.push([{ label: '🏆 Отбор завершён — к финалу', data: 'o:toFinal' }]);
      break;
    }
    case 'final': {
      lines.push('Этап: финал', `Финалисты: ${finalistIds(state).map((id) => participant(state, id).name).join(', ')}`);
      const row: Button[] = state.final ? [{ label: '🏆 Финал', data: 'o:v:final' }] : [];
      buttons.push([...row, { label: '👥 Участники', data: 'o:v:players' }]);
      if (!state.final) {
        lines.push(
          state.finalJudge
            ? `Судья финала: ${state.finalJudge.name}`
            : `Судья финала не назначен. Отправьте ему ссылку: https://t.me/${config.botUsername}?start=fjudge_${config.code}`,
        );
        if (state.finalJudge) buttons.push([{ label: '▶️ Открыть финал', data: 'o:openFinal' }]);
      } else if (qualified(state.final.bracket, state.final.results)[0]) {
        buttons.push([{ label: '🏁 Завершить турнир', data: 'o:archive' }]);
      }
      break;
    }
    case 'archive': {
      const champion = state.final && qualified(state.final.bracket, state.final.results)[0];
      lines.push(`🏁 Турнир завершён${champion ? `. Победитель — ${participant(state, champion).name}` : ''}.`);
      const row: Button[] = state.final ? [{ label: '🏆 Финал', data: 'o:v:final' }] : [];
      buttons.push([...row, { label: '👥 Участники', data: 'o:v:players' }]);
      break;
    }
  }
  buttons.push([{ label: '⚙️ Настройки', data: 'o:v:settings' }]);
  return { text: lines.join('\n'), buttons };
}

function songsOnlyCount(state: TournamentState): number {
  return state.intake.config.songsOnly?.length ?? 0;
}

function matchCode(state: TournamentState, matchId: string): string {
  const match = state.draw?.bracket && findMatch(state.draw.bracket, matchId);
  return match ? matchLabel(match) : matchId;
}

// --- Матчи отбора -----------------------------------------------------------------

function matchesScreen(state: TournamentState): Screen {
  const draw = state.draw!;
  const bracket = draw.bracket!;
  const open = openMatches(bracket, draw.results);
  const runtimeOf = (id: string) => (state.matches[id] && !state.matches[id]!.closed ? state.matches[id] : undefined);
  const attention = open.filter((m) => {
    const runtime = runtimeOf(m.id);
    return runtime?.dispute || runtime?.confirmEscalated;
  });
  const live = open.filter((m) => !attention.includes(m) && runtimeOf(m.id));
  const waiting = open.filter((m) => !attention.includes(m) && !live.includes(m));
  const icon = (id: string) => {
    const runtime = runtimeOf(id);
    if (runtime?.dispute) return '⚠️';
    if (runtime && !runtime.confirmEscalated) return '🎤';
    return '⏳';
  };
  const line = (id: string) => `${icon(id)} ${matchTitle(state, id)} · ${matchProgress(state, id)}`;
  const group = (title: string, ids: string[]) => (ids.length > 0 ? ['', title, ...ids.map(line)] : []);
  const ids = (list: typeof open) => list.map((m) => m.id);
  const lines = [
    `🎤 Матчи · сыграно ${Object.keys(draw.results).length} из ${playedMatches(bracket).length}`,
    ...group('Требуют внимания:', ids(attention)),
    ...group('Идут:', ids(live)),
    ...group('Ждут начала:', ids(waiting)),
    '',
    open.length > 0 ? 'Сыгранные — в «Сетке». Кнопкой открывается любой незакрытый матч.' : 'Открытых матчей нет. Сыгранные — в «Сетке».',
  ];
  const buttons = [...attention, ...live, ...waiting].map((m) => [{ label: `${icon(m.id)} ${matchTitle(state, m.id)}`, data: `o:m:${m.id}` }]);
  return withBack({ text: lines.join('\n'), buttons });
}

function matchScreen(state: TournamentState, matchId: string): Screen {
  const draw = state.draw!;
  const match = findMatch(draw.bracket!, matchId)!;
  const players = matchPlayers(draw, matchId);
  const runtime = state.matches[matchId];
  const live = runtime && !runtime.closed ? runtime : undefined;
  const winner = draw.results[matchId];
  const deadline = draw.deadlines[match.round - 1];
  const assignment = draw.judges[matchId];

  const lines = [`🎤 Матч ${matchLabel(match)} · ${match.round}-й круг${deadline ? `, до ${formatDate(deadline)}` : ''}`];
  lines.push(players ? players.map((id) => whoIs(state, id)).join(' — ') : 'Пара ещё не определилась');
  if (live) lines.push(`Судья: ${whoIs(state, live.session.config.judge.id)}`);
  else if (assignment && !winner) lines.push(`Судья: ${whoIs(state, assignment.candidate)}${assignment.accepted ? '' : ' — ждём ответа'}`);
  lines.push('');
  const buttons: Button[][] = [];
  const issue = live && (live.dispute || live.confirmEscalated);
  if (winner) lines.push(`🏅 Проходит ${participant(state, winner).name}`);
  else if (players && !issue) lines.push(`Шаг: ${matchProgress(state, matchId)}`);

  if (live && issue) {
    const { phase } = live.session.match;
    lines.push(live.dispute ? `⚠️ Спор. Оспорил: ${participant(state, live.dispute.by).name}.` : '⏳ Результат не подтверждён 10 минут.');
    if (phase.kind === 'decided' || phase.kind === 'finished') {
      lines.push(`По протоколу побеждает ${live.session.config.players[phase.winner].name}: ${scoreLine(live.session)}.`);
      buttons.push([
        { label: '✅ Оставить результат', data: `o:keep:${matchId}` },
        { label: '🔁 Переиграть', data: `o:replay:${matchId}` },
      ]);
    }
  }

  const menu = state.adminMenu;
  const name = (id: UserId) => participant(state, id).name;
  if (menu?.kind === 'techWinner' && menu.matchId === matchId && players) {
    lines.push('', '⚖️ Кому засчитать техническую победу?');
    buttons.push(players.map((id) => ({ label: `🏆 ${name(id)}`, data: `o:techWin:${matchId}:${id}` })), [CANCEL]);
  } else if (menu?.kind === 'techConfirm' && menu.matchId === matchId) {
    lines.push('', `⚖️ Засчитать техническую победу: ${name(menu.winner)}?`, 'Матч закроется, игрокам и судье придёт уведомление. Отменить нельзя.');
    buttons.push([{ label: '✅ Засчитать', data: 'o:techOk' }, CANCEL]);
  } else if (techCandidates(state).includes(matchId)) {
    buttons.push([{ label: '⚖️ Техническая победа', data: `o:techMatch:${matchId}` }]);
  }
  buttons.push([{ label: '⬅️ К матчам', data: 'o:v:matches' }]);
  return { text: lines.join('\n'), buttons };
}

// --- Участники -------------------------------------------------------------------------

function playersScreen(state: TournamentState): Screen {
  const people = Object.values(state.people).sort((a, b) => a.number - b.number);
  const lines = [`👥 Участники · ${people.length}`, ''];
  if (people.length === 0) lines.push('Пока никого — отправьте ссылку-приглашение.');
  for (const p of people) lines.push(`№${p.number} ${whoIs(state, p.id)} · ${shortStatus(state, p.id)}`);
  const buttons: Button[][] = [];
  for (let i = 0; i < people.length; i += 2) {
    buttons.push(people.slice(i, i + 2).map((p) => ({ label: `№${p.number} ${p.name}`, data: `o:p:${p.id}` })));
  }
  return withBack({ text: lines.join('\n'), buttons });
}

function playerScreen(state: TournamentState, id: UserId): Screen {
  const person = state.people[id]!;
  const lines = [`№${person.number} ${person.name}`];
  if (person.username) lines.push(`Telegram: @${person.username}${person.profileName ? ` · ${person.profileName}` : ''}`);
  else lines.push(`Telegram: без ника${person.profileName ? ` · ${person.profileName}` : ''}`);
  lines.push(`Регистрация: ${formatDate(isoDate(person.registeredAt))}`, '', shortStatus(state, id));

  const draw = state.draw;
  if (draw?.bracket) {
    const current = openMatches(draw.bracket, draw.results).find((m) => matchPlayers(draw, m.id)?.includes(id));
    if (current) lines.push(`Матч ${matchTitle(state, current.id)}: ${matchProgress(state, current.id)}`);
    for (const match of playedMatches(draw.bracket)) {
      const assignment = draw.judges[match.id];
      if (assignment?.candidate !== id || draw.results[match.id]) continue;
      lines.push(`⚖️ Судит ${matchTitle(state, match.id)}${assignment.accepted ? '' : ' — позвали, ждём ответа'}`);
    }
  }

  const buttons: Button[][] = [];
  if (person.username) buttons.push([{ label: '💬 Написать в Telegram', data: '', url: `https://t.me/${person.username}` }]);
  // Играет или только присылает песни — меняется, пока идёт сбор.
  if (state.phase === 'intake' && !state.intake.closed && isParticipant(state, id)) {
    buttons.push([
      isSongsOnly(state.intake, id)
        ? { label: '🎤 Вернуть в игроки', data: `o:player:${id}` }
        : { label: '🎁 Только песни, не играет', data: `o:songsOnly:${id}` },
    ]);
  }
  const menu = state.adminMenu;
  if (menu?.kind === 'withdrawConfirm' && menu.userId === id) {
    lines.push('', `🚪 Снять ${person.name} с турнира?`, 'Текущий матч засчитается сопернику, в каждом следующем — техническое поражение. Отменить нельзя.');
    buttons.push([{ label: '🚪 Снять', data: 'o:withdrawOk' }, CANCEL]);
  } else if (state.phase === 'qualifiers' && draw?.bracket && withdrawCandidates(state).includes(id)) {
    buttons.push([{ label: '🚪 Снять с турнира', data: `o:withdrawPick:${id}` }]);
  }
  buttons.push([{ label: '⬅️ К участникам', data: 'o:v:players' }]);
  return { text: lines.join('\n'), buttons };
}

// Положение участника одной строкой — для списка.
function shortStatus(state: TournamentState, id: UserId): string {
  const draw = state.draw;
  const songsOnly = isSongsOnly(state.intake, id);
  if (state.phase === 'intake') {
    if (!isParticipant(state, id)) return 'не в сборе';
    return `${songsOnly ? '🎁 только песни · ' : ''}песен: ${acceptedCount(state.intake, id)} из ${state.config.intakeRules.maxSubmissions}`;
  }
  if (songsOnly) return '🎁 только песни';
  if (!draw?.config.players.some((p) => p.id === id)) return 'не играет';
  if (state.withdrawn.includes(id)) return state.left?.includes(id) ? '🚪 вышел сам' : '🚪 снятие с турнира';
  const champion = state.final && qualified(state.final.bracket, state.final.results)[0];
  if (champion === id) return '🏆 победитель';
  if (!draw.bracket) return 'ждёт жеребьёвки';
  const current = openMatches(draw.bracket, draw.results).find((m) => matchPlayers(draw, m.id)?.includes(id));
  if (current) return `🎤 матч ${matchLabel(current)}`;
  if (eliminated(draw, id)) return '✖ выбывание в отборе';
  if (qualifiedIds(draw).includes(id)) return '🏆 в финале';
  return '⏳ ждёт пару';
}

// --- Настройки ---------------------------------------------------------------------

export function settingsText(state: TournamentState): string {
  const { config } = state;
  return [
    `⚙️ Настройки · ${config.title}`,
    `Ссылка-приглашение: https://t.me/${config.botUsername}?start=t_${config.code}`,
    '',
    `Финалистов: ${config.finalists}`,
    `Песен на игрока: до ${config.intakeRules.maxSubmissions}`,
    `Длина фрагмента: ${config.fragmentSec} с`,
    `Финальный пул: ${config.finalPoolTarget} ${plural(config.finalPoolTarget, 'песня', 'песни', 'песен')}`,
    `Срок круга: ${config.roundDays} ${plural(config.roundDays, 'день', 'дня', 'дней')}`,
    `Отбор: ${rulesetText(config.qualifierRuleset)}`,
    `Финал: ${rulesetText(config.finalRuleset)}`,
    `Seed: ${config.seed}`,
  ].join('\n');
}

function settingsScreen(state: TournamentState): Screen {
  const text = [settingsText(state), '', 'Настройки задаются при создании турнира.', 'Переименовать: /rename <название>.'].join('\n');
  return withBack({ text, buttons: [] });
}

function rulesetText(ruleset: Ruleset): string {
  const { format } = ruleset;
  const length =
    format.kind === 'fixed'
      ? `${format.tracks} ${plural(format.tracks, 'трек', 'трека', 'треков')}`
      : `до ${formatPoints(format.winThreshold)}, не больше ${format.trackLimit} ${plural(format.trackLimit, 'трека', 'треков', 'треков')}`;
  return `${length}; исполнитель ${formatPoints(ruleset.artistPoints)}, название ${formatPoints(ruleset.titlePoints)}`;
}
