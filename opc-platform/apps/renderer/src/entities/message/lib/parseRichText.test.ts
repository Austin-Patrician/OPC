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

  it('does not treat other protocols as links', () => {
    expect(parseRichText('javascript:alert(1)')).toEqual([
      { type: 'text', value: 'javascript:alert(1)' },
    ]);
  });

  it('returns an empty list for empty input', () => {
    expect(parseRichText('')).toEqual([]);
  });
});
