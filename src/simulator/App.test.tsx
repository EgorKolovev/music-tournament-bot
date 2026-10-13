import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MOMENTS, playToMoment, ROLE_PEOPLE } from '../scenarios/rolesStory.ts';
import { App, StageView } from './App.tsx';
import { RolesView } from './RolesView.tsx';
import { STAGES } from './stages.ts';

describe('демо-стенд', () => {
  it('открывается обзором со всеми этапами', () => {
    const html = renderToString(<App />);
    expect(html).toContain('Турнир «угадай мелодию» в Telegram-боте');
    for (const stage of STAGES) expect(html).toContain(stage.title);
    expect(html).toContain('👥 Роли');
  });

  it.each(MOMENTS)('Роли · $title рендерятся без ошибок', (moment) => {
    const html = renderToString(<RolesView momentId={moment.id} onMoment={() => {}} />);
    expect(html).toContain(moment.description);
    for (const column of playToMoment(moment.id).columns) {
      expect(html).toContain(ROLE_PEOPLE[column.userId]!.name);
      expect(html).toContain(column.note);
    }
  });

  const cases = STAGES.flatMap((stage) =>
    stage.scenarios.flatMap((scenario) => ['0', 'end'].map((at) => [stage.title, scenario.title, at, stage, scenario.id] as const)),
  );

  it.each(cases)('%s · %s · шаг %s рендерится без ошибок', (_, __, at, stage, scenarioId) => {
    const html = renderToString(<StageView stage={stage} scenarioId={scenarioId} at={at} onScenario={() => {}} />);
    for (const column of stage.engine.columns) expect(html).toContain(column.user.name);
  });
});
