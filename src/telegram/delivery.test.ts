import type { InputFile } from 'grammy';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { OutgoingMessage } from '../bot/protocol.ts';
import { Delivery, MemorySlotStore } from './delivery.ts';
import { FakeApi, silentLog } from './fakeApi.ts';

function setup(downloadFile?: (filePath: string) => Promise<Uint8Array>) {
  const api = new FakeApi();
  const sleeps: number[] = [];
  const delivery = new Delivery({
    api,
    slots: new MemorySlotStore(),
    log: silentLog,
    downloadFile,
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { api, delivery, sleeps };
}

const panel = (text: string, extra: Partial<OutgoingMessage> = {}): OutgoingMessage => ({
  kind: 'message',
  to: '42',
  slot: 'panel:0',
  text,
  buttons: [[{ label: 'Начать', data: 'start|v3' }]],
  ...extra,
});

describe('Delivery', () => {
  it('сообщение со slot отправляет один раз, дальше правит на месте', async () => {
    const { api, delivery } = setup();
    await delivery.deliver([panel('первая версия')]);
    await delivery.deliver([panel('вторая версия', { buttons: undefined })]);

    expect(api.methods()).toEqual(['sendMessage', 'editMessageText']);
    expect(api.calls[0]!.params).toMatchObject({
      chat_id: '42',
      text: 'первая версия',
      reply_markup: { inline_keyboard: [[{ text: 'Начать', callback_data: 'start|v3' }]] },
    });
    // Кнопки прошлой версии явно убираются.
    expect(api.calls[1]!.params).toMatchObject({ message_id: 100, reply_markup: { inline_keyboard: [] } });
  });

  it('кнопка-ссылка уходит как url, без callback_data', async () => {
    const { api, delivery } = setup();
    const write = { label: '💬 Написать', data: '', url: 'https://t.me/anna_m' };
    await delivery.deliver([panel('карточка', { buttons: [[write], [{ label: 'Назад', data: 'o:v:players' }]] })]);
    expect(api.calls[0]!.params).toMatchObject({
      reply_markup: {
        inline_keyboard: [[{ text: '💬 Написать', url: 'https://t.me/anna_m' }], [{ text: 'Назад', callback_data: 'o:v:players' }]],
      },
    });
  });

  it('bump удаляет старое сообщение и отправляет новое вниз', async () => {
    const { api, delivery } = setup();
    await delivery.deliver([panel('список')]);
    await delivery.deliver([panel('список', { bump: true })]);
    await delivery.deliver([panel('правка')]);

    expect(api.methods()).toEqual(['sendMessage', 'deleteMessage', 'sendMessage', 'editMessageText']);
    expect(api.calls[1]!.params).toMatchObject({ message_id: 100 });
    expect(api.calls[3]!.params).toMatchObject({ message_id: 101 });
  });

  it('«message is not modified» не считается ошибкой', async () => {
    const { api, delivery } = setup();
    await delivery.deliver([panel('текст')]);
    api.failNext('editMessageText', 400, 'Bad Request: message is not modified');
    await delivery.deliver([panel('текст')]);
    await delivery.deliver([panel('новый текст')]);

    expect(api.methods()).toEqual(['sendMessage', 'editMessageText', 'editMessageText']);
  });

  it('пропавшее сообщение отправляется заново', async () => {
    const { api, delivery } = setup();
    await delivery.deliver([panel('текст')]);
    api.failNext('editMessageText', 400, 'Bad Request: message to edit not found');
    await delivery.deliver([panel('новый текст')]);
    await delivery.deliver([panel('ещё новее')]);

    expect(api.methods()).toEqual(['sendMessage', 'editMessageText', 'sendMessage', 'editMessageText']);
    expect(api.calls[3]!.params).toMatchObject({ message_id: 101 });
  });

  it('отвечает на нажатие toast-ом нажавшему, а без toast — пустым ответом', async () => {
    const { api, delivery } = setup();
    await delivery.deliver(
      [
        { kind: 'toast', to: '42', text: 'Панель устарела' },
        { kind: 'toast', to: '7', text: 'чужой' },
      ],
      { from: '42', callbackQueryId: 'cq-1' },
    );
    await delivery.deliver([panel('текст')], { from: '42', callbackQueryId: 'cq-2' });

    expect(api.calls[0]).toEqual({
      method: 'answerCallbackQuery',
      params: { callback_query_id: 'cq-1', text: 'Панель устарела', show_alert: undefined },
    });
    // Ответ на нажатие идёт раньше сообщений: индикатор на кнопке гаснет сразу.
    expect(api.calls.slice(1).map((c) => c.method)).toEqual(['answerCallbackQuery', 'sendMessage']);
    expect(api.calls[1]!.params).toMatchObject({ callback_query_id: 'cq-2', text: undefined });
  });

  it('повторяет запрос после 429 с учётом retry_after', async () => {
    const { api, delivery, sleeps } = setup();
    api.failNext('sendMessage', 429, 'Too Many Requests: retry after 3', 3);
    await delivery.deliver([panel('текст')]);

    expect(api.methods()).toEqual(['sendMessage', 'sendMessage']);
    expect(sleeps).toEqual([3000]);
  });

  it('ошибка одного сообщения не мешает остальным', async () => {
    const { api, delivery } = setup();
    api.failNext('sendMessage', 403, 'Forbidden: bot was blocked by the user');
    await delivery.deliver([panel('первому'), { ...panel('второму'), to: '43' }]);

    expect(api.calls.map((c) => c.params.chat_id)).toEqual(['42', '43']);
  });

  it('аудио без file_id — текстовая заглушка, с file_id — sendAudio с нейтральной карточкой', async () => {
    const { api, delivery } = setup();
    const audio = { title: 'Трек 1', performer: 'Музыкальный турнир' };
    await delivery.deliver([{ kind: 'message', to: '42', slot: 'audio:0', text: '', audio }]);
    await delivery.deliver([{ kind: 'message', to: '42', slot: 'audio:1', text: '', audio: { ...audio, fileId: 'F1' } }]);

    expect(api.calls[0]!.method).toBe('sendMessage');
    expect(api.calls[0]!.params.text).toContain('Трек 1');
    expect(api.calls[1]).toMatchObject({
      method: 'sendAudio',
      params: { audio: 'F1', title: 'Трек 1', performer: 'Музыкальный турнир', caption: undefined },
    });
  });

  it('документ отправляется файлом', async () => {
    const { api, delivery } = setup();
    await delivery.deliver([
      {
        kind: 'message',
        to: '42',
        text: 'Офлайн-комплект',
        document: { fileName: 'final.csv', mimeType: 'text/csv', content: 'a;b' },
      },
    ]);
    const file = api.calls[0]!.params.document as InputFile;
    expect(api.calls[0]!.method).toBe('sendDocument');
    expect(file.filename).toBe('final.csv');
    expect(new TextDecoder().decode((await file.toRaw()) as Uint8Array)).toBe('a;b');
  });

  it('скачивает игровые файлы и отправляет ZIP с пронумерованными MP3', async () => {
    const contents: Record<string, Uint8Array> = {
      'files/one': new TextEncoder().encode('first'),
      'files/two': new TextEncoder().encode('second'),
    };
    const { api, delivery } = setup(async (path) => contents[path]!);
    api.replies.set('getFile', (params) => ({ file_path: `files/${String(params.file_id).toLowerCase()}` }));

    await delivery.deliver([
      {
        kind: 'message',
        to: '42',
        text: 'Аудио финала',
        document: {
          fileName: 'final-audio.zip',
          mimeType: 'application/zip',
          content: '',
          archiveFiles: [
            { fileName: '001.mp3', fileId: 'ONE' },
            { fileName: '002.mp3', fileId: 'TWO' },
          ],
        },
      },
    ]);

    expect(api.methods()).toEqual(['getFile', 'getFile', 'sendDocument']);
    const file = api.calls[2]!.params.document as InputFile;
    expect(file.filename).toBe('final-audio-01.zip');
    const archive = unzipSync((await file.toRaw()) as Uint8Array);
    expect(new TextDecoder().decode(archive['001.mp3'])).toBe('first');
    expect(new TextDecoder().decode(archive['002.mp3'])).toBe('second');
  });

  it('копия базы снимается при отправке и уходит ZIP с JSON внутри', async () => {
    const api = new FakeApi();
    let taken = 0;
    const databaseCopy = async () => {
      taken++;
      return '{"format":"music-tournament"}';
    };
    const delivery = new Delivery({ api, slots: new MemorySlotStore(), log: silentLog, databaseCopy });
    await delivery.deliver([
      {
        kind: 'message',
        to: '42',
        text: '📦 Копия базы',
        document: { fileName: 'tournament-20261011-120000.zip', mimeType: 'application/zip', content: '', databaseCopy: true },
        buttons: [[{ label: '🔕 Больше не присылать', data: 't:copy:stop' }]],
      },
    ]);

    expect(taken).toBe(1);
    expect(api.methods()).toEqual(['sendDocument']);
    const { params } = api.calls[0]!;
    expect(params.caption).toBe('📦 Копия базы');
    expect(params.reply_markup).toEqual({ inline_keyboard: [[{ text: '🔕 Больше не присылать', callback_data: 't:copy:stop' }]] });
    const file = params.document as InputFile;
    expect(file.filename).toBe('tournament-20261011-120000.zip');
    const archive = unzipSync((await file.toRaw()) as Uint8Array);
    expect(Object.keys(archive)).toEqual(['tournament-20261011-120000.json']);
    expect(new TextDecoder().decode(archive['tournament-20261011-120000.json'])).toBe('{"format":"music-tournament"}');
  });

  it('копия базы больше лимита Telegram — вместо файла объяснение, как снять её вручную', async () => {
    const api = new FakeApi();
    const databaseCopy = async () => JSON.stringify({ events: Array.from({ length: 50 }, (_, i) => `событие ${i}`) });
    const delivery = new Delivery({ api, slots: new MemorySlotStore(), log: silentLog, databaseCopy, maxDocumentBytes: 100 });
    await delivery.deliver([
      {
        kind: 'message',
        to: '42',
        text: '📦 Копия базы',
        document: { fileName: 'tournament-20261011-120000.zip', mimeType: 'application/zip', content: '', databaseCopy: true },
      },
    ]);
    expect(api.methods()).toEqual(['sendMessage']);
    expect(api.calls[0]!.params.text).toContain('больше, чем бот может отправить в Telegram');
    expect(api.calls[0]!.params.text).toContain('npm run db:backup');
  });
});
