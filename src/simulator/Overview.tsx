import { STAGES, type Stage } from './stages.ts';

// Открытые вопросы из docs/decisions/2026-10-08-mechanics-revision.md и docs/storage-and-offline.md.
const OPEN_QUESTIONS = [
  'Кто судит финал и сколько судей',
  'Число треков в отборочном матче (сейчас 5); порог и лимит финала — на пробных играх',
  'Что делать с игроком, сдавшим меньше 10 песен',
  'Где хранить аудио и где физически крутится бот во время финала',
  'Длина игрового фрагмента (до 60 секунд — не проверялось)',
];

export function Overview({ onOpen }: { onOpen: (stage: Stage) => void }) {
  return (
    <main className="overview">
      <section className="hero">
        <h1>Турнир «угадай мелодию» в Telegram-боте</h1>
        <p>
          Бот ведёт турнир целиком: собирает песни участников, делит их на отбор и финал, проводит жеребьёвку, помогает
          парам найти судью и ведёт каждый матч — от короткого отборочного до финала на сцене. Ниже — четыре этапа; каждый
          можно проиграть по готовому сценарию или пройти вручную.
        </p>
      </section>

      <ol className="journey">
        {STAGES.map((stage) => (
          <li key={stage.id} className="journey-card">
            <div className="journey-head">
              <span className="step-number big">{stage.number}</span>
              <h2>{stage.title}</h2>
            </div>
            <p>{stage.summary}</p>
            <ul>
              {stage.decisions.map((decision) => (
                <li key={decision}>{decision}</li>
              ))}
            </ul>
            <button className="primary-button" onClick={() => onOpen(stage)}>
              Открыть этап →
            </button>
          </li>
        ))}
      </ol>

      <section className="notes">
        <div>
          <h2>Как читать демо</h2>
          <ul>
            <li>Колонки — чаты участников с ботом. Сообщения и кнопки те же, что бот отправит в Telegram.</li>
            <li>Сообщения с пометкой «изменено» бот правит на месте; лимиты Telegram проверяются автоматически.</li>
            <li>Справа — что бот знает внутри: библиотека, сетка, очередь песен, журнал решений.</li>
            <li>Участники и песни вымышленные, аудио в демо нет.</li>
          </ul>
        </div>
        <div>
          <h2>Открытые вопросы</h2>
          <ul>
            {OPEN_QUESTIONS.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </div>
      </section>
    </main>
  );
}
