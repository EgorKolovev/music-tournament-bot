import { useEffect, useRef } from 'react';
import type { Frame } from '../scenarios/runner.ts';
import { describeInput } from './inputLabel.ts';

interface Props {
  frames: Frame<unknown>[];
  cursor: number;
  names: Map<string, string>;
  onJump: (index: number) => void;
}

export function StepLog({ frames, cursor, names, onJump }: Props) {
  const activeRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  return (
    <section className="log-section">
      <h2>Журнал</h2>
      <ol className="log">
        {frames.map((f, i) => (
          <li
            key={i}
            ref={i === cursor ? activeRef : undefined}
            className={`${i === cursor ? 'active' : ''}${i > cursor ? ' future' : ''}`}
            onClick={() => onJump(i)}
          >
            <span className="muted">{i}</span> {describeInput(f.input, names)}
            {f.out.some((o) => o.kind === 'toast') && <span className="tag warn">отказ</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}
