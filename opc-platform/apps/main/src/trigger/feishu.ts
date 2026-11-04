import { threadIdentity } from '../router/threadKey';
import type { NormalizedTrigger, TriggerAdapter, TriggerRequest } from './types';
import { headerOf, safeEqual, sha256Hex } from './verify';

/**
 * 飞书（Lark）事件订阅适配器。
 *
 * 这里最值得说的是**哪条消息算一个 Thread**。原文的定义是"具备连续 / 完整上下文的
 * request"，落到 IM 上并不等于"一个群聊窗口"：
 *
 * - **单聊**（`chat_type: 'p2p'`）→ **不并线**。它是你（或你的同事）跟这个助手说话的
 *   信道，和桌面上的聊天窗口是同一件事。给它一个身份的话，一旦某条线订阅了这个键，
 *   你后面说的每一句都会被直通给执行体，Router 再也听不到人说话——这正是聊天那条
 *   链路上已经踩过一次的坑。
 * - **群里的一条新消息** → 它**开了**一个话题，身份就是它自己。
 * - **群里的一条回复** → 并进它回复的那条根消息，因为上下文在那里。
 *
 * 于是"同一个话题"在飞书里有了确定的含义，而不是靠我们猜"这两句话像不像一件事"。
 */

interface FeishuEnvelope {
  type?: string;
  challenge?: string;
  token?: string;
  schema?: string;
  header?: {
    event_id?: string;
    event_type?: string;
    create_time?: string;
    token?: string;
  };
  event?: {
    sender?: { sender_id?: { open_id?: string; user_id?: string }; sender_type?: string };
    message?: {
      message_id?: string;
      root_id?: string;
      parent_id?: string;
      thread_id?: string;
      chat_id?: string;
      chat_type?: string;
      message_type?: string;
      content?: string;
    };
  };
}

const MAX_TEXT = 4_000;

/** `content` 是一个 JSON 字符串；text 消息是 `{"text":"..."}`。 */
function textOf(message: { message_type?: string; content?: string }): string | undefined {
  if (!message.content) return undefined;
  if (message.message_type === 'text') {
    try {
      const parsed = JSON.parse(message.content) as { text?: string };
      const text = (parsed.text ?? '').trim();
      return text ? text.slice(0, MAX_TEXT) : undefined;
    } catch {
      return undefined;
    }
  }
  // 图片/文件/富文本：正文没有可读的一句话，只留类型。
  return `（${message.message_type ?? '未知类型'} 消息）`;
}

export function createFeishuAdapter(secret: () => string | null): TriggerAdapter {
  return {
    id: 'feishu',
    source: 'im',

    // 飞书的事件回调没有稳定的路径约定，靠 header 认：v2 一定有 `X-Lark-Signature`
    // 或 `X-Lark-Request-Timestamp`；接入时的 challenge 只在正文里。
    matches: (request) =>
      headerOf(request.headers, 'x-lark-signature') !== undefined ||
      headerOf(request.headers, 'x-lark-request-timestamp') !== undefined ||
      readEnvelope(request)?.type === 'url_verification',

    verify: (request) => {
      // 接入时的挑战请求还没有签名可验（密钥才刚填进去）。它不带任何工作内容，
      // 回一个 challenge 就走，不落事件。
      if (readEnvelope(request)?.type === 'url_verification') return { ok: true };

      const key = secret()?.trim();
      if (!key) return { ok: false, reason: '没配飞书 Encrypt Key（设置 → 触发源），无法校验来源' };

      const signature = headerOf(request.headers, 'x-lark-signature');
      const timestamp = headerOf(request.headers, 'x-lark-request-timestamp');
      const nonce = headerOf(request.headers, 'x-lark-request-nonce');
      if (!signature || !timestamp || !nonce) {
        return { ok: false, reason: '缺少 X-Lark-Signature / timestamp / nonce' };
      }
      // 飞书的算法：sha256(timestamp + nonce + encryptKey + body)，输出小写 hex。
      const expected = sha256Hex(`${timestamp}${nonce}${key}${request.body}`);
      return safeEqual(expected, signature.trim().toLowerCase())
        ? { ok: true }
        : { ok: false, reason: '签名不匹配' };
    },

    challenge: (request) => {
      const envelope = readEnvelope(request);
      return envelope?.type === 'url_verification' && envelope.challenge ? envelope.challenge : null;
    },

    normalize: (request) => normalizeFeishu(request),
  };
}

function readEnvelope(request: TriggerRequest): FeishuEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(request.body);
    return parsed && typeof parsed === 'object' ? (parsed as FeishuEnvelope) : null;
  } catch {
    return null;
  }
}

function normalizeFeishu(request: TriggerRequest): NormalizedTrigger[] {
  const envelope = readEnvelope(request);
  if (!envelope) return [];
  // 接入挑战、以及任何不是"收到消息"的事件（已读回执、成员变更）都不是活。
  if (envelope.type === 'url_verification') return [];
  if (envelope.header?.event_type !== 'im.message.receive_v1') return [];

  const message = envelope.event?.message ?? {};
  const chatId = message.chat_id?.trim();
  if (!chatId) return [];

  const identity = identityFor(message);
  const text = textOf(message);
  const sender = envelope.event?.sender?.sender_id?.open_id ?? '';
  const externalId = identity?.externalId ?? null;

  return [
    {
      kind: 'message.received',
      identity,
      summary: externalId
        ? `飞书 ${message.chat_type === 'p2p' ? '单聊' : '群'} ${externalId}：${text?.slice(0, 60) ?? '（无正文）'}`
        : `飞书单聊 ${chatId}：${text?.slice(0, 60) ?? '（无正文）'}`,
      ...(text ? { text } : {}),
      ...(sender ? { actor: sender } : {}),
      ...(message.message_id ? { deliveryId: `feishu:${message.message_id}` } : {}),
      replyTarget: {
        adapterId: 'feishu',
        source: 'im',
        address: `im:feishu:${chatId}`,
        ...(message.message_id ? { messageId: message.message_id } : {}),
      },
    },
  ];
}

/**
 * 单聊不并线；群里回复并到根消息；群里新消息自己开一个话题。
 *
 * `thread_id` 是飞书的话题 id，`root_id` / `parent_id` 是回复链，三种都有时按最外层算。
 */
function identityFor(message: {
  chat_id?: string;
  chat_type?: string;
  message_id?: string;
  root_id?: string;
  parent_id?: string;
  thread_id?: string;
}) {
  const chatId = message.chat_id?.trim();
  if (!chatId) return null;
  if (message.chat_type === 'p2p') return null;

  const topic =
    message.thread_id?.trim() ||
    message.root_id?.trim() ||
    message.parent_id?.trim() ||
    message.message_id?.trim();
  if (!topic) return null;
  return threadIdentity('im', `feishu:${chatId}:${topic}`);
}
