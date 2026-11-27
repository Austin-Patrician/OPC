import { describe, expect, it } from 'vitest';
import {
  buildSlackOutboundMessages,
  formatSlackAddress,
  markdownToSlackMrkdwn,
  parseSlackAddress,
  stripSlackBotMention,
} from './slackFormat';

describe('slackFormat', () => {
  it('formats and parses Slack channel addresses', () => {
    expect(formatSlackAddress('C0123456789')).toBe('slack:channel:C0123456789');
    expect(parseSlackAddress('slack:channel:C0123456789')).toBe('C0123456789');
    expect(parseSlackAddress('D0123456789')).toBe('D0123456789');
    expect(parseSlackAddress('feishu:chat:oc_123')).toBeNull();
  });

  it('strips Slack bot mentions without collapsing newlines', () => {
    expect(stripSlackBotMention('<@U99BOT123>  第一行\n  第二行', 'U99BOT123')).toBe(
      '第一行\n 第二行',
    );
    expect(stripSlackBotMention('<@U99BOT123|Buddy> hi')).toBe('hi');
  });

  it('converts Markdown to Slack mrkdwn while keeping code blocks verbatim', () => {
    const md = [
      '## 发布摘要',
      '请查看 **核心指标** 与 ~~旧方案~~，详情点击 [控制台](https://example.com/app)。',
      '`const keep = "**not_bold** [x](https://a.com)";`',
      '```ts',
      'const link = "[keep](https://b.com)";',
      'const bold = "**keep**";',
      '```',
      '![img](opc-media://local/preview.png)',
    ].join('\n');

    const mrkdwn = markdownToSlackMrkdwn(md);
    expect(mrkdwn).toContain('*发布摘要*');
    expect(mrkdwn).toContain('*核心指标*');
    expect(mrkdwn).toContain('~旧方案~');
    expect(mrkdwn).toContain('<https://example.com/app|控制台>');
    expect(mrkdwn).toContain('`const keep = "**not_bold** [x](https://a.com)";`');
    expect(mrkdwn).toContain('const bold = "**keep**";');
    expect(mrkdwn).not.toContain('opc-media://');
    expect(mrkdwn).toContain('[媒体仅在桌面可用]');
  });

  it('chunks long replies under Slack text limits', () => {
    const longMd = `**Report**\n${'B'.repeat(4500)}`;
    const chunks = buildSlackOutboundMessages([{ type: 'markdown', text: longMd }]);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(3800);
    }
  });
});
