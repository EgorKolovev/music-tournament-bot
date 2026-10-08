import { useEffect, useMemo, useState } from 'react';
import type { Incoming } from '../bot/protocol.ts';
import { demoConfig } from '../scenarios/demoConfig.ts';
import { initialFrame, nextFrame, runScenario, type Frame } from '../scenarios/runner.ts';
import { SCENARIOS } from '../scenarios/scenarios.ts';
import { ChatColumn } from './ChatColumn.tsx';
import { Inspector } from './Inspector.tsx';

const MANUAL = 'manual';
const PLAY_INTERVAL_MS = 450;

export function App() {
  const config = useMemo(() => demoConfig(), []);
  const [scenarioId, setScenarioId] = useState<string>(SCENARIOS[0]!.id);
  const [frames, setFrames] = useState<Frame[]>(() => runScenario(config, SCENARIOS[0]!));
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);

  const scenario = SCENARIOS.find((s) => s.id === scenarioId);
  const frame = frames[cursor]!;
  const atEnd = cursor === frames.length - 1;

  useEffect(() => {
    if (!playing) return;
    if (atEnd) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setCursor((c) => c + 1), PLAY_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [playing, atEnd, cursor]);

  function selectScenario(id: string) {
    setPlaying(false);
    setScenarioId(id);
    const selected = SCENARIOS.find((s) => s.id === id);
    setFrames(selected ? runScenario(config, selected) : [initialFrame(config)]);
    setCursor(0);
  }

  // Ручное нажатие обрезает «будущее» и продолжает историю от текущего кадра.
  function press(input: Incoming) {
    setPlaying(false);
    const next = nextFrame(frame, input);
    setFrames([...frames.slice(0, cursor + 1), next]);
    setCursor(cursor + 1);
    if (!atEnd) setScenarioId(MANUAL);
  }

  const participants = [
    { user: config.judge, role: 'Судья' },
    { user: config.players[0], role: 'Игрок' },
    { user: config.players[1], role: 'Игрок' },
  ];

  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand">
          <h1>Симулятор матча</h1>
          <span className="muted">бот без Telegram · dev</span>
        </div>
        <label className="scenario-select">
          <span className="muted">Сценарий</span>
          <select value={scenarioId} onChange={(e) => selectScenario(e.target.value)}>
            {SCENARIOS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
            <option value={MANUAL}>Вручную, с чистого листа</option>
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
        {scenario && <p className="description">{scenario.description}</p>}
      </header>

      <main className="layout">
        <section className="chats">
          {participants.map(({ user, role }) => (
            <ChatColumn
              key={user.id}
              name={user.name}
              role={role}
              chat={frame.chats[user.id]}
              toasts={frame.out.filter((o) => o.kind === 'toast' && o.to === user.id).map((o) => o.text)}
              pressedData={frame.input?.from === user.id ? frame.input.data : undefined}
              onPress={(data) => press({ kind: 'button', from: user.id, data })}
            />
          ))}
        </section>
        <Inspector frames={frames} cursor={cursor} onJump={(i) => (setPlaying(false), setCursor(i))} />
      </main>
    </div>
  );
}
