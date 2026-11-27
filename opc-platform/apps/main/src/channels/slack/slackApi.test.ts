import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SlackApi } from './slackApi';

describe('SlackApi', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length) {
      const dir = tempDirs.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('validates token prefixes and verifies auth.test + apps.connections.open', async () => {
    const badApi = new SlackApi({
      botToken: 'xapp-wrong',
      appToken: 'xoxb-wrong',
      fetchImpl: vi.fn<typeof fetch>(),
    });
    const invalid = await badApi.verifyConnection();
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toContain('xoxb-');

    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/auth.test')) {
        return new Response(
          JSON.stringify({ ok: true, user_id: 'UBOT1', user: 'buddy', team: 'Acme' }),
          { status: 200 },
        );
      }
      if (url.endsWith('/apps.connections.open')) {
        return new Response(
          JSON.stringify({ ok: true, url: 'wss://wss-primary.slack.com/link?ticket=1' }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const okApi = new SlackApi({
      botToken: 'xoxb-valid',
      appToken: 'xapp-valid',
      fetchImpl: fetchMock,
    });
    const verified = await okApi.verifyConnection();
    expect(verified.ok).toBe(true);
    expect(verified.botName).toBe('Acme · buddy');
    expect(verified.botOpenId).toBe('UBOT1');
  });

  it('posts threaded messages and ignores benign reaction edge cases', async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
      if (url.endsWith('/chat.postMessage')) {
        return new Response(JSON.stringify({ ok: true, ts: '1700000001.100' }), { status: 200 });
      }
      if (url.endsWith('/reactions.add')) {
        return new Response(JSON.stringify({ ok: false, error: 'already_reacted' }), { status: 200 });
      }
      if (url.endsWith('/reactions.remove')) {
        return new Response(JSON.stringify({ ok: false, error: 'no_reaction' }), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const api = new SlackApi({ botToken: 'xoxb-1', appToken: 'xapp-1', fetchImpl: fetchMock });
    const ts = await api.postMessage({
      channel: 'C123',
      text: 'Hello',
      threadTs: '1700000000.001',
    });
    expect(ts).toBe('1700000001.100');
    expect(calls[0]?.body).toContain('1700000000.001');

    await expect(api.addReaction('C123', '1700.1', 'thinking_face')).resolves.toBeUndefined();
    await expect(api.removeReaction('C123', '1700.1', 'thinking_face')).resolves.toBeUndefined();
  });

  it('downloads private files (catching HTML redirects) and completes 3-step files.uploadV2', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-api-test-'));
    tempDirs.push(tmpDir);
    const dlPath = path.join(tmpDir, 'note.txt');
    const uploadSource = path.join(tmpDir, 'summary.pdf');
    fs.writeFileSync(uploadSource, Buffer.from('%PDF-1.4 test payload'));

    const stepLog: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === 'https://files.slack.com/html-redirect') {
        return new Response('<html>Sign in</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      if (url === 'https://files.slack.com/private-note') {
        return new Response('slack secret bytes', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
      }
      if (url.endsWith('/files.getUploadURLExternal')) {
        stepLog.push(`1:${(init?.headers as Record<string, string>)['Content-Type']}`);
        return new Response(
          JSON.stringify({
            ok: true,
            upload_url: 'https://files.slack.com/upload/v1/abc',
            file_id: 'F999',
          }),
          { status: 200 },
        );
      }
      if (url === 'https://files.slack.com/upload/v1/abc') {
        stepLog.push('2:binary');
        return new Response('OK', { status: 200 });
      }
      if (url.endsWith('/files.completeUploadExternal')) {
        stepLog.push(`3:${String(init?.body ?? '')}`);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const api = new SlackApi({ botToken: 'xoxb-1', appToken: 'xapp-1', fetchImpl: fetchMock });

    await expect(
      api.downloadPrivateFile('https://files.slack.com/html-redirect', dlPath),
    ).rejects.toThrow('files:read');

    const dl = await api.downloadPrivateFile('https://files.slack.com/private-note', dlPath);
    expect(dl.size).toBe(18);
    expect(fs.readFileSync(dlPath, 'utf8')).toBe('slack secret bytes');

    await api.uploadFileV2({
      channelId: 'C888',
      filePath: uploadSource,
      fileName: 'summary.pdf',
      threadTs: '1700.55',
    });
    expect(stepLog[0]).toBe('1:application/x-www-form-urlencoded');
    expect(stepLog[1]).toBe('2:binary');
    expect(stepLog[2]).toContain('"channel_id":"C888"');
    expect(stepLog[2]).toContain('"thread_ts":"1700.55"');
  });
});
