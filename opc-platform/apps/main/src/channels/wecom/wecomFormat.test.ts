import { describe, expect, it } from 'vitest';
import {
  buildWeComOutboundMessages,
  detectWeComMediaType,
  formatWeComAddress,
  parseWeComAddress,
  splitUtf8Chunks,
  stripWeComAtMention,
} from './wecomFormat';

describe('wecomFormat', () => {
  it('formats and parses DM and group addresses cleanly', () => {
    const dmAddr = formatWeComAddress('p2p', 'zhangsan');
    const groupAddr = formatWeComAddress('group', 'wr_ops_123');
    expect(dmAddr).toBe('wecom:dm:zhangsan');
    expect(groupAddr).toBe('wecom:group:wr_ops_123');
    expect(parseWeComAddress(dmAddr)).toEqual({ chatKind: 'p2p', targetId: 'zhangsan' });
    expect(parseWeComAddress(groupAddr)).toEqual({ chatKind: 'group', targetId: 'wr_ops_123' });
    expect(parseWeComAddress('wecom:dm:')).toBeNull();
    expect(parseWeComAddress('slack:channel:C123')).toBeNull();
  });

  it('strips leading @bot mentions while preserving multiline body', () => {
    expect(stripWeComAtMention('@Buddy\u2005请帮我看下\n第二行日志')).toBe('请帮我看下\n第二行日志');
    expect(stripWeComAtMention('@助手 @研发助手  你好')).toBe('你好');
  });

  it('renders rich blocks, strips opc-media URLs, and chunks by UTF-8 bytes', () => {
    const chunks = buildWeComOutboundMessages([
      { type: 'markdown', text: '**完成** ![图](opc-media://local/a.png)' },
      { type: 'file', title: '报告', source: { type: 'artifact', taskId: 't1', relPath: 'output/report.pdf' } },
    ]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('**完成**');
    expect(chunks[0]).not.toContain('opc-media://');
    expect(chunks[0]).toContain('output/report.pdf');

    const longChinese = '你好企业微信'.repeat(400); // ~7200 bytes
    const split = splitUtf8Chunks(longChinese, 3800);
    expect(split.length).toBeGreaterThanOrEqual(2);
    for (const part of split) {
      expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(3800);
    }
    expect(split.join('')).toBe(longChinese);
  });

  it('detects image vs file vs too_large limits', () => {
    expect(detectWeComMediaType('/tmp/chart.PNG', 500_000)).toBe('image');
    expect(detectWeComMediaType('/tmp/huge.png', 11 * 1024 * 1024)).toBe('file');
    expect(detectWeComMediaType('/tmp/report.pdf', 5 * 1024 * 1024)).toBe('file');
    expect(detectWeComMediaType('/tmp/archive.zip', 21 * 1024 * 1024)).toBe('too_large');
  });
});
