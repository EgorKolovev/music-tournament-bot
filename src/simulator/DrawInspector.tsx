import type { DrawSession } from '../bot/drawSession.ts';
import type { Frame } from '../scenarios/runner.ts';
import { BracketView } from './BracketView.tsx';
import { StepLog } from './StepLog.tsx';

interface Props {
  frames: Frame<DrawSession>[];
  cursor: number;
  names: Map<string, string>;
  highlight: Set<string>;
  onJump: (index: number) => void;
}

export function DrawInspector({ frames, cursor, names, highlight, onJump }: Props) {
  const { bracket, journal } = frames[cursor]!.session;
  return (
    <aside className="inspector">
      <section>
        <h2>Сетка отбора</h2>
        {bracket ? (
          <BracketView bracket={bracket} results={{}} names={names} highlight={highlight} hideByes />
        ) : (
          <p className="muted small">Появится после жеребьёвки</p>
        )}
      </section>
      <section>
        <h2>Журнал решений</h2>
        {journal.length === 0 ? (
          <p className="muted small">Пусто</p>
        ) : (
          <ul className="tracks">
            {journal.map((entry, i) => (
              <li key={i}>{entry}</li>
            ))}
          </ul>
        )}
      </section>
      <StepLog frames={frames} cursor={cursor} names={names} onJump={onJump} />
    </aside>
  );
}
