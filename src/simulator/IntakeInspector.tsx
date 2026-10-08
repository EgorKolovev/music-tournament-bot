import type { IntakeSession } from '../bot/intakeSession.ts';
import { acceptedSongs, statusOf } from '../domain/submission/intake.ts';
import type { Frame } from '../scenarios/runner.ts';
import { StepLog } from './StepLog.tsx';

interface Props {
  frames: Frame<IntakeSession>[];
  cursor: number;
  names: Map<string, string>;
  highlight: Set<string>;
  pendingJobs: number;
  onWorker: () => void;
  onJump: (index: number) => void;
}

export function IntakeInspector({ frames, cursor, names, highlight, pendingJobs, onWorker, onJump }: Props) {
  const { intake, closed } = frames[cursor]!.session;
  const library = acceptedSongs(intake);
  const shared = library.filter((s) => s.knownBy.length > 1);
  // Полная библиотека — сотни песен; в инспекторе только песни интерактивных участников.
  const mine = library.filter((s) => s.knownBy.some((id) => highlight.has(id)));
  const finalKeys = new Set(closed?.split.final ?? []);
  const count = (status: string) => intake.submissions.filter((s) => statusOf(s) === status).length;

  return (
    <aside className="inspector">
      <section>
        <h2>Worker</h2>
        <div className="worker-row">
          <span>
            В очереди обработки: <strong>{pendingJobs}</strong>
          </span>
          <button className="primary-button" disabled={pendingJobs === 0} onClick={onWorker}>
            ⚙️ Обработать
          </button>
        </div>
        <p className="muted small">
          В проде здесь ffprobe и ffmpeg: проверка формата, нарезка фрагмента, вычистка тегов. В демо битыми считаются
          файлы, помеченные так в каталоге.
        </p>
      </section>

      <section>
        <h2>Библиотека</h2>
        <dl className="facts">
          <dt>Песен</dt>
          <dd>
            {library.length} · склеено дублей: {shared.length}
          </dd>
          <dt>Заявки</dt>
          <dd>
            ✅ {count('accepted')} · ⏳ {count('processing')} · ✏️ {count('needs_title')} · ⚠️ {count('rejected')}
          </dd>
          {closed && (
            <>
              <dt>Пулы</dt>
              <dd>
                финал {closed.split.final.length} · отбор {closed.split.main.length}
              </dd>
            </>
          )}
        </dl>
      </section>

      <section>
        <h2>Песни Ани и Бориса — кто знает</h2>
        {mine.length === 0 ? (
          <p className="muted small">Пока пусто</p>
        ) : (
          <ul className="tracks">
            {mine.map((song) => (
              <li key={song.key}>
                {song.meta.artist} — {song.meta.title}
                {closed && <span className="tag">{finalKeys.has(song.key) ? 'финал' : 'отбор'}</span>}
                <div className="muted small">{song.knownBy.map((id) => names.get(id) ?? id).join(', ')}</div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <StepLog frames={frames} cursor={cursor} names={names} onJump={onJump} />
    </aside>
  );
}
