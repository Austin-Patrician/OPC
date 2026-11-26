import { describe, expect, it } from 'vitest';
import { parseRichText } from './parseRichText';

describe('parseRichText', () => {
  it('returns a single text segment for plain content', () => {
    expect(parseRichText('今天先做交付物验收')).toEqual([
      { type: 'text', value: '今天先做交付物验收' },
    ]);
  });

  it('isolates mentions and keeps trailing punctuation in the sentence', () => {
    expect(parseRichText('请 @林工 看下，然后 @许工。')).toEqual([
      { type: 'text', value: '请 ' },
      { type: 'mention', value: '@林工' },
      { type: 'text', value: ' 看下，然后 ' },
      { type: 'mention', value: '@许工' },
      { type: 'text', value: '。' },
    ]);
  });

  it('detects only http(s) links and keeps the surrounding text', () => {
    expect(parseRichText('产物见 https://example.com/a?b=1 谢谢')).toEqual([
      { type: 'text', value: '产物见 ' },
      { type: 'link', value: 'https://example.com/a?b=1', href: 'https://example.com/a?b=1' },
      { type: 'text', value: ' 谢谢' },
    ]);
  });

  it('separates emails and file paths cleanly without turning emails into mentions', () => {
    const result = parseRichText('发送给 dev@example.com，附件见 C:\\Users\\demo\\plan.pdf。');
    expect(result).toEqual([
      { type: 'text', value: '发送给 ' },
      { type: 'email', value: 'dev@example.com', email: 'dev@example.com', href: 'mailto:dev@example.com' },
      { type: 'text', value: '，附件见 ' },
      expect.objectContaining({
        type: 'file',
        value: 'C:\\Users\\demo\\plan.pdf',
      }),
      { type: 'text', value: '。' },
    ]);
  });

  it('does not treat other protocols as links', () => {
    expect(parseRichText('javascript:alert(1)')).toEqual([
      { type: 'text', value: 'javascript:alert(1)' },
    ]);
  });

  it('returns an empty list for empty input', () => {
    expect(parseRichText('')).toEqual([]);
  });
});
