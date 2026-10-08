import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App, StageView } from './App.tsx';
import { STAGES } from './stages.ts';

describe('демо-стенд', () => {
  it('открывается обзором со всеми этапами', () => {
    const html = renderToString(<App />);
    expect(html).toContain('Турнир «угадай мелодию» в Telegram-боте');
    for (const stage of STAGES) expect(html).toContain(stage.title);
  });

  const cases = STAGES.flatMap((stage) =>
    stage.scenarios.flatMap((scenario) => ['0', 'end'].map((at) => [stage.title, scenario.title, at, stage, scenario.id] as const)),
  );

  it.each(cases)('%s · %s · шаг %s рендерится без ошибок', (_, __, at, stage, scenarioId) => {
    const html = renderToString(<StageView stage={stage} scenarioId={scenarioId} at={at} onScenario={() => {}} />);
    for (const column of stage.engine.columns) expect(html).toContain(column.user.name);
  });
});
