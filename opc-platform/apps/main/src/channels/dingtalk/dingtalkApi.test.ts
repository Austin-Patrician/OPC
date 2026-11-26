import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DingTalkApi } from './dingtalkApi';

describe('DingTalkApi', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length) {
      const dir = tempDirs.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('caches access tokens and retries once on HTTP 401', async () => {
    let tokenCalls = 0;
    let sendCalls = 0;

    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/v1.0/oauth2/accessToken')) {
        tokenCalls += 1;
        return new Response(
          JSON.stringify({ accessToken: `tok_${tokenCalls}`, expireIn: 7200 }),
          { status: 200 },
        );
      }
      if (url.includes('/v1.0/robot/oToMessages/batchSend')) {
        sendCalls += 1;
        if (sendCalls === 1) {
          return new Response(JSON.stringify({ message: 'expired' }), { status: 401 });
        }
        return new Response(JSON.stringify({ processQueryKey: 'pq_1' }), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const api = new DingTalkApi({
      clientId: 'ding_app',
      clientSecret: 'sec_app',
      fetchImpl: fetchMock,
    });

    expect(await api.getAccessToken()).toBe('tok_1');
    expect(await api.getAccessToken()).toBe('tok_1');
    expect(tokenCalls).toBe(1);

    const key = await api.sendDirectMessage({
      robotCode: 'ding_app',
      staffId: 'staff_1',
      msgKey: 'sampleText',
      msgParam: { content: 'hi' },
    });
    expect(key).toBe('pq_1');
    expect(tokenCalls).toBe(2);
    expect(sendCalls).toBe(2);
  });

  it('verifies credentials against OAuth2 and Stream gateway', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/v1.0/oauth2/accessToken')) {
        return new Response(JSON.stringify({ accessToken: 'tok_ok', expireIn: 7200 }), {
          status: 200,
        });
      }
      if (url.includes('/v1.0/gateway/connections/open')) {
        return new Response(
          JSON.stringify({ endpoint: 'wss://wss.dingtalk.com', ticket: 't1' }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const api = new DingTalkApi({
      clientId: 'ding_app',
      clientSecret: 'sec_app',
      fetchImpl: fetchMock,
    });

    const result = await api.verifyConnection();
    expect(result.ok).toBe(true);
  });

  it('downloads inbound files via downloadCode and uploads media via oapi', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-api-test-'));
    tempDirs.push(tmpDir);
    const destPath = path.join(tmpDir, 'downloaded.txt');
    const uploadSource = path.join(tmpDir, 'out.png');
    fs.writeFileSync(uploadSource, Buffer.from([137, 80, 78, 71, 1, 2, 3]));

    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/v1.0/oauth2/accessToken')) {
        return new Response(JSON.stringify({ accessToken: 'tok_1', expireIn: 7200 }), {
          status: 200,
        });
      }
      if (url.includes('/v1.0/robot/messageFiles/download')) {
        return new Response(JSON.stringify({ downloadUrl: 'https://cdn.example.com/file.txt' }), {
          status: 200,
        });
      }
      if (url === 'https://cdn.example.com/file.txt') {
        return new Response('hello dingtalk attachment', { status: 200 });
      }
      if (url.includes('/media/upload')) {
        return new Response(JSON.stringify({ errcode: 0, media_id: '@lALP_media_99' }), {
          status: 200,
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const api = new DingTalkApi({
      clientId: 'ding_app',
      clientSecret: 'sec_app',
      fetchImpl: fetchMock,
    });

    const dl = await api.downloadMessageFile({
      downloadCode: 'dc_1',
      robotCode: 'ding_app',
      destPath,
    });
    expect(dl.size).toBe(25);
    expect(fs.readFileSync(destPath, 'utf8')).toBe('hello dingtalk attachment');

    const mediaId = await api.uploadMedia({
      filePath: uploadSource,
      fileName: 'out.png',
      kind: 'image',
    });
    expect(mediaId).toBe('@lALP_media_99');
  });
});
