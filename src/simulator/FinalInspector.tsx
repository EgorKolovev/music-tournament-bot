import type { FinalSession } from '../bot/finalSession.ts';
import { liveScore } from '../domain/match/match.ts';
import { formatPoints } from '../domain/match/ruleset.ts';
import type { Frame } from '../scenarios/runner.ts';
import { BracketView } from './BracketView.tsx';
import { StepLog } from './StepLog.tsx';

interface Props {
  frames: Frame<FinalSession>[];
  cursor: number;
  names: Map<string, string>;
  highlight: Set<string>;
  onJump: (index: number) => void;
}

export function FinalInspector({ frames, cursor, names, highlight, onJump }: Props) {
  const session = frames[cursor]!.session;
  const { current, queue, played, config } = session;
  const playedSet = new Set(played);
  const inMatch = current ? new Set(current.session.issued.map((t) => t.songId)) : new Set<string>();
  const pairIds = current ? current.session.config.players.map((p) => p.id) : [];
  const upcoming = queue.filter((id) => !playedSet.has(id)).slice(0, 8);

  return (
    <aside className="inspector">
      <section>
        <h2>Сетка финала</h2>
        <BracketView
          bracket={session.bracket}
          results={session.results}
          names={names}
          roundTitles={['1/4', '1/2', 'Финал']}
          activeMatchId={current?.matchId}
          highlight={highlight}
        />
        {current && (
          <p className="small">
            🎤 {current.session.config.players[0].name}{' '}
            {liveScore(current.session.match).map(formatPoints).join(' : ')} {current.session.config.players[1].name}
          </p>
        )}
      </section>
      <section>
        <h2>Очередь песен</h2>
        <p className="muted small">
          {queue.length} песен · сыграно {played.length}. Ближайшие (зачёркнуты — песни пары на сцене, их бот пропустит):
        </p>
        <ol className="tracks">
          {upcoming.map((id) => {
            const song = config.library.find((s) => s.id === id)!;
            const skipped = song.ownerIds.some((o) => pairIds.includes(o));
            return (
              <li key={id} className={skipped ? 'cancelled' : inMatch.has(id) ? 'playing' : undefined}>
                <span className="muted">#{queue.indexOf(id) + 1}</span> {song.artist} — {song.title}
              </li>
            );
          })}
        </ol>
      </section>
      <StepLog frames={frames} cursor={cursor} names={names} onJump={onJump} />
    </aside>
  );
}
