import type { MatchSession } from '../bot/matchSession.ts';
import { liveScore } from '../domain/match/match.ts';
import { formatPoints } from '../domain/match/ruleset.ts';
import type { Frame } from '../scenarios/runner.ts';
import { StepLog } from './StepLog.tsx';

interface Props {
  frames: Frame<MatchSession>[];
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

      <StepLog frames={frames} cursor={cursor} names={names} onJump={onJump} />
    </aside>
  );
}
