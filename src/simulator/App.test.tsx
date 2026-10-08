import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './App.tsx';

describe('симулятор', () => {
  it('рендерит три чата и панель судьи', () => {
    const html = renderToString(<App />);
    expect(html).toContain('Симулятор матча');
    for (const name of ['Вика', 'Аня', 'Борис']) expect(html).toContain(name);
    expect(html).toContain('Все на месте');
  });
});
