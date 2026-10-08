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
  const listRef = useRef<HTMLOListElement>(null);
  const activeRef = useRef<HTMLLIElement>(null);

  // Прокручиваем только сам список: scrollIntoView двигал бы и страницу.
  useEffect(() => {
    const list = listRef.current;
    const item = activeRef.current;
    if (!list || !item) return;
    const top = item.offsetTop - list.offsetTop;
    if (top < list.scrollTop || top + item.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = top - list.clientHeight / 2;
    }
  }, [cursor]);

  return (
    <section className="log-section">
      <h2>Журнал</h2>
      <ol className="log" ref={listRef}>
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
