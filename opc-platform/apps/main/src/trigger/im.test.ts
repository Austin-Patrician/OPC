import { describe, expect, it } from 'vitest';
import { createDingTalkAdapter } from './dingtalk';
import { createFeishuAdapter } from './feishu';
import { hmacBase64, sha256Hex } from './verify';
import type { TriggerRequest } from './types';

/**
 * 两家 IM 的同一道判断题：**哪条消息算一个 Thread**。
 *
 * 结论不是"一个群聊窗口就是一条线"：
 *
 * - 单聊是**信道**（你和助手说话），不该并线——并了线，Router 就再也听不到你说话了；
 * - 群里的一条回复并进它回复的那条根消息（上下文在那里）；
 * - 群里的一条新消息自己开一个话题。
 */

const FEISHU_KEY = 'feishu-key';
const DING_KEY = 'ding-key';

function feishuRequest(payload: unknown): TriggerRequest {
  const body = JSON.stringify(payload);
  const timestamp = '1700000000';
  const nonce = 'n0nce';
  return {
    method: 'POST',
    path: '/hook/feishu',
    headers: {
      'x-lark-request-timestamp': timestamp,
      'x-lark-request-nonce': nonce,
      'x-lark-signature': sha256Hex(`${timestamp}${nonce}${FEISHU_KEY}${body}`),
    },
    body,
  };
}

function feishuMessage(message: Record<string, unknown>) {
  return {
    schema: '2.0',
    header: { event_id: 'ev-1', event_type: 'im.message.receive_v1' },
    event: {
      sender: { sender_id: { open_id: 'ou_me' }, sender_type: 'user' },
      message: { message_type: 'text', content: JSON.stringify({ text: '看一下这个报表' }), ...message },
    },
  };
}

const feishu = createFeishuAdapter(() => FEISHU_KEY);

describe('飞书适配器', () => {
  it('单聊不并线：它是信道，不是工作线', () => {
    const [trigger] = feishu.normalize(
      feishuRequest(feishuMessage({ chat_id: 'oc_dm', chat_type: 'p2p', message_id: 'om_1' })),
    );
    expect(trigger?.identity).toBeNull();
    expect(trigger?.text).toBe('看一下这个报表');
  });

  it('群里的一条回复并进根消息', () => {
    const [trigger] = feishu.normalize(
      feishuRequest(
        feishuMessage({
          chat_id: 'oc_group',
          chat_type: 'group',
          message_id: 'om_2',
          root_id: 'om_root',
        }),
      ),
    );
    expect(trigger?.identity?.key).toBe('im:feishu:oc_group:om_root');
  });

  it('群里的一条新消息自己就是一个话题', () => {
    const [trigger] = feishu.normalize(
      feishuRequest(feishuMessage({ chat_id: 'oc_group', chat_type: 'group', message_id: 'om_3' })),
    );
    expect(trigger?.identity?.key).toBe('im:feishu:oc_group:om_3');
  });

  it('接入挑战原样回 challenge，不落事件', () => {
    const request = feishuRequest({ type: 'url_verification', challenge: 'c-123' });
    expect(feishu.challenge?.(request)).toBe('c-123');
    expect(feishu.normalize(request)).toEqual([]);
  });

  it('不是「收到消息」的事件不落', () => {
    const request = feishuRequest({
      schema: '2.0',
      header: { event_type: 'im.message.read_v1' },
      event: {},
    });
    expect(feishu.normalize(request)).toEqual([]);
  });

  it('签名对得上才放行', () => {
    expect(feishu.verify(feishuRequest(feishuMessage({ chat_id: 'oc', chat_type: 'group' }))).ok).toBe(true);
    const bad = feishuRequest(feishuMessage({ chat_id: 'oc', chat_type: 'group' }));
    expect(feishu.verify({ ...bad, body: `${bad.body} ` }).ok).toBe(false);
  });
});

function dingRequest(payload: unknown, timestamp = '1700000000'): TriggerRequest {
  return {
    method: 'POST',
    path: '/hook/dingtalk',
    headers: {
      timestamp,
      sign: hmacBase64(DING_KEY, `${timestamp}\n${DING_KEY}`),
    },
    body: JSON.stringify(payload),
  };
}

const dingtalk = createDingTalkAdapter(() => DING_KEY);

describe('钉钉适配器', () => {
  it('单聊（conversationType 1）不并线', () => {
    const [trigger] = dingtalk.normalize(
      dingRequest({
        msgtype: 'text',
        text: { content: ' 帮我看下这个 ' },
        conversationId: 'cid-dm',
        conversationType: '1',
        msgId: 'msg-1',
        senderNick: '阿星',
      }),
    );
    expect(trigger?.identity).toBeNull();
    expect(trigger?.text).toBe('帮我看下这个');
    expect(trigger?.actor).toBe('阿星');
  });

  it('群（conversationType 2）以会话为上下文', () => {
    const [trigger] = dingtalk.normalize(
      dingRequest({
        msgtype: 'text',
        text: { content: '这版什么时候发' },
        conversationId: 'cid-group',
        conversationType: '2',
        conversationTitle: '发布群',
        msgId: 'msg-2',
      }),
    );
    expect(trigger?.identity?.key).toBe('im:dingtalk:cid-group');
  });

  it('非文本消息也记一笔，但没有可读正文', () => {
    const [trigger] = dingtalk.normalize(
      dingRequest({ msgtype: 'picture', conversationId: 'cid', conversationType: '2' }),
    );
    expect(trigger?.text).toBe('（picture 消息）');
  });

  it('签名对得上才放行', () => {
    const good = dingRequest({ msgtype: 'text', text: { content: 'x' }, conversationId: 'c', conversationType: '2' });
    expect(dingtalk.verify(good).ok).toBe(true);
    expect(dingtalk.verify({ ...good, headers: { ...good.headers, sign: 'nope' } }).ok).toBe(false);
  });
});
