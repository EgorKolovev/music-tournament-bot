import type { IntakeSession } from '../bot/intakeSession.ts';
import { statusOf } from '../domain/submission/intake.ts';
import type { Frame } from '../scenarios/runner.ts';
import { StepLog } from './StepLog.tsx';

interface Props {
  frames: Frame<IntakeSession>[];
  cursor: number;
  names: Map<string, string>;
  pendingJobs: number;
  onWorker: () => void;
  onJump: (index: number) => void;
}

export function IntakeInspector({ frames, cursor, names, pendingJobs, onWorker, onJump }: Props) {
  const { intake } = frames[cursor]!.session;
  const songs = Object.entries(intake.songs);
  const count = (status: string) => intake.submissions.filter((s) => statusOf(s) === status).length;

  return (
    <aside className="inspector">
      <section>
        <h2>Worker</h2>
        <p className="worker-row">
          <span>
            В очереди обработки: <strong>{pendingJobs}</strong>
          </span>
          <button className="primary-button" disabled={pendingJobs === 0} onClick={onWorker}>
            ⚙️ Обработать
          </button>
        </p>
        <p className="muted small">
          В проде здесь ffprobe/ffmpeg: проверка формата, нарезка фрагмента, вычистка тегов. В симуляторе битыми
          считаются файлы, отмеченные так в каталоге.
        </p>
      </section>

      <section>
        <h2>Заявки</h2>
        <dl className="facts">
          <dt>Принято</dt>
          <dd>{count('accepted')}</dd>
          <dt>Обработка</dt>
          <dd>{count('processing')}</dd>
          <dt>Без названия</dt>
          <dd>{count('needs_title')}</dd>
          <dt>Не подошло</dt>
          <dd>{count('rejected')}</dd>
        </dl>
      </section>

      <section>
        <h2>Песни и кто их знает</h2>
        {songs.length === 0 ? (
          <p className="muted small">Пока пусто</p>
        ) : (
          <ul className="tracks">
            {songs.map(([key, entry]) => (
              <li key={key} className={entry.submissionId ? undefined : 'cancelled'} title={key}>
                <code>{key}</code>{' '}
                <span className="muted">· {entry.knownBy.map((id) => names.get(id) ?? id).join(', ')}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <StepLog frames={frames} cursor={cursor} names={names} onJump={onJump} />
    </aside>
  );
}
