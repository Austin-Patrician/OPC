import { describe, expect, it } from 'vitest';
import {
  buildFeishuOutboundMessages,
  extractFeishuInboundContent,
  formatFeishuAddress,
  parseFeishuAddress,
  stripFeishuMentions,
} from './feishuFormat';

describe('feishuFormat', () => {
  it('formats and parses Feishu chat addresses', () => {
    expect(formatFeishuAddress('oc_123abc')).toBe('feishu:chat:oc_123abc');
    expect(parseFeishuAddress('feishu:chat:oc_123abc')).toBe('oc_123abc');
    expect(parseFeishuAddress('oc_direct')).toBe('oc_direct');
    expect(parseFeishuAddress('slack:channel:C123')).toBeNull();
  });

  it('strips bot mention placeholders cleanly', () => {
    const cleaned = stripFeishuMentions('@_user_1  帮我看下这个周报 @_user_2', [
      { key: '@_user_1', name: 'Buddy' },
    ]);
    expect(cleaned).toBe('帮我看下这个周报');
  });

  it('extracts text and image keys from Feishu rich-text post messages', () => {
    const parsed = extractFeishuInboundContent(
      'post',
      JSON.stringify({
        zh_cn: {
          title: '发布确认',
          content: [
            [
              { tag: 'at', user_name: 'Buddy' },
              { tag: 'text', text: ' 请查看截图' },
            ],
            [
              { tag: 'img', image_key: 'img_v2_abc123' },
              { tag: 'a', text: '工单链接', href: 'https://example.com/1' },
            ],
          ],
        },
      }),
    );
    expect(parsed.text).toContain('发布确认');
    expect(parsed.text).toContain('[工单链接](https://example.com/1)');
    expect(parsed.resources).toEqual([{ kind: 'image', fileKey: 'img_v2_abc123' }]);
  });

  it('extracts image and file resources', () => {
    expect(
      extractFeishuInboundContent('image', JSON.stringify({ image_key: 'img_999' })),
    ).toEqual({
      text: '[用户发送了一张图片]',
      resources: [{ kind: 'image', fileKey: 'img_999' }],
    });

    expect(
      extractFeishuInboundContent(
        'file',
        JSON.stringify({ file_key: 'file_777', file_name: 'report.pdf' }),
      ),
    ).toEqual({
      text: '[用户发送了文件：report.pdf]',
      resources: [{ kind: 'file', fileKey: 'file_777', fileName: 'report.pdf' }],
    });
  });

  it('uses plain text for short simple replies and interactive Markdown card for rich replies', () => {
    const simple = buildFeishuOutboundMessages(
      [{ type: 'markdown', text: '好的，已经记下了。' }],
      '好的，已经记下了。',
    );
    expect(simple).toHaveLength(1);
    expect(simple[0]?.msgType).toBe('text');

    const rich = buildFeishuOutboundMessages(
      [
        { type: 'markdown', text: '## 报告摘要\n- 第一项已完成\n- **第二项**进行中' },
        {
          type: 'file',
          source: { type: 'artifact', taskId: 'task_1', relPath: 'output/report.pdf' },
          name: 'report.pdf',
        },
      ],
      'fallback',
    );
    expect(rich).toHaveLength(1);
    expect(rich[0]?.msgType).toBe('interactive');
    const card = JSON.parse(rich[0]!.content) as {
      elements: Array<{ tag: string; content: string }>;
    };
    expect(card.elements[0]?.content).toContain('## 报告摘要');
    expect(card.elements[0]?.content).toContain('report.pdf');
  });
});
