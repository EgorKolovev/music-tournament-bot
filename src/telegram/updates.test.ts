import type { Update } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import type { AudioFile } from '../domain/submission/intake.ts';
import { FileBatcher, type Timers } from './fileBatcher.ts';
import { parseUpdate } from './updates.ts';

const from = { id: 42, is_bot: false, first_name: 'Аня', last_name: 'К', username: 'anya' };
const chat = { id: 42, type: 'private' as const, first_name: 'Аня' };

function message(fields: Partial<NonNullable<Update['message']>>): Update {
  return { update_id: 1, message: { message_id: 1, from, chat, date: 0, ...fields } as NonNullable<Update['message']> };
}

describe('parseUpdate', () => {
  it('кнопка → button с id нажатия', () => {
    const parsed = parseUpdate({ update_id: 1, callback_query: { id: 'cq', from, chat_instance: 'ci', data: 'start|v2' } });
    expect(parsed).toEqual({
      kind: 'button',
      from: { id: '42', name: 'Аня К', username: 'anya' },
      data: 'start|v2',
      callbackQueryId: 'cq',
    });
  });

  it('/start с payload разбирается как команда', () => {
    expect(parseUpdate(message({ text: '/start judge_r1-6' }))).toMatchObject({
      kind: 'command',
      command: 'start',
      payload: 'judge_r1-6',
    });
    expect(parseUpdate(message({ text: 'Queen — Bohemian Rhapsody' }))).toMatchObject({ kind: 'text' });
  });

  it('аудио и аудио-документ → AudioFile', () => {
    const audio = parseUpdate(
      message({
        media_group_id: 'g1',
        audio: { file_id: 'F', file_unique_id: 'U', duration: 200, performer: 'Queen', title: 'Bohemian Rhapsody', file_size: 5 },
      }),
    );
    expect(audio).toMatchObject({
      kind: 'file',
      mediaGroupId: 'g1',
      file: { fileId: 'F', fileUniqueId: 'U', durationSec: 200, performer: 'Queen', sizeBytes: 5 },
    });
    const document = parseUpdate(message({ document: { file_id: 'D', file_unique_id: 'V', file_name: 'song.mp3' } }));
    expect(document).toMatchObject({ kind: 'file', file: { fileId: 'D', fileName: 'song.mp3' } });
    const pdf = parseUpdate(message({ document: { file_id: 'P', file_unique_id: 'W', file_name: 'rules.pdf', mime_type: 'application/pdf' } }));
    expect(pdf.kind).toBe('ignored');
  });

  it('группы и боты игнорируются', () => {
    expect(parseUpdate(message({ chat: { id: -1, type: 'group', title: 'Группа' }, text: 'hi' })).kind).toBe('ignored');
    expect(parseUpdate(message({ from: { ...from, is_bot: true }, text: 'hi' })).kind).toBe('ignored');
  });
});

describe('FileBatcher', () => {
  function manualTimers() {
    const pending = new Map<number, () => void>();
    let next = 1;
    const timers: Timers = {
      set: (callback) => {
        pending.set(next, callback);
        return next++;
      },
      clear: (handle) => void pending.delete(handle as number),
    };
    const fire = () => {
      for (const callback of pending.values()) callback();
    };
    return { timers, fire, pending };
  }

  const file = (id: string): AudioFile => ({ fileId: id, fileUniqueId: id, sizeBytes: 1 });

  it('копит файлы пользователя до паузы и отдаёт одной пачкой', () => {
    const { timers, fire, pending } = manualTimers();
    const batches: [string, string[]][] = [];
    const batcher = new FileBatcher((who, files) => batches.push([who, files.map((f) => f.fileId)]), 1500, timers);
    batcher.push('42', file('a'), 'g');
    batcher.push('42', file('b'), 'g');
    batcher.push('7', file('c'));
    expect(pending.size).toBe(2);
    fire();
    expect(batches).toEqual([
      ['42', ['a', 'b']],
      ['7', ['c']],
    ]);
  });

  it('новая media group закрывает предыдущую пачку', () => {
    const { timers, fire } = manualTimers();
    const batches: string[][] = [];
    const batcher = new FileBatcher((_, files) => batches.push(files.map((f) => f.fileId)), 1500, timers);
    batcher.push('42', file('a'), 'g1');
    batcher.push('42', file('b'), 'g2');
    fire();
    expect(batches).toEqual([['a'], ['b']]);
  });
});
