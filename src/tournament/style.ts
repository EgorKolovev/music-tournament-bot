import type { Button, OutgoingMessage, UserId } from '../bot/protocol.ts';
import { STYLE_IDS, styleId, styleOf } from '../texts/index.ts';
import { say, stylesOf, textsTo, toast } from './helpers.ts';
import { redrawShown } from './shown.ts';
import type { Step, TournamentState } from './state.ts';

// Стиль текстов бота (src/texts): участник выбирает его командой /style. Стиль меняет только то,
// как бот пишет этому человеку; остальным и организатору — без изменений.
// Стиль с предупреждением (ругательный) включается после подтверждения: сначала человек видит,
// что его ждёт. Вернуться к любому другому стилю можно сразу.

const SLOT = 's:style';

export function askStyle(state: TournamentState, id: UserId): Step {
  if (!state.people[id]) return say(state, id, textsTo(state, id).commands.style.stranger);
  return { state, out: [{ ...styleMessage(state, id), bump: true }] };
}

export function styleButton(state: TournamentState, id: UserId, data: string): Step {
  const person = state.people[id];
  if (person && data === 'back') return { state, out: [styleMessage(state, id)] };
  const [, action, chosen] = /^(set|ok):(\w+)$/.exec(data) ?? [];
  if (!person || !chosen || !STYLE_IDS.includes(chosen)) return toast(state, id, textsTo(state, id).commands.toast.stale);
  if (styleId(person.style) === chosen) return toast(state, id, textsTo(state, id).commands.style.same);
  if (action === 'set' && styleOf(chosen).warning) return { state, out: [confirmMessage(state, id, chosen)] };

  const next = withStyles({ ...state, people: { ...state.people, [id]: { ...person, style: chosen } } });
  const texts = textsTo(next, id).commands.style;
  const confirm: OutgoingMessage = { ...styleMessage(next, id), text: `${texts.chosen({ name: styleOf(chosen).name })}\n\n${styleMessage(next, id).text}` };
  return { state: next, out: [confirm, ...redrawShown(state, next)] };
}

function styleMessage(state: TournamentState, id: UserId): OutgoingMessage {
  const texts = textsTo(state, id).commands.style;
  const current = styleId(state.people[id]?.style);
  const lines = [texts.title, texts.current({ name: styleOf(current).name }), '', texts.about, ''];
  // Мат в примере — только тем, кто этот стиль уже выбрал.
  for (const style of STYLE_IDS) {
    const { name, sample, sampleBleeped } = styleOf(style);
    lines.push(`${name} — «${style === current ? sample : (sampleBleeped ?? sample)}»`);
  }
  const buttons: Button[][] = [];
  for (let i = 0; i < STYLE_IDS.length; i += 2) {
    buttons.push(
      STYLE_IDS.slice(i, i + 2).map((style) => ({ label: `${style === current ? '✅ ' : ''}${styleOf(style).name}`, data: `s:set:${style}` })),
    );
  }
  return { kind: 'message', to: id, slot: SLOT, text: lines.join('\n'), buttons };
}

function confirmMessage(state: TournamentState, id: UserId, chosen: string): OutgoingMessage {
  const texts = textsTo(state, id).commands.style;
  const style = styleOf(chosen);
  return {
    kind: 'message',
    to: id,
    slot: SLOT,
    text: [style.name, '', style.warning, '', texts.confirmBack].join('\n'),
    buttons: [[{ label: texts.confirmYes, data: `s:ok:${chosen}` }, { label: texts.confirmNo, data: 's:back' }]],
  };
}

// Стили участников — во все открытые сессии: новые сообщения и перерисовки пойдут в новом стиле.
function withStyles(state: TournamentState): TournamentState {
  const styles = stylesOf(state);
  const matches = Object.fromEntries(
    Object.entries(state.matches).map(([id, m]) => [id, { ...m, session: { ...m.session, config: { ...m.session.config, styles } } }]),
  );
  const final = state.final && {
    ...state.final,
    config: { ...state.final.config, styles },
    current: state.final.current && {
      ...state.final.current,
      session: { ...state.final.current.session, config: { ...state.final.current.session.config, styles } },
    },
  };
  return {
    ...state,
    intake: { ...state.intake, config: { ...state.intake.config, styles } },
    draw: state.draw && { ...state.draw, config: { ...state.draw.config, styles } },
    matches,
    final,
  };
}
