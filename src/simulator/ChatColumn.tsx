import { useEffect, useRef } from 'react';
import type { Chat, ChatMessage } from '../bot/chat.ts';
import { limitViolations, NOOP } from '../bot/protocol.ts';

interface Props {
  name: string;
  role: string;
  chat: Chat | undefined;
  toasts: string[];
  pressedData: string | undefined;
  onPress: (data: string) => void;
}

export function ChatColumn({ name, role, chat, toasts, pressedData, onPress }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const messages = chat?.messages ?? [];

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

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
        {messages.map((message) => (
          <Bubble key={message.id} message={message} pressedData={pressedData} onPress={onPress} />
        ))}
      </div>
      {toasts.map((text, i) => (
        <div key={i} className="toast" role="status">
          {text}
        </div>
      ))}
    </article>
  );
}

function Bubble({
  message,
  pressedData,
  onPress,
}: {
  message: ChatMessage;
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
