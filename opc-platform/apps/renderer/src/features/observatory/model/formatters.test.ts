import { describe, expect, it } from 'vitest';
import {
  extractReplyMarkdown,
  formatStepMs,
  isSlowStepMs,
} from './formatters';

describe('formatStepMs', () => {
  it('formats sub-second, seconds, minutes, and hours cleanly', () => {
    expect(formatStepMs(0)).toBe('0ms');
    expect(formatStepMs(240)).toBe('240ms');
    expect(formatStepMs(1200)).toBe('1.2s');
    expect(formatStepMs(33834)).toBe('33.8s');
    expect(formatStepMs(60_000)).toBe('1m');
    expect(formatStepMs(72_000)).toBe('1m 12s');
    expect(formatStepMs(120_000)).toBe('2m');
    expect(formatStepMs(3_900_000)).toBe('1h 05m');
  });

  it('detects slow steps >= 10s', () => {
    expect(isSlowStepMs(undefined)).toBe(false);
    expect(isSlowStepMs(9_999)).toBe(false);
    expect(isSlowStepMs(10_000)).toBe(true);
    expect(isSlowStepMs(33_834)).toBe(true);
  });
});

describe('extractReplyMarkdown', () => {
  it('extracts markdown blocks from reply_to_user Args detail', () => {
    const detail = [
      'Args:',
      JSON.stringify(
        {
          blocks: [
            { type: 'markdown', text: '### 简历翻译完成\n- 已生成 `resume_zh.pdf`' },
          ],
        },
        null,
        2,
      ),
      '',
      'Result:',
      '{"ok":true}',
    ].join('\n');

    expect(extractReplyMarkdown('reply_to_user', detail)).toBe(
      '### 简历翻译完成\n- 已生成 `resume_zh.pdf`',
    );
  });

  it('returns null for other tools or non-json details', () => {
    expect(extractReplyMarkdown('bash', 'Args:\n{"command":"ls"}')).toBeNull();
    expect(extractReplyMarkdown('reply_to_user', 'not json')).toBeNull();
  });
});
