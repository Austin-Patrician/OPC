import fs from 'node:fs';
import type { TelegramMediaMethod } from './telegramFormat';

export const DEFAULT_TELEGRAM_API_BASE = 'https://api.telegram.org';
const MAX_INBOUND_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const VERIFY_TIMEOUT_MS = 10_000;

export type FetchLike = typeof fetch;

export function normalizeTelegramApiBaseUrl(raw?: string): string {
  const trimmed = (raw ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return DEFAULT_TELEGRAM_API_BASE;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`无效的 Telegram Bot API 地址: ${trimmed}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Telegram Bot API 地址仅支持 http/https 协议: ${trimmed}`);
  }
  return parsed.toString().replace(/\/+$/, '');
}

export class TelegramApiError extends Error {
  readonly status: number;
  readonly errorCode?: number;
  readonly description?: string;

  constructor(message: string, opts: { status: number; errorCode?: number; description?: string }) {
    super(message);
    this.name = 'TelegramApiError';
    this.status = opts.status;
    this.errorCode = opts.errorCode;
    this.description = opts.description;
  }
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramEntity {
  type: string;
  offset: number;
  length: number;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_size?: number;
  width: number;
  height: number;
}

export interface TelegramFileRef {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  date: number;
  chat: TelegramChat;
  message_thread_id?: number;
  is_topic_message?: boolean;
  reply_to_message?: {
    message_id: number;
    from?: TelegramUser;
  };
  text?: string;
  caption?: string;
  entities?: TelegramEntity[];
  caption_entities?: TelegramEntity[];
  photo?: TelegramPhotoSize[];
  document?: TelegramFileRef;
  audio?: TelegramFileRef;
  voice?: TelegramFileRef;
  video?: TelegramFileRef;
  animation?: TelegramFileRef;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramApiConfig {
  botToken: string;
  apiBaseUrl?: string;
  fetchImpl?: FetchLike;
}

interface TelegramEnvelope<T> {
  ok?: boolean;
  result?: T;
  error_code?: number;
  description?: string;
}

const MEDIA_FIELD_NAME: Record<Exclude<TelegramMediaMethod, 'too_large'>, string> = {
  sendPhoto: 'photo',
  sendAudio: 'audio',
  sendVideo: 'video',
  sendDocument: 'document',
};

export class TelegramApi {
  private readonly baseUrl: string;
  private readonly botToken: string;
  private readonly fetchFn: FetchLike;

  constructor(config: TelegramApiConfig) {
    this.botToken = config.botToken.trim();
    this.baseUrl = normalizeTelegramApiBaseUrl(config.apiBaseUrl);
    this.fetchFn = config.fetchImpl ?? globalThis.fetch;
  }

  private async callJson<T>(
    method: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = `${this.baseUrl}/bot${this.botToken}/${method}`;
    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });

    const json = (await res.json().catch(() => ({}))) as TelegramEnvelope<T>;
    if (!res.ok || !json.ok || json.result === undefined) {
      const desc = json.description || `HTTP ${res.status}`;
      throw new TelegramApiError(`Telegram ${method} 失败: ${desc}`, {
        status: res.status,
        ...(typeof json.error_code === 'number' ? { errorCode: json.error_code } : {}),
        ...(json.description ? { description: json.description } : {}),
      });
    }
    return json.result;
  }

  async getMe(signal?: AbortSignal): Promise<TelegramUser> {
    return this.callJson<TelegramUser>('getMe', undefined, signal);
  }

  async deleteWebhook(dropPendingUpdates = false, signal?: AbortSignal): Promise<boolean> {
    return this.callJson<boolean>(
      'deleteWebhook',
      { drop_pending_updates: dropPendingUpdates },
      signal,
    );
  }

  async getUpdates(params: {
    offset?: number;
    timeoutSec?: number;
    allowedUpdates?: string[];
    signal?: AbortSignal;
  }): Promise<TelegramUpdate[]> {
    return this.callJson<TelegramUpdate[]>(
      'getUpdates',
      {
        ...(typeof params.offset === 'number' ? { offset: params.offset } : {}),
        timeout: params.timeoutSec ?? 25,
        ...(params.allowedUpdates ? { allowed_updates: params.allowedUpdates } : {}),
      },
      params.signal,
    );
  }

  async sendMessage(params: {
    chatId: string;
    html: string;
    plain: string;
    topicId?: number;
    replyToMessageId?: number;
  }): Promise<number> {
    const baseBody: Record<string, unknown> = {
      chat_id: params.chatId,
      ...(typeof params.topicId === 'number' && params.topicId > 0
        ? { message_thread_id: params.topicId }
        : {}),
      ...(typeof params.replyToMessageId === 'number' && params.replyToMessageId > 0
        ? {
            reply_parameters: {
              message_id: params.replyToMessageId,
              allow_sending_without_reply: true,
            },
          }
        : {}),
    };

    try {
      const sent = await this.callJson<{ message_id: number }>('sendMessage', {
        ...baseBody,
        text: params.html,
        parse_mode: 'HTML',
      });
      return sent.message_id;
    } catch (error) {
      const isParseError =
        error instanceof TelegramApiError &&
        error.status === 400 &&
        /parse|entit/i.test(error.description ?? error.message);
      if (!isParseError) {
        throw error;
      }
      const fallback = await this.callJson<{ message_id: number }>('sendMessage', {
        ...baseBody,
        text: params.plain,
      });
      return fallback.message_id;
    }
  }

  async sendChatAction(params: {
    chatId: string;
    action: 'typing';
    topicId?: number;
  }): Promise<boolean> {
    return this.callJson<boolean>('sendChatAction', {
      chat_id: params.chatId,
      action: params.action,
      ...(typeof params.topicId === 'number' && params.topicId > 0
        ? { message_thread_id: params.topicId }
        : {}),
    });
  }

  async downloadFile(
    fileId: string,
    destPath: string,
  ): Promise<{ size: number; filePath: string }> {
    const fileInfo = await this.callJson<{ file_id: string; file_size?: number; file_path?: string }>(
      'getFile',
      { file_id: fileId },
    );
    if (!fileInfo.file_path) {
      throw new Error('Telegram getFile 未返回 file_path');
    }
    if (fileInfo.file_size && fileInfo.file_size > MAX_INBOUND_DOWNLOAD_BYTES) {
      throw new Error('文件超过 Telegram Bot API 20MB 下载上限');
    }

    const downloadUrl = `${this.baseUrl}/file/bot${this.botToken}/${fileInfo.file_path}`;
    const res = await this.fetchFn(downloadUrl);
    if (!res.ok) {
      throw new Error(`下载 Telegram 文件失败 (HTTP ${res.status})`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_INBOUND_DOWNLOAD_BYTES) {
      throw new Error('文件超过 Telegram Bot API 20MB 下载上限');
    }
    fs.writeFileSync(destPath, buf);
    return { size: buf.length, filePath: fileInfo.file_path };
  }

  async uploadMedia(params: {
    chatId: string;
    method: Exclude<TelegramMediaMethod, 'too_large'>;
    filePath: string;
    fileName: string;
    topicId?: number;
  }): Promise<number> {
    const buffer = fs.readFileSync(params.filePath);
    const form = new FormData();
    form.append('chat_id', params.chatId);
    if (typeof params.topicId === 'number' && params.topicId > 0) {
      form.append('message_thread_id', String(params.topicId));
    }
    const fieldName = MEDIA_FIELD_NAME[params.method];
    form.append(fieldName, new Blob([buffer]), params.fileName);

    const url = `${this.baseUrl}/bot${this.botToken}/${params.method}`;
    const res = await this.fetchFn(url, {
      method: 'POST',
      body: form,
    });
    const json = (await res.json().catch(() => ({}))) as TelegramEnvelope<{ message_id: number }>;
    if (!res.ok || !json.ok || !json.result) {
      const desc = json.description || `HTTP ${res.status}`;
      throw new TelegramApiError(`Telegram ${params.method} 上传失败: ${desc}`, {
        status: res.status,
        ...(typeof json.error_code === 'number' ? { errorCode: json.error_code } : {}),
        ...(json.description ? { description: json.description } : {}),
      });
    }
    return json.result.message_id;
  }

  async verifyConnection(): Promise<{
    ok: boolean;
    botName?: string;
    botOpenId?: string;
    error?: string;
    latencyMs: number;
  }> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
    try {
      const me = await this.getMe(controller.signal);
      const botName = me.username
        ? me.first_name
          ? `@${me.username} (${me.first_name})`
          : `@${me.username}`
        : me.first_name;
      return {
        ok: true,
        botName,
        botOpenId: String(me.id),
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      const message =
        error instanceof Error && error.name === 'AbortError'
          ? '连接 Telegram API 超时，请检查「设置 → 网络与代理」配置'
          : error instanceof Error
            ? error.message
            : String(error);
      return {
        ok: false,
        error: message,
        latencyMs: Date.now() - startedAt,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
