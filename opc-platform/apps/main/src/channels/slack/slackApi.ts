import fs from 'node:fs';
import path from 'node:path';

export type FetchLike = typeof fetch;

const SLACK_API_BASE = 'https://slack.com/api';
const MAX_DOWNLOAD_BYTES = 30 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export interface SlackApiConfig {
  botToken: string;
  appToken: string;
  fetchImpl?: FetchLike;
}

interface SlackApiResponse {
  ok?: boolean;
  error?: string;
}

export class SlackApi {
  private readonly fetchFn: FetchLike;
  private userNameCache = new Map<string, string>();
  private channelNameCache = new Map<string, string>();

  constructor(private readonly config: SlackApiConfig) {
    this.fetchFn = config.fetchImpl ?? globalThis.fetch;
  }

  private async postJson<T extends SlackApiResponse>(
    endpoint: string,
    token: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const res = await this.fetchFn(`${SLACK_API_BASE}/${endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json().catch(() => ({}))) as T;
    if (!res.ok || !json.ok) {
      throw new Error(
        json.error
          ? `Slack API ${endpoint} 失败: ${json.error}`
          : `Slack API ${endpoint} 失败 (HTTP ${res.status})`,
      );
    }
    return json;
  }

  private async getJson<T extends SlackApiResponse>(
    endpoint: string,
    token: string,
    params: Record<string, string>,
  ): Promise<T> {
    const qs = new URLSearchParams(params).toString();
    const res = await this.fetchFn(`${SLACK_API_BASE}/${endpoint}?${qs}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    const json = (await res.json().catch(() => ({}))) as T;
    if (!res.ok || !json.ok) {
      throw new Error(
        json.error
          ? `Slack API ${endpoint} 失败: ${json.error}`
          : `Slack API ${endpoint} 失败 (HTTP ${res.status})`,
      );
    }
    return json;
  }

  async authTest(): Promise<{
    userId: string;
    botId?: string;
    botName?: string;
    teamName?: string;
  }> {
    const res = await this.postJson<{
      ok?: boolean;
      error?: string;
      user_id?: string;
      bot_id?: string;
      user?: string;
      team?: string;
    }>('auth.test', this.config.botToken);
    if (!res.user_id) {
      throw new Error('Slack auth.test 未返回 user_id');
    }
    return {
      userId: res.user_id,
      ...(res.bot_id ? { botId: res.bot_id } : {}),
      ...(res.user ? { botName: res.user } : {}),
      ...(res.team ? { teamName: res.team } : {}),
    };
  }

  async openSocketConnection(): Promise<string> {
    const res = await this.postJson<{ ok?: boolean; error?: string; url?: string }>(
      'apps.connections.open',
      this.config.appToken,
    );
    if (!res.url) {
      throw new Error('Slack apps.connections.open 未返回 WebSocket URL');
    }
    return res.url;
  }

  async verifyConnection(): Promise<{
    ok: boolean;
    botName?: string;
    botOpenId?: string;
    error?: string;
    latencyMs: number;
  }> {
    const startedAt = Date.now();
    if (!this.config.botToken.startsWith('xoxb-')) {
      return {
        ok: false,
        error: 'Bot Token 格式应以 xoxb- 开头，请检查是否与 App-Level Token 填反',
        latencyMs: Date.now() - startedAt,
      };
    }
    if (!this.config.appToken.startsWith('xapp-')) {
      return {
        ok: false,
        error: 'App-Level Token 格式应以 xapp- 开头，请在 Slack Basic Information 生成',
        latencyMs: Date.now() - startedAt,
      };
    }

    try {
      const auth = await this.authTest();
      await this.openSocketConnection();
      const displayBot = auth.teamName && auth.botName
        ? `${auth.teamName} · ${auth.botName}`
        : auth.botName ?? auth.teamName;
      return {
        ok: true,
        ...(displayBot ? { botName: displayBot } : {}),
        botOpenId: auth.userId,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - startedAt,
      };
    }
  }

  async postMessage(input: {
    channel: string;
    text: string;
    threadTs?: string;
  }): Promise<string | undefined> {
    const res = await this.postJson<{ ok?: boolean; error?: string; ts?: string }>(
      'chat.postMessage',
      this.config.botToken,
      {
        channel: input.channel,
        text: input.text,
        mrkdwn: true,
        ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
      },
    );
    return res.ts;
  }

  async addReaction(channel: string, timestamp: string, name: string): Promise<void> {
    try {
      await this.postJson('reactions.add', this.config.botToken, {
        channel,
        timestamp,
        name,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : '';
      if (!msg.includes('already_reacted')) throw error;
    }
  }

  async removeReaction(channel: string, timestamp: string, name: string): Promise<void> {
    try {
      await this.postJson('reactions.remove', this.config.botToken, {
        channel,
        timestamp,
        name,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : '';
      if (!msg.includes('no_reaction')) throw error;
    }
  }

  async getUserName(userId: string): Promise<string> {
    if (!userId) return 'Slack 用户';
    const cached = this.userNameCache.get(userId);
    if (cached) return cached;
    try {
      const res = await this.getJson<{
        ok?: boolean;
        error?: string;
        user?: { real_name?: string; profile?: { display_name?: string }; name?: string };
      }>('users.info', this.config.botToken, { user: userId });
      const name =
        res.user?.profile?.display_name?.trim() ||
        res.user?.real_name?.trim() ||
        res.user?.name?.trim();
      if (name) {
        this.userNameCache.set(userId, name);
        return name;
      }
    } catch {
      // Optional users:read scope may not be granted; gracefully fall back.
    }
    return `Slack ${userId}`;
  }

  async getChannelName(channelId: string): Promise<string | undefined> {
    if (!channelId) return undefined;
    const cached = this.channelNameCache.get(channelId);
    if (cached) return cached;
    try {
      const res = await this.getJson<{
        ok?: boolean;
        error?: string;
        channel?: { name?: string };
      }>('conversations.info', this.config.botToken, { channel: channelId });
      const name = res.channel?.name?.trim();
      if (name) {
        this.channelNameCache.set(channelId, name);
        return name;
      }
    } catch {
      // Graceful fallback when channel metadata is unavailable.
    }
    return undefined;
  }

  async downloadPrivateFile(url: string, destPath: string): Promise<{ size: number }> {
    const res = await this.fetchFn(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.config.botToken}`,
      },
    });
    if (!res.ok) {
      throw new Error(`下载 Slack 附件失败 (HTTP ${res.status})`);
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('text/html')) {
      throw new Error('Slack 返回了登录页而非文件流，请确认 Bot 已开通 files:read 权限');
    }
    const arrayBuffer = await res.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_DOWNLOAD_BYTES) {
      throw new Error('Slack 附件超过 30MB 限制，已跳过下载');
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, Buffer.from(arrayBuffer));
    return { size: arrayBuffer.byteLength };
  }

  async uploadFileV2(input: {
    channelId: string;
    filePath: string;
    fileName: string;
    threadTs?: string;
  }): Promise<void> {
    const stat = fs.statSync(input.filePath, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size <= 0) {
      throw new Error(`无法读取待上传文件: ${input.filePath}`);
    }
    if (stat.size > MAX_UPLOAD_BYTES) {
      throw new Error(`文件 ${input.fileName} 超过 100MB 上传限制`);
    }

    // Step 1: getUploadURLExternal expects application/x-www-form-urlencoded.
    const urlRes = await this.fetchFn(`${SLACK_API_BASE}/files.getUploadURLExternal`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.botToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        filename: input.fileName,
        length: String(stat.size),
      }).toString(),
    });
    const urlJson = (await urlRes.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      upload_url?: string;
      file_id?: string;
    };
    if (!urlRes.ok || !urlJson.ok || !urlJson.upload_url || !urlJson.file_id) {
      throw new Error(
        urlJson.error
          ? `Slack 申请文件上传地址失败: ${urlJson.error}`
          : `Slack 申请文件上传地址失败 (HTTP ${urlRes.status})`,
      );
    }

    // Step 2: upload raw binary bytes directly to upload_url.
    const fileBytes = fs.readFileSync(input.filePath);
    const putRes = await this.fetchFn(urlJson.upload_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
      },
      body: fileBytes,
    });
    if (!putRes.ok) {
      throw new Error(`Slack 上传文件字节流失败 (HTTP ${putRes.status})`);
    }

    // Step 3: completeUploadExternal shares file into the channel (and optional thread).
    await this.postJson('files.completeUploadExternal', this.config.botToken, {
      files: [{ id: urlJson.file_id, title: input.fileName }],
      channel_id: input.channelId,
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
    });
  }
}
