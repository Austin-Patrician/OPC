import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TELEGRAM_API_BASE,
  normalizeTelegramApiBaseUrl,
  TelegramApi,
  type TelegramApiError,
} from './telegramApi';

describe('telegramApi', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length) {
      const dir = tempDirs.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('normalizes optional Bot API base URLs and rejects invalid protocols', () => {
    expect(normalizeTelegramApiBaseUrl('')).toBe(DEFAULT_TELEGRAM_API_BASE);
    expect(normalizeTelegramApiBaseUrl('https://tg.example.com///')).toBe('https://tg.example.com');
    expect(() => normalizeTelegramApiBaseUrl('ftp://tg.example.com')).toThrow();
    expect(() => normalizeTelegramApiBaseUrl('not-a-url')).toThrow();
  });

  it('verifies bot identity via getMe', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          result: { id: 9988, is_bot: true, first_name: 'Buddy', username: 'opc_buddy_bot' },
        }),
        { status: 200 },
      ),
    );
    const api = new TelegramApi({ botToken: '123:abc', fetchImpl: fetchMock });
    const res = await api.verifyConnection();
    expect(res.ok).toBe(true);
    expect(res.botName).toBe('@opc_buddy_bot (Buddy)');
    expect(res.botOpenId).toBe('9988');
  });

  it('falls back to plain text if Telegram rejects HTML entities with HTTP 400', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: false,
            error_code: 400,
            description: "Bad Request: can't parse entities: Unclosed start tag",
          }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: { message_id: 777 } }), { status: 200 }),
      );

    const api = new TelegramApi({ botToken: '123:abc', fetchImpl: fetchMock });
    const messageId = await api.sendMessage({
      chatId: '-10012345',
      topicId: 42,
      html: '<b>broken',
      plain: 'broken',
    });

    expect(messageId).toBe(777);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(firstBody.parse_mode).toBe('HTML');
    expect(firstBody.message_thread_id).toBe(42);
    expect(secondBody.parse_mode).toBeUndefined();
    expect(secondBody.text).toBe('broken');
  });

  it('surfaces 409 Conflict with TelegramApiError errorCode', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 409,
          description: 'Conflict: terminated by other getUpdates request',
        }),
        { status: 409 },
      ),
    );
    const api = new TelegramApi({ botToken: '123:abc', fetchImpl: fetchMock });
    await expect(api.getUpdates({ offset: 1 })).rejects.toMatchObject({
      name: 'TelegramApiError',
      errorCode: 409,
    } satisfies Partial<TelegramApiError>);
  });

  it('uploads multipart attachments using native FormData without manual Content-Type', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-upload-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'report.pdf');
    fs.writeFileSync(filePath, 'pdf-content');

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 888 } }), { status: 200 }),
    );
    const api = new TelegramApi({
      botToken: '123:abc',
      apiBaseUrl: 'https://tg-proxy.example.com/',
      fetchImpl: fetchMock,
    });

    const msgId = await api.uploadMedia({
      chatId: '10086',
      topicId: 9,
      method: 'sendDocument',
      filePath,
      fileName: 'report.pdf',
    });

    expect(msgId).toBe(888);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://tg-proxy.example.com/bot123:abc/sendDocument');
    expect(init?.body).toBeInstanceOf(FormData);
    const form = init?.body as FormData;
    expect(form.get('chat_id')).toBe('10086');
    expect(form.get('message_thread_id')).toBe('9');
    expect(form.get('document')).toBeTruthy();
  });
});
