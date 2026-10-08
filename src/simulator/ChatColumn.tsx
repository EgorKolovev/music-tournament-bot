import { useEffect, useRef, useState } from 'react';
import type { BotChatMessage, Chat, UserChatMessage } from '../bot/chat.ts';
import { limitViolations, NOOP } from '../bot/protocol.ts';
import type { AudioFile } from '../domain/submission/intake.ts';
import type { CatalogFile } from '../scenarios/engine.ts';

export type ColumnInput =
  | { kind: 'button'; data: string }
  | { kind: 'text'; text: string }
  | { kind: 'files'; files: AudioFile[] };

interface Props {
  name: string;
  role: string;
  chat: Chat | undefined;
  toasts: string[];
  pressedData: string | undefined;
  // Есть каталог — участник может писать и пересылать файлы.
  catalog?: Record<string, CatalogFile>;
  onInput: (input: ColumnInput) => void;
}

export function ChatColumn({ name, role, chat, toasts, pressedData, catalog, onInput }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const messages = chat?.messages ?? [];
  const lastId = messages.at(-1)?.id;

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastId]);

  return (
    <article className="phone">
      <header className="phone-header">
        <div className="avatar" aria-hidden>
          {name[0]}
        </div>
        <div>
          <div className="phone-name">{name}</div>
          <div className="muted small">{role} · чат с ботом</div>
        </div>
      </header>
      <div className="messages" ref={scrollRef}>
        {messages.length === 0 && <p className="muted small empty">Сообщений нет</p>}
        {messages.map((message) =>
          message.author === 'bot' ? (
            <BotBubble
              key={message.id}
              message={message}
              pressedData={pressedData}
              onPress={(data) => onInput({ kind: 'button', data })}
            />
          ) : (
            <UserBubble key={message.id} message={message} />
          ),
        )}
      </div>
      {toasts.map((text, i) => (
        <div key={i} className="toast" role="status">
          {text}
        </div>
      ))}
      {catalog && <Composer catalog={catalog} onInput={onInput} />}
    </article>
  );
}

function BotBubble({
  message,
  pressedData,
  onPress,
}: {
  message: BotChatMessage;
  pressedData: string | undefined;
  onPress: (data: string) => void;
}) {
  const violations = limitViolations(message);
  const isSecret = message.text.startsWith('🔒');
  return (
    <div className={`bubble${isSecret ? ' secret' : ''}`}>
      {message.audio && (
        <div className="audio">
          <span className="play" aria-hidden>
            ▶
          </span>
          <div>
            <div className="audio-title">{message.audio.title}</div>
            <div className="muted small">{message.audio.performer} · до 1:00</div>
          </div>
        </div>
      )}
      {message.text && <div className="text">{message.text}</div>}
      {message.buttons && (
        <div className="keyboard">
          {message.buttons.map((row, r) => (
            <div key={r} className="kb-row">
              {row.map((button, b) => (
                <button
                  key={b}
                  className={`kb-button${button.data === NOOP ? ' noop' : ''}${button.data === pressedData ? ' pressed' : ''}`}
                  onClick={() => onPress(button.data)}
                  title={button.data}
                >
                  {button.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      <div className="meta">
        {message.slot && <span className="slot">{message.slot}</span>}
        {message.edits > 0 && <span>изменено ×{message.edits}</span>}
      </div>
      {violations.length > 0 && <div className="violation">⚠ Лимит Telegram: {violations.join('; ')}</div>}
    </div>
  );
}

function UserBubble({ message }: { message: UserChatMessage }) {
  return (
    <div className="bubble user">
      {message.text && <div className="text">{message.text}</div>}
      {message.files?.map((file) => (
        <div key={file.fileUniqueId + file.fileId} className="audio forwarded">
          <span className="play" aria-hidden>
            ▶
          </span>
          <div className="file-info">
            <div className="audio-title">{file.title ?? file.fileName ?? 'Аудио'}</div>
            <div className="muted small">
              {file.performer ?? 'без исполнителя'} · {(file.sizeBytes / 1024 / 1024).toFixed(1)} МБ
            </div>
          </div>
        </div>
      ))}
      {message.files && <div className="meta">переслано</div>}
    </div>
  );
}

function Composer({ catalog, onInput }: { catalog: Record<string, CatalogFile>; onInput: (input: ColumnInput) => void }) {
  const [text, setText] = useState('');
  const [picking, setPicking] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  function sendText() {
    const value = text.trim();
    if (!value) return;
    onInput({ kind: 'text', text: value });
    setText('');
  }

  function forward() {
    onInput({ kind: 'files', files: selected.map((key) => catalog[key]!.file) });
    setSelected([]);
    setPicking(false);
  }

  return (
    <div className="composer">
      {picking && (
        <div className="picker">
          <div className="picker-head">
            <strong>Переслать из музыкального бота</strong>
            <button className="link" onClick={() => setPicking(false)}>
              Закрыть
            </button>
          </div>
          <ul>
            {Object.entries(catalog).map(([key, entry]) => (
              <li key={key}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.includes(key)}
                    onChange={(e) =>
                      setSelected(e.target.checked ? [...selected, key] : selected.filter((k) => k !== key))
                    }
                  />
                  <span>
                    {entry.file.performer && entry.file.title
                      ? `${entry.file.performer} — ${entry.file.title}`
                      : entry.file.fileName}
                    <span className="muted small"> · {entry.note}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <button className="primary-button" disabled={selected.length === 0} onClick={forward}>
            Переслать {selected.length > 0 ? `(${selected.length})` : ''}
          </button>
        </div>
      )}
      <div className="composer-row">
        <button className="attach" onClick={() => setPicking(!picking)} title="Переслать файлы" aria-label="Переслать файлы">
          📎
        </button>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && sendText()}
          placeholder="Сообщение"
          aria-label="Сообщение боту"
        />
        <button className="send" onClick={sendText} disabled={!text.trim()} aria-label="Отправить">
          ➤
        </button>
      </div>
    </div>
  );
}
