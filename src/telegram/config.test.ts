import { describe, expect, it } from 'vitest';
import { readSettings } from './config.ts';

const ENV = { BOT_TOKEN: 'test', ORGANIZER_ID: '900', AUDIO_MODE: 'skip' };

describe('настройки из окружения', () => {
  it('QUALIFIER_TRACKS меняет только число треков: отрыв и очки — по умолчанию', () => {
    const { qualifierRuleset } = readSettings({ ...ENV, QUALIFIER_TRACKS: '7' }).tournament;
    expect(qualifierRuleset).toEqual({ artistPoints: 10, titlePoints: 15, format: { kind: 'fixed', tracks: 7, minLead: 20 } });
  });
});
