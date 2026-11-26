import { describe, expect, it } from 'vitest';
import {
  extractReplyMarkdown,
  formatCostCompact,
  formatDurationCompact,
  formatStepMs,
  formatTokensCompact,
  isSlowStepMs,
  shortModelName,
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

describe('telemetry compact formatters', () => {
  it('promotes large token counts cleanly from k to M and B', () => {
    expect(formatTokensCompact(0)).toBe('0');
    expect(formatTokensCompact(850)).toBe('850');
    expect(formatTokensCompact(12_000)).toBe('12k');
    expect(formatTokensCompact(84_500)).toBe('84.5k');
    expect(formatTokensCompact(325_400)).toBe('325k');
    expect(formatTokensCompact(999_500)).toBe('1M');
    expect(formatTokensCompact(3_025_800)).toBe('3.03M');
    expect(formatTokensCompact(15_400_000)).toBe('15.4M');
    expect(formatTokensCompact(1_250_000_000)).toBe('1.25B');
  });

  it('formats durations compactly across ms, s, m, h, and d', () => {
    expect(formatDurationCompact(0)).toBe('0s');
    expect(formatDurationCompact(420)).toBe('420ms');
    expect(formatDurationCompact(18_400)).toBe('18s');
    expect(formatDurationCompact(180_000)).toBe('3m');
    expect(formatDurationCompact(192_000)).toBe('3m12s');
    expect(formatDurationCompact(3_600_000)).toBe('1h');
    expect(formatDurationCompact(3_900_000)).toBe('1h05m');
    expect(formatDurationCompact(90_000_000)).toBe('1d1h');
    expect(formatDurationCompact(172_800_000)).toBe('2d');
  });

  it('formats model names and USD costs concisely', () => {
    expect(shortModelName('anthropic/claude-sonnet-4-5')).toBe('claude-sonnet-4-5');
    expect(shortModelName('gpt-5')).toBe('gpt-5');
    expect(shortModelName(' ')).toBe('—');
    expect(formatCostCompact(0.0005)).toBe('$0.0005');
    expect(formatCostCompact(0.042)).toBe('$0.042');
    expect(formatCostCompact(1.25)).toBe('$1.25');
  });
});
