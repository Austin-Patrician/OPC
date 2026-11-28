import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatUrlChip } from './ChatEntityChips';

const renderChip = (element: ReactElement) => renderToStaticMarkup(element);

describe('ChatUrlChip', () => {
  it('renders autolink URL with site favicon and omits trailing copy button and arrow icon', () => {
    const html = renderChip(<ChatUrlChip href="https://github.com/org/repo/issues/1" />);

    expect(html).toContain('<a ');
    expect(html).toContain('href="https://github.com/org/repo/issues/1"');
    expect(html).toContain('github.com');
    expect(html).toContain('/org/repo/issues/1');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('lucide-arrow-up-right');
    expect(html.match(/<svg/g)).toHaveLength(1);
  });

  it('renders custom link text cleanly without trailing buttons or arrows', () => {
    const html = renderChip(
      <ChatUrlChip href="https://feishu.cn/docx/abc">飞书文档</ChatUrlChip>,
    );

    expect(html).toContain('<a ');
    expect(html).toContain('飞书文档');
    expect(html).toContain('<img ');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('lucide-arrow-up-right');
    expect(html).not.toContain('<svg');
  });
});
