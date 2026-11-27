import { describe, expect, it } from 'vitest';
import {
  buildTelegramOutboundMessages,
  detectTelegramMediaMethod,
  escapeTelegramHtml,
  formatTelegramAddress,
  hasTelegramBotMention,
  markdownToTelegramHtml,
  parseTelegramAddress,
  splitMarkdownChunks,
  stripTelegramBotMention,
} from './telegramFormat';

describe('telegramFormat', () => {
  it('formats and parses chat and forum topic addresses', () => {
    const dmAddr = formatTelegramAddress('10086');
    const topicAddr = formatTelegramAddress('-1001234567890', 42);
    expect(dmAddr).toBe('telegram:chat:10086');
    expect(topicAddr).toBe('telegram:chat:-1001234567890:topic:42');
    expect(parseTelegramAddress(dmAddr)).toEqual({ chatId: '10086' });
    expect(parseTelegramAddress(topicAddr)).toEqual({ chatId: '-1001234567890', topicId: 42 });
    expect(parseTelegramAddress('feishu:chat:oc_1')).toBeNull();
    expect(parseTelegramAddress('telegram:chat:abc')).toBeNull();
  });

  it('detects mentions and strips @bot / /start cleanly', () => {
    expect(
      hasTelegramBotMention('@MyBuddyBot hello', [{ type: 'mention', offset: 0, length: 11 }], 'mybuddybot'),
    ).toBe(true);
    expect(
      hasTelegramBotMention('/ask@MyBuddyBot logs', [{ type: 'bot_command', offset: 0, length: 15 }], 'mybuddybot'),
    ).toBe(true);
    expect(hasTelegramBotMention('@otherbot hello', undefined, 'mybuddybot')).toBe(false);

    expect(stripTelegramBotMention('/start@MyBuddyBot', 'mybuddybot')).toBe('你好');
    expect(stripTelegramBotMention('/ask@MyBuddyBot 查一下\n两行内容', 'mybuddybot')).toBe('/ask 查一下\n两行内容');
  });

  it('converts markdown to safe Telegram HTML without breaking code blocks or URLs', () => {
    const html = markdownToTelegramHtml(
      [
        '# 标题',
        '**加粗** ~~删除~~ [文档_链接](https://example.com/a_b?x=1&y=2)',
        '> 引用 <script>alert(1)</script>',
        '```ts\nconst x = 1 < 2;\n```',
      ].join('\n'),
    );
    expect(html).toContain('<b>标题</b>');
    expect(html).toContain('<b>加粗</b> <s>删除</s> <a href="https://example.com/a_b?x=1&amp;y=2">文档_链接</a>');
    expect(html).toContain('<blockquote>引用 &lt;script&gt;alert(1)&lt;/script&gt;</blockquote>');
    expect(html).toContain('<pre><code class="language-ts">const x = 1 &lt; 2;</code></pre>');
    expect(escapeTelegramHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  it('chunks long markdown before HTML conversion and strips opc-media URLs', () => {
    const chunks = splitMarkdownChunks('第一段\n\n'.repeat(1200), 3800);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(3800);
    }

    const outbound = buildTelegramOutboundMessages([
      { type: 'markdown', text: '结论见图 ![图](opc-media://local/x.png)' },
      { type: 'file', title: '报告', source: { type: 'artifact', taskId: 't1', relPath: 'output/a.pdf' } },
    ]);
    expect(outbound).toHaveLength(1);
    expect(outbound[0]?.html).not.toContain('opc-media://');
    expect(outbound[0]?.html).toContain('<code>output/a.pdf</code>');
  });

  it('maps attachment types and enforces Telegram size limits', () => {
    expect(detectTelegramMediaMethod('chart.png', 2 * 1024 * 1024)).toBe('sendPhoto');
    expect(detectTelegramMediaMethod('huge.png', 11 * 1024 * 1024)).toBe('sendDocument');
    expect(detectTelegramMediaMethod('voice.mp3', 1024)).toBe('sendAudio');
    expect(detectTelegramMediaMethod('clip.mp4', 1024)).toBe('sendVideo');
    expect(detectTelegramMediaMethod('archive.zip', 51 * 1024 * 1024)).toBe('too_large');
  });
});
