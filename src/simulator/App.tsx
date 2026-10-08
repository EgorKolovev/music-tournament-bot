import { useEffect, useMemo, useState } from 'react';
import type { DrawSession } from '../bot/drawSession.ts';
import type { FinalSession } from '../bot/finalSession.ts';
import type { IntakeSession } from '../bot/intakeSession.ts';
import type { MatchSession } from '../bot/matchSession.ts';
import type { Incoming } from '../bot/protocol.ts';
import { DEMO_USERS } from '../scenarios/demoConfig.ts';
import { ALL_PEOPLE } from '../scenarios/engines.ts';
import { initialFrame, nextFrame, runScenario, type Frame } from '../scenarios/runner.ts';
import { ChatColumn } from './ChatColumn.tsx';
import { DrawInspector } from './DrawInspector.tsx';
import { FinalInspector } from './FinalInspector.tsx';
import { IntakeInspector } from './IntakeInspector.tsx';
import { Inspector } from './Inspector.tsx';
import { Overview } from './Overview.tsx';
import { STAGES, stageById, type Stage } from './stages.ts';

const PLAY_INTERVAL_MS = 450;
const MANUAL = 'manual';
const NAMES = new Map(ALL_PEOPLE.map((p) => [p.id, p.name]));
const HIGHLIGHT = new Set([DEMO_USERS.p0.id, DEMO_USERS.p1.id]);

interface Location {
  stage: Stage | null;
  scenarioId: string;
  // Шаг, с которого открыть сценарий: номер или end.
  at?: string;
}

// Адрес вида #final/final-offline/end открывает нужный сценарий сразу — удобно на презентации.
function readHash(): Location {
  const [stageId, scenarioId, at] = window.location.hash.replace(/^#/, '').split('/');
  const stage = stageById(stageId ?? '') ?? null;
  if (!stage) return { stage: null, scenarioId: '' };
  const known = stage.scenarios.some((s) => s.id === scenarioId) || scenarioId === MANUAL;
  return { stage, scenarioId: known ? scenarioId! : stage.scenarios[0]!.id, at };
}

function framesFor(stage: Stage, scenarioId: string): Frame<unknown>[] {
  const scenario = stage.scenarios.find((s) => s.id === scenarioId);
  return scenario ? runScenario(stage.engine, scenario) : [initialFrame(stage.engine)];
}

export function App() {
  const [location, setLocation] = useState<Location>(() =>
    typeof window === 'undefined' ? { stage: null, scenarioId: '' } : readHash(),
  );

  useEffect(() => {
    const onHash = () => setLocation(readHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = (stage: Stage | null, scenarioId?: string) => {
    const hash = stage ? `#${stage.id}/${scenarioId ?? stage.scenarios[0]!.id}` : '#';
    if (window.location.hash !== hash) window.location.hash = hash;
    else setLocation(readHash());
  };

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={() => go(null)}>
          <span className="logo" aria-hidden>
            🎵
          </span>
          <span>
            <strong>Музыкальный турнир</strong>
            <span className="muted small"> · демо-стенд бота</span>
          </span>
        </button>
        <nav className="stage-tabs" aria-label="Этапы турнира">
          <button className={!location.stage ? 'active' : ''} onClick={() => go(null)}>
            Обзор
          </button>
          {STAGES.map((stage) => (
            <button key={stage.id} className={location.stage?.id === stage.id ? 'active' : ''} onClick={() => go(stage)}>
              <span className="step-number">{stage.number}</span> {stage.title}
            </button>
          ))}
        </nav>
      </header>

      {location.stage ? (
        <StageView
          key={`${location.stage.id}/${location.scenarioId}`}
          stage={location.stage}
          scenarioId={location.scenarioId}
          at={location.at}
          onScenario={(id) => go(location.stage, id)}
        />
      ) : (
        <Overview onOpen={(stage) => go(stage)} />
      )}
    </div>
  );
}

interface StageViewProps {
  stage: Stage;
  scenarioId: string;
  at?: string;
  onScenario: (id: string) => void;
}

export function StageView({ stage, scenarioId, at, onScenario }: StageViewProps) {
  const [frames, setFrames] = useState<Frame<unknown>[]>(() => framesFor(stage, scenarioId));
  const [cursor, setCursor] = useState(() =>
    at === 'end' ? frames.length - 1 : Math.min(Math.max(Number(at) || 0, 0), frames.length - 1),
  );
  const [playing, setPlaying] = useState(false);
  const [manual, setManual] = useState(scenarioId === MANUAL);

  const { engine } = stage;
  const scenario = stage.scenarios.find((s) => s.id === scenarioId);
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

  // Ручное действие обрезает «будущее» и продолжает историю от текущего кадра.
  function act(input: Incoming) {
    setPlaying(false);
    setFrames([...frames.slice(0, cursor + 1), nextFrame(engine, frame, input)]);
    setCursor(cursor + 1);
    if (!atEnd) setManual(true);
  }

  const jump = (i: number) => {
    setPlaying(false);
    setCursor(i);
  };

  const inspectorProps = { cursor, names: NAMES, highlight: HIGHLIGHT, onJump: jump };

  return (
    <>
      <section className="toolbar">
        <div className="scenarios" role="tablist" aria-label="Сценарии">
          {stage.scenarios.map((s) => (
            <button key={s.id} className={s.id === scenarioId && !manual ? 'chip active' : 'chip'} onClick={() => onScenario(s.id)}>
              {s.title}
            </button>
          ))}
          <button className={scenarioId === MANUAL || manual ? 'chip active' : 'chip'} onClick={() => onScenario(MANUAL)}>
            ✋ Вручную
          </button>
        </div>
        <p className="description">
          {manual
            ? 'Ручной режим: нажимайте кнопки и пишите в чатах за участников — бот ответит так же, как в Telegram.'
            : (scenario?.description ?? '')}
        </p>
        <div className="controls">
          <button onClick={() => jump(0)} disabled={cursor === 0} title="В начало" aria-label="В начало">
            ⏮
          </button>
          <button onClick={() => jump(cursor - 1)} disabled={cursor === 0} title="Шаг назад" aria-label="Шаг назад">
            ◀
          </button>
          <button onClick={() => setPlaying(!playing)} disabled={atEnd && !playing} className="primary">
            {playing ? '⏸ Пауза' : '▶ Проиграть'}
          </button>
          <button onClick={() => jump(cursor + 1)} disabled={atEnd} title="Шаг вперёд" aria-label="Шаг вперёд">
            ▶
          </button>
          <button onClick={() => jump(frames.length - 1)} disabled={atEnd} title="В конец" aria-label="В конец">
            ⏭
          </button>
          <input
            className="timeline"
            type="range"
            min={0}
            max={frames.length - 1}
            value={cursor}
            onChange={(e) => jump(Number(e.target.value))}
            aria-label="Шаг сценария"
          />
          <span className="step-counter">
            {cursor} / {frames.length - 1}
          </span>
        </div>
      </section>

      <main className="layout">
        <section className={`chats cols-${engine.columns.length}`}>
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
        {stage.id === 'intake' && (
          <IntakeInspector
            frames={frames as Frame<IntakeSession>[]}
            {...inspectorProps}
            pendingJobs={workerEvent?.kind === 'worker' ? workerEvent.results.length : 0}
            onWorker={() => workerEvent && act(workerEvent)}
          />
        )}
        {stage.id === 'draw' && <DrawInspector frames={frames as Frame<DrawSession>[]} {...inspectorProps} />}
        {stage.id === 'match' && <Inspector frames={frames as Frame<MatchSession>[]} {...inspectorProps} />}
        {stage.id === 'final' && <FinalInspector frames={frames as Frame<FinalSession>[]} {...inspectorProps} />}
      </main>
    </>
  );
}
