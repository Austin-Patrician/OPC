import { describe, expect, it } from 'vitest';
import {
  buildDingTalkOutboundMessages,
  extractDingTalkInboundContent,
  formatDingTalkAddress,
  parseDingTalkAddress,
} from './dingtalkFormat';

describe('dingtalkFormat', () => {
  it('formats and parses DM and group DingTalk addresses', () => {
    expect(formatDingTalkAddress('p2p', 'staff_001')).toBe('dingtalk:dm:staff_001');
    expect(formatDingTalkAddress('group', 'cid_abc')).toBe('dingtalk:group:cid_abc');

    expect(parseDingTalkAddress('dingtalk:dm:staff_001')).toEqual({
      chatKind: 'p2p',
      staffId: 'staff_001',
    });
    expect(parseDingTalkAddress('dingtalk:group:cid_abc')).toEqual({
      chatKind: 'group',
      openConversationId: 'cid_abc',
    });
    expect(parseDingTalkAddress('feishu:chat:oc_123')).toBeNull();
  });

  it('extracts text, richText, picture, file, and audio recognition payloads', () => {
    expect(
      extractDingTalkInboundContent({
        msgtype: 'text',
        text: { content: '  帮我总结今天的发布情况  ' },
      }),
    ).toEqual({
      text: '帮我总结今天的发布情况',
      resources: [],
    });

    expect(
      extractDingTalkInboundContent({
        msgtype: 'richText',
        content: {
          richText: [
            { text: '请看截图' },
            { pictureDownloadCode: 'dl_pic_1' },
            { text: '再核对一下' },
          ],
        },
      }),
    ).toEqual({
      text: '请看截图 再核对一下',
      resources: [{ kind: 'image', downloadCode: 'dl_pic_1' }],
    });

    expect(
      extractDingTalkInboundContent({
        msgtype: 'file',
        content: { downloadCode: 'dl_file_1', fileName: 'budget.xlsx' },
      }),
    ).toEqual({
      text: '[用户发送了文件：budget.xlsx]',
      resources: [{ kind: 'file', downloadCode: 'dl_file_1', fileName: 'budget.xlsx' }],
    });

    expect(
      extractDingTalkInboundContent({
        msgtype: 'audio',
        content: { recognition: '明天早上九点发周报', downloadCode: 'dl_audio_1' },
      }),
    ).toEqual({
      text: '明天早上九点发周报',
      resources: [{ kind: 'file', downloadCode: 'dl_audio_1', fileName: 'voice-message.amr' }],
    });
  });

  it('formats simple text vs rich Markdown replies, strips opc-media URLs, and chunks long content', () => {
    const simple = buildDingTalkOutboundMessages(
      [{ type: 'markdown', text: '收到，已经安排处理。' }],
      '',
    );
    expect(simple).toEqual([
      { msgType: 'text', title: 'Buddy 回复', text: '收到，已经安排处理。' },
    ]);

    const rich = buildDingTalkOutboundMessages([
      { type: 'markdown', text: '## 巡检结果\n- 正常：12\n- ![x](opc-media://local/a.png)' },
    ]);
    expect(rich).toHaveLength(1);
    expect(rich[0]?.msgType).toBe('markdown');
    expect(rich[0]?.title).toBe('巡检结果');
    expect(rich[0]?.text).not.toContain('opc-media://');
    expect(rich[0]?.text).toContain('[媒体仅在桌面可用]');

    const longMarkdown = `# 长报告\n${'A'.repeat(4000)}`;
    const chunked = buildDingTalkOutboundMessages([{ type: 'markdown', text: longMarkdown }]);
    expect(chunked.length).toBeGreaterThan(1);
    expect(chunked[0]?.title).toContain('(1/');
  });
});
