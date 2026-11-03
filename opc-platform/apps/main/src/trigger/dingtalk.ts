import { threadIdentity } from '../router/threadKey';
import type { NormalizedTrigger, TriggerAdapter, TriggerRequest } from './types';
import { headerOf, hmacBase64, safeEqual } from './verify';

/**
 * 钉钉自定义机器人 / 事件订阅适配器。
 *
 * 和飞书同一套判断，只是钉钉没有话题 id：一个群就是那个上下文。所以：
 *
 * - `conversationType: '1'`（单聊）→ 不并线，交给 Router（跟桌面聊天是同一条信道）；
 * - `conversationType: '2'`（群）→ `im:dingtalk:<conversationId>`。
 *
 * 这条规则不完美：一个群里同时在聊三件事，它们会并进同一条线。但"猜哪几句话是一件事"
 * 是语义判断，而并线是**程序**判断——程序判断宁可粗，不可错：粗了只是共用上下文，
 * 错了是把两件不相干的事塞进同一个工作线，之后谁也拆不开。
 */

interface DingTalkPayload {
  msgtype?: string;
  text?: { content?: string };
  msgId?: string;
  conversationId?: string;
  conversationType?: string;
  conversationTitle?: string;
  senderNick?: string;
  senderStaffId?: string;
  isInAtList?: boolean;
}

const MAX_TEXT = 4_000;

export function createDingTalkAdapter(secret: () => string | null): TriggerAdapter {
  return {
    id: 'dingtalk',
    source: 'im',

    // 钉钉的签名 header 是 `timestamp` + `sign`；两个同时出现才是它。
    matches: (request) =>
      headerOf(request.headers, 'sign') !== undefined &&
      headerOf(request.headers, 'timestamp') !== undefined,

    verify: (request) => {
      const key = secret()?.trim();
      if (!key) return { ok: false, reason: '没配钉钉加签密钥（设置 → 触发源），无法校验来源' };

      const timestamp = headerOf(request.headers, 'timestamp');
      const given = headerOf(request.headers, 'sign');
      if (!timestamp || !given) return { ok: false, reason: '缺少 timestamp / sign' };

      // 钉钉算法：base64(hmac_sha256(timestamp + "\n" + secret, secret))。
      const expected = hmacBase64(key, `${timestamp}\n${key}`);
      return safeEqual(expected, given.trim()) ? { ok: true } : { ok: false, reason: '签名不匹配' };
    },

    normalize: (request) => normalizeDingTalk(request),
  };
}

function normalizeDingTalk(request: TriggerRequest): NormalizedTrigger[] {
  let payload: DingTalkPayload;
  try {
    payload = JSON.parse(request.body) as DingTalkPayload;
  } catch {
    return [];
  }

  const conversationId = payload.conversationId?.trim();
  if (!conversationId) return [];
  // 只有文本消息有可读正文；图片/文件消息就记一笔"有个东西到了"。
  const text =
    payload.msgtype === 'text'
      ? payload.text?.content?.trim().slice(0, MAX_TEXT)
      : `（${payload.msgtype ?? '未知类型'} 消息）`;

  const identity =
    payload.conversationType === '2' ? threadIdentity('im', `dingtalk:${conversationId}`) : null;
  const who = payload.senderNick?.trim() || payload.senderStaffId?.trim() || '';

  return [
    {
      kind: 'message.received',
      identity,
      summary:
        `钉钉${payload.conversationType === '2' ? `群「${payload.conversationTitle ?? conversationId}」` : '单聊'}` +
        `${who ? ` ${who}` : ''}：${text?.slice(0, 60) ?? '（无正文）'}`,
      ...(text ? { text } : {}),
      ...(who ? { actor: who } : {}),
      ...(payload.msgId ? { deliveryId: `dingtalk:${payload.msgId}` } : {}),
    },
  ];
}
