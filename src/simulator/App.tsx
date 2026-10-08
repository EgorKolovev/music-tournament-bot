import { useEffect, useMemo, useState } from 'react';
import type { IntakeSession } from '../bot/intakeSession.ts';
import type { MatchSession } from '../bot/matchSession.ts';
import type { Incoming } from '../bot/protocol.ts';
import type { Engine, Scenario } from '../scenarios/engine.ts';
import { intakeEngine, matchEngine } from '../scenarios/engines.ts';
import { INTAKE_SCENARIOS } from '../scenarios/intakeScenarios.ts';
import { MATCH_SCENARIOS } from '../scenarios/matchScenarios.ts';
import { initialFrame, nextFrame, runScenario, type Frame } from '../scenarios/runner.ts';
import { ChatColumn } from './ChatColumn.tsx';
import { IntakeInspector } from './IntakeInspector.tsx';
import { Inspector } from './Inspector.tsx';

const PLAY_INTERVAL_MS = 450;

// Сессии движков разные; симулятор работает с ними одинаково через кадры.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEngine = Engine<any>;

const ENGINES: Record<Scenario['engine'], AnyEngine> = { match: matchEngine(), intake: intakeEngine() };

const GROUPS: { engine: Scenario['engine']; label: string; scenarios: Scenario[] }[] = [
  { engine: 'intake', label: 'Сбор треков', scenarios: INTAKE_SCENARIOS },
  { engine: 'match', label: 'Матч', scenarios: MATCH_SCENARIOS },
];

const manualId = (engine: Scenario['engine']) => `manual:${engine}`;

function framesFor(selection: string): Frame<unknown>[] {
  const scenario = [...INTAKE_SCENARIOS, ...MATCH_SCENARIOS].find((s) => s.id === selection);
  if (scenario) return runScenario(ENGINES[scenario.engine], scenario);
  return [initialFrame(ENGINES[engineOf(selection)])];
}

function engineOf(selection: string): Scenario['engine'] {
  const scenario = [...INTAKE_SCENARIOS, ...MATCH_SCENARIOS].find((s) => s.id === selection);
  return scenario?.engine ?? (selection.split(':')[1] as Scenario['engine']);
}

export function App() {
  const [selection, setSelection] = useState<string>(INTAKE_SCENARIOS[0]!.id);
  const [frames, setFrames] = useState<Frame<unknown>[]>(() => framesFor(INTAKE_SCENARIOS[0]!.id));
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);

  const engine = ENGINES[engineOf(selection)];
  const scenario = [...INTAKE_SCENARIOS, ...MATCH_SCENARIOS].find((s) => s.id === selection);
  const frame = frames[cursor]!;
  const atEnd = cursor === frames.length - 1;
  const workerEvent = useMemo(() => engine.workerEvent(frame.session), [engine, frame]);

  useEffect(() => {
    if (!playing) return;
    if (atEnd) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setCursor((c) => c + 1), PLAY_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [playing, atEnd, cursor]);

  function select(id: string) {
    setPlaying(false);
    setSelection(id);
    setFrames(framesFor(id));
    setCursor(0);
  }

  // Ручное действие обрезает «будущее» и продолжает историю от текущего кадра.
  function act(input: Incoming) {
    setPlaying(false);
    setFrames([...frames.slice(0, cursor + 1), nextFrame(engine, frame, input)]);
    setCursor(cursor + 1);
    if (!atEnd) setSelection(manualId(engine.id));
  }

  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand">
          <h1>Симулятор бота</h1>
          <span className="muted">без Telegram · dev</span>
        </div>
        <label className="scenario-select">
          <span className="muted">Сценарий</span>
          <select value={selection} onChange={(e) => select(e.target.value)}>
            {GROUPS.map((group) => (
              <optgroup key={group.engine} label={group.label}>
                {group.scenarios.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
                <option value={manualId(group.engine)}>Вручную, с чистого листа</option>
              </optgroup>
            ))}
          </select>
        </label>
        <div className="controls">
          <button onClick={() => setCursor(0)} disabled={cursor === 0} title="В начало">
            ⏮
          </button>
          <button onClick={() => setCursor(cursor - 1)} disabled={cursor === 0} title="Шаг назад">
            ◀
          </button>
          <button onClick={() => setPlaying(!playing)} disabled={atEnd && !playing} className="primary">
            {playing ? '⏸ Стоп' : '▶ Играть'}
          </button>
          <button onClick={() => setCursor(cursor + 1)} disabled={atEnd} title="Шаг вперёд">
            ▶
          </button>
          <button onClick={() => setCursor(frames.length - 1)} disabled={atEnd} title="В конец">
            ⏭
          </button>
          <span className="step-counter">
            шаг {cursor} / {frames.length - 1}
          </span>
        </div>
        <input
          className="timeline"
          type="range"
          min={0}
          max={frames.length - 1}
          value={cursor}
          onChange={(e) => {
            setPlaying(false);
            setCursor(Number(e.target.value));
          }}
          aria-label="Шаг сценария"
        />
        <p className="description">
          {scenario?.description ?? `${engine.title}: действуйте за участников сами.`}
        </p>
      </header>

      <main className="layout">
        <section className="chats">
          {engine.columns.map(({ user, caption, role }) => (
            <ChatColumn
              key={user.id}
              name={user.name}
              role={caption}
              chat={frame.chats[user.id]}
              toasts={frame.out.filter((o) => o.kind === 'toast' && o.to === user.id).map((o) => o.text)}
              pressedData={frame.input?.kind === 'button' && frame.input.from === user.id ? frame.input.data : undefined}
              catalog={engine.composer && role !== 'org' ? engine.catalog : undefined}
              onInput={(input) => act({ ...input, from: user.id } as Incoming)}
            />
          ))}
        </section>
        {engine.id === 'match' ? (
          <Inspector frames={frames as Frame<MatchSession>[]} cursor={cursor} onJump={(i) => (setPlaying(false), setCursor(i))} />
        ) : (
          <IntakeInspector
            frames={frames as Frame<IntakeSession>[]}
            cursor={cursor}
            onJump={(i) => (setPlaying(false), setCursor(i))}
            names={new Map(engine.columns.map((c) => [c.user.id, c.user.name]))}
            pendingJobs={workerEvent?.kind === 'worker' ? workerEvent.results.length : 0}
            onWorker={() => workerEvent && act(workerEvent)}
          />
        )}
      </main>
    </div>
  );
}
