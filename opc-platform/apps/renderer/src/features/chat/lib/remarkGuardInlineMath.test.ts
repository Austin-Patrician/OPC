import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { describe, expect, it, vi } from 'vitest';
import { remarkGuardInlineMath } from './remarkGuardInlineMath';

function renderMarkdown(markdown: string): string {
  return renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm, remarkMath, remarkGuardInlineMath],
        rehypePlugins: [[rehypeKatex, { strict: 'ignore' }]],
      },
      markdown,
    ),
  );
}

describe('remarkGuardInlineMath', () => {
  it('keeps currency and CJK pricing prose as plain text with zero KaTeX warnings', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const pricingProse = [
        '- **价格**：AI Pro 官方 $19.99/月、年付 $199.99；黑五首年 $99.99（-50%，≈$8.33/月）只在媒体和 Deal 站口径一致，最终以账号内结账页为准。省账：月付一年 $239.88 → 常规年付 $199.99 → 黑五首年 $99.99（比月付省 $139.89）。',
        '',
        'Costs $10 to $20 or $19.99/mo vs $199.99/yr, range $10-$20.',
      ].join('\n');

      const html = renderMarkdown(pricingProse);

      expect(warnSpy).not.toHaveBeenCalled();
      expect(html).not.toContain('class="katex');
      expect(html).toContain('$19.99/月、年付 $199.99');
      expect(html).toContain('$99.99（-50%，≈$8.33/月）');
      expect(html).toContain('$239.88 → 常规年付 $199.99 → 黑五首年 $99.99（比月付省 $139.89）');
      expect(html).toContain('Costs $10 to $20 or $19.99/mo vs $199.99/yr, range $10-$20.');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('still renders legitimate single-dollar and double-dollar LaTeX math', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const mathMarkdown = [
        '质能方程 $E = mc^2$ 与复杂度 $O(n \\log n)$，中文标注 $\\text{速度} = \\frac{s}{t}$。',
        '',
        '$$',
        'L = \\frac{1}{2} \\rho v^2 S C_L',
        '$$',
      ].join('\n');

      const html = renderMarkdown(mathMarkdown);

      expect(warnSpy).not.toHaveBeenCalled();
      expect(html).toContain('class="katex"');
      expect(html).toContain('class="katex-display"');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
