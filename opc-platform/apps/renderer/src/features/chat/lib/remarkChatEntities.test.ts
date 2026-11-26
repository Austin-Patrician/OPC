import { describe, expect, it } from 'vitest';
import {
  decodeFileHref,
  remarkChatEntities,
  transformMarkdownUrl,
} from './remarkChatEntities';

describe('remarkChatEntities', () => {
  it('allows http(s), mailto, file, and opc-file hrefs while blocking unsafe protocols and image file paths', () => {
    expect(transformMarkdownUrl('https://example.com', 'src')).toBe('https://example.com');
    expect(transformMarkdownUrl('mailto:a@b.com', 'href')).toBe('mailto:a@b.com');
    expect(transformMarkdownUrl('file:///C:/a.txt', 'href')).toBe('file:///C:/a.txt');
    expect(transformMarkdownUrl('file:///C:/a.png', 'src')).toBe('');
    expect(transformMarkdownUrl('opc-file://local?path=a', 'href')).toBe('opc-file://local?path=a');
    expect(transformMarkdownUrl('opc-file://local?path=a', 'src')).toBe('');
    expect(transformMarkdownUrl('javascript:alert(1)', 'href')).toBe('');
  });

  it('rewrites plain MDAST text links/emails/paths and marks [!WARNING] blockquotes as callouts', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: '请联系 test@example.com 并检查 ./outputs/report.xlsx。' },
          ],
        },
        {
          type: 'blockquote',
          children: [
            {
              type: 'paragraph',
              children: [{ type: 'text', value: '[!WARNING]\n执行前请备份文件。' }],
            },
          ],
        },
      ],
    };

    remarkChatEntities()(tree);

    const paraChildren = tree.children[0]!.children as {
      type: string;
      value?: string;
      url?: string;
    }[];
    expect(paraChildren.map((n) => n.type)).toEqual([
      'text',
      'link',
      'text',
      'link',
      'text',
    ]);
    expect(paraChildren[1]?.url).toBe('mailto:test@example.com');
    expect(decodeFileHref(paraChildren[3]?.url)).toBe('./outputs/report.xlsx');

    const quote = tree.children[1] as {
      data?: { hProperties?: Record<string, unknown> };
      children: { children: { value: string }[] }[];
    };
    expect(quote.data?.hProperties?.['data-callout']).toBe('warning');
    expect(quote.children[0]?.children[0]?.value).toBe('执行前请备份文件。');
  });
});
