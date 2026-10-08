import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './App.tsx';

describe('симулятор', () => {
  it('рендерит чаты участников и организатора', () => {
    const html = renderToString(<App />);
    expect(html).toContain('Симулятор бота');
    for (const name of ['Аня', 'Борис', 'Организатор']) expect(html).toContain(name);
    expect(html).toContain('Пересылай аудио пачкой');
  });
});
