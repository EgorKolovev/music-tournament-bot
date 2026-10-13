import { useState } from 'react';
import { MOMENTS, playToMoment, pressInRun, ROLE_PEOPLE, type MomentId, type RolesRun } from '../scenarios/rolesStory.ts';
import { ChatColumn } from './ChatColumn.tsx';

// Вкладка «Роли»: один турнир глазами организатора, админа, игрока, судьи — на настоящем боте.
// Момент проигрывается сценарием, дальше кнопки в любой колонке уходят в бота.

interface Props {
  momentId: MomentId;
  onMoment: (id: MomentId) => void;
}

export function RolesView({ momentId, onMoment }: Props) {
  const [run, setRun] = useState<RolesRun>(() => playToMoment(momentId));

  return (
    <>
      <section className="toolbar">
        <div className="scenarios" role="tablist" aria-label="Момент турнира">
          {MOMENTS.map((moment, i) => (
            <button
              type="button"
              key={moment.id}
              className={moment.id === momentId ? 'chip active' : 'chip'}
              onClick={() => (moment.id === momentId ? setRun(playToMoment(moment.id)) : onMoment(moment.id))}
            >
              {i + 1}. {moment.title}
            </button>
          ))}
          {run.pressed && (
            <button type="button" className="chip" onClick={() => setRun(playToMoment(momentId))}>
              ↺ Сначала
            </button>
          )}
        </div>
        <p className="description">{run.moment.description}</p>
        <p className="description small">
          Экраны рисует настоящий бот. Кнопки живые: нажатие уходит в бота от имени этого человека, остальные колонки
          обновляются. Под телефоном — кто это и что он видит.
        </p>
      </section>

      <main>
        <section className="chats roles">
          {run.columns.map(({ role, userId, note }) => (
            <div key={`${role}/${userId}`} className="role-column">
              <ChatColumn
                name={ROLE_PEOPLE[userId]?.name ?? userId}
                role={role}
                chat={run.bot.chats[userId]}
                toasts={run.lastOut.filter((o) => o.kind === 'toast' && o.to === userId).map((o) => o.text)}
                pressedData={run.pressed?.from === userId ? run.pressed.data : undefined}
                onInput={(input) => input.kind === 'button' && setRun(pressInRun(run, userId, input.data))}
              />
              <p className="role-note">{note}</p>
            </div>
          ))}
        </section>
      </main>
    </>
  );
}
