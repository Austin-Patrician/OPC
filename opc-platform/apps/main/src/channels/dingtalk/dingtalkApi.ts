import fs from 'node:fs';
import path from 'node:path';

export type FetchLike = typeof fetch;

const DINGTALK_API_BASE = 'https://api.dingtalk.com';
const DINGTALK_OAPI_BASE = 'https://oapi.dingtalk.com';
const MAX_DOWNLOAD_BYTES = 30 * 1024 * 1024;
const MAX_MEDIA_UPLOAD_BYTES = 20 * 1024 * 1024;

export interface DingTalkApiConfig {
  clientId: string;
  clientSecret: string;
  fetchImpl?: FetchLike;
}

interface AccessTokenCacheEntry {
  token: string;
  expiresAt: number;
}

export class DingTalkApi {
  private readonly fetchFn: FetchLike;
  private tokenCache: AccessTokenCacheEntry | null = null;

  constructor(private readonly config: DingTalkApiConfig) {
    this.fetchFn = config.fetchImpl ?? globalThis.fetch;
  }

  async getAccessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.tokenCache && this.tokenCache.expiresAt > Date.now() + 5 * 60 * 1000) {
      return this.tokenCache.token;
    }

    const res = await this.fetchFn(`${DINGTALK_API_BASE}/v1.0/oauth2/accessToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appKey: this.config.clientId,
        appSecret: this.config.clientSecret,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      accessToken?: string;
      expireIn?: number;
      message?: string;
      code?: string;
    };

    if (!res.ok || !body.accessToken) {
      throw new Error(
        body.message
          ? `钉钉获取 AccessToken 失败: ${body.message}`
          : `钉钉获取 AccessToken 失败 (HTTP ${res.status})`,
      );
    }

    const expireSec = typeof body.expireIn === 'number' && body.expireIn > 0 ? body.expireIn : 7200;
    this.tokenCache = {
      token: body.accessToken,
      expiresAt: Date.now() + expireSec * 1000,
    };
    return body.accessToken;
  }

  /**
   * Validates credentials against OAuth2 AND checks Stream gateway registration so
   * users immediately catch missing Bot / Stream capability during setup.
   */
  async verifyConnection(): Promise<{ ok: boolean; error?: string; latencyMs: number }> {
    const startedAt = Date.now();
    try {
      await this.getAccessToken(true);
      const gatewayRes = await this.fetchFn(`${DINGTALK_API_BASE}/v1.0/gateway/connections/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: this.config.clientId,
          clientSecret: this.config.clientSecret,
          subscriptions: [{ type: 'CALLBACK', topic: '/v1.0/im/bot/messages/get' }],
          ua: 'opc-buddy-dingtalk',
        }),
      });
      const gatewayBody = (await gatewayRes.json().catch(() => ({}))) as {
        endpoint?: string;
        ticket?: string;
        message?: string;
      };
      if (!gatewayRes.ok || !gatewayBody.endpoint) {
        return {
          ok: false,
          error:
            gatewayBody.message ??
            `Stream 网关校验失败 (HTTP ${gatewayRes.status})，请确认已开启「机器人」能力并选择「Stream 模式」`,
          latencyMs: Date.now() - startedAt,
        };
      }
      return { ok: true, latencyMs: Date.now() - startedAt };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - startedAt,
      };
    }
  }

  private async postOpenApiWithRetry<T>(
    urlPath: string,
    payload: unknown,
  ): Promise<T> {
    let token = await this.getAccessToken();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await this.fetchFn(`${DINGTALK_API_BASE}${urlPath}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-acs-dingtalk-access-token': token,
        },
        body: JSON.stringify(payload),
      });
      if (res.status === 401 && attempt === 0) {
        token = await this.getAccessToken(true);
        continue;
      }
      const data = (await res.json().catch(() => ({}))) as T & {
        message?: string;
        code?: string;
      };
      if (!res.ok) {
        throw new Error(
          data.message
            ? `钉钉 OpenAPI 调用失败 (${res.status}): ${data.message}`
            : `钉钉 OpenAPI 调用失败 (HTTP ${res.status})`,
        );
      }
      return data;
    }
    throw new Error('钉钉 OpenAPI Token 重试失败');
  }

  async downloadMessageFile(input: {
    downloadCode: string;
    robotCode: string;
    destPath: string;
  }): Promise<{ size: number }> {
    const res = await this.postOpenApiWithRetry<{ downloadUrl?: string }>(
      '/v1.0/robot/messageFiles/download',
      {
        downloadCode: input.downloadCode,
        robotCode: input.robotCode,
      },
    );
    if (!res.downloadUrl) {
      throw new Error('钉钉未返回附件下载链接');
    }

    const fileRes = await this.fetchFn(res.downloadUrl);
    if (!fileRes.ok) {
      throw new Error(`下载钉钉附件失败 (HTTP ${fileRes.status})`);
    }
    const arrayBuffer = await fileRes.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_DOWNLOAD_BYTES) {
      throw new Error('钉钉附件超过 30MB 限制，已跳过下载');
    }
    fs.mkdirSync(path.dirname(input.destPath), { recursive: true });
    fs.writeFileSync(input.destPath, Buffer.from(arrayBuffer));
    return { size: arrayBuffer.byteLength };
  }

  async uploadMedia(input: {
    filePath: string;
    fileName: string;
    kind: 'image' | 'file';
  }): Promise<string> {
    const stat = fs.statSync(input.filePath, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size <= 0) {
      throw new Error(`无法读取待上传文件: ${input.filePath}`);
    }
    if (stat.size > MAX_MEDIA_UPLOAD_BYTES) {
      throw new Error(`文件 ${input.fileName} 超过钉钉 20MB 上传上限`);
    }

    const bytes = fs.readFileSync(input.filePath);
    const token = await this.getAccessToken();
    const form = new FormData();
    form.append('media', new Blob([bytes]), input.fileName);

    const url = `${DINGTALK_OAPI_BASE}/media/upload?access_token=${encodeURIComponent(token)}&type=${input.kind}`;
    const res = await this.fetchFn(url, {
      method: 'POST',
      body: form,
    });
    const body = (await res.json().catch(() => ({}))) as {
      errcode?: number;
      errmsg?: string;
      media_id?: string;
    };
    if (!res.ok || (typeof body.errcode === 'number' && body.errcode !== 0) || !body.media_id) {
      throw new Error(
        body.errmsg
          ? `钉钉上传媒体失败 (${body.errcode ?? res.status}): ${body.errmsg}`
          : `钉钉上传媒体失败 (HTTP ${res.status})`,
      );
    }
    return body.media_id;
  }

  async sendViaSessionWebhook(
    webhookUrl: string,
    spec: { msgType: 'text' | 'markdown'; title: string; text: string },
  ): Promise<void> {
    const body =
      spec.msgType === 'markdown'
        ? {
            msgtype: 'markdown',
            markdown: {
              title: spec.title,
              text: spec.text,
            },
          }
        : {
            msgtype: 'text',
            text: {
              content: spec.text,
            },
          };

    const res = await this.fetchFn(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as {
      errcode?: number;
      errmsg?: string;
    };
    if (!res.ok || (typeof json.errcode === 'number' && json.errcode !== 0)) {
      throw new Error(
        json.errmsg
          ? `钉钉 Webhook 回复失败: ${json.errmsg}`
          : `钉钉 Webhook 回复失败 (HTTP ${res.status})`,
      );
    }
  }

  async sendDirectMessage(input: {
    robotCode: string;
    staffId: string;
    msgKey: string;
    msgParam: Record<string, unknown>;
  }): Promise<string | undefined> {
    const res = await this.postOpenApiWithRetry<{ processQueryKey?: string }>(
      '/v1.0/robot/oToMessages/batchSend',
      {
        robotCode: input.robotCode,
        userIds: [input.staffId],
        msgKey: input.msgKey,
        msgParam: JSON.stringify(input.msgParam),
      },
    );
    return res.processQueryKey;
  }

  async sendGroupMessage(input: {
    robotCode: string;
    openConversationId: string;
    msgKey: string;
    msgParam: Record<string, unknown>;
  }): Promise<string | undefined> {
    const res = await this.postOpenApiWithRetry<{ processQueryKey?: string }>(
      '/v1.0/robot/groupMessages/send',
      {
        robotCode: input.robotCode,
        openConversationId: input.openConversationId,
        msgKey: input.msgKey,
        msgParam: JSON.stringify(input.msgParam),
      },
    );
    return res.processQueryKey;
  }
}
