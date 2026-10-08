import { useEffect, useRef } from 'react';
import { actionOf } from '../bot/chat.ts';
import { liveScore } from '../domain/match/match.ts';
import { formatPoints } from '../domain/match/ruleset.ts';
import type { Frame } from '../scenarios/runner.ts';

interface Props {
  frames: Frame[];
  cursor: number;
  onJump: (index: number) => void;
}

export function Inspector({ frames, cursor, onJump }: Props) {
  const frame = frames[cursor]!;
  const { session } = frame;
  const { match, config } = session;
  const [p0, p1] = config.players;
  const score = liveScore(match);
  const names = new Map([config.judge, ...config.players].map((u) => [u.id, u.name]));
  const activeRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  return (
    <aside className="inspector">
      <section>
        <h2>Состояние</h2>
        <dl className="facts">
          <dt>Фаза</dt>
          <dd>
            <code>{match.phase.kind}</code>
            {match.paused && <span className="tag">пауза</span>}
          </dd>
          <dt>Счёт</dt>
          <dd>
            {p0.name} {formatPoints(score[0])} : {formatPoints(score[1])} {p1.name}
          </dd>
          <dt>Треков</dt>
          <dd>
            {match.closedTracks.length} закрыто · {match.cancelledTracks.length} отменено
          </dd>
          <dt>Версия</dt>
          <dd>
            <code>v{match.version}</code>
          </dd>
        </dl>
      </section>

      <section>
        <h2>Выданные песни</h2>
        {session.issued.length === 0 ? (
          <p className="muted small">Пока ни одной</p>
        ) : (
          <ol className="tracks">
            {session.issued.map((t, i) => {
              const song = config.library.find((s) => s.id === t.songId)!;
              const cancelled = match.cancelledTracks.some((c) => c.songId === t.songId);
              return (
                <li key={i} className={cancelled ? 'cancelled' : undefined}>
                  <span className="muted">#{t.number}</span> {song.artist} — {song.title}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section className="log-section">
        <h2>Журнал нажатий</h2>
        <ol className="log">
          {frames.map((f, i) => (
            <li
              key={i}
              ref={i === cursor ? activeRef : undefined}
              className={`${i === cursor ? 'active' : ''}${i > cursor ? ' future' : ''}`}
              onClick={() => onJump(i)}
            >
              <span className="muted">{i}</span>{' '}
              {f.input ? (
                <>
                  {names.get(f.input.from)}: <code>{actionOf(f.input.data)}</code>
                  {f.out.some((o) => o.kind === 'toast') && <span className="tag warn">отказ</span>}
                </>
              ) : (
                'старт матча'
              )}
            </li>
          ))}
        </ol>
      </section>
    </aside>
  );
}
