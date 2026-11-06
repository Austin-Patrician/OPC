import { describe, expect, it } from 'vitest';
import type { ChatContentBlock } from '@opc/shared/domain';
import { formatExternalReply } from './routerHost';

describe('formatExternalReply', () => {
  it('flattens Markdown and public media URLs for text-only channels', () => {
    const content: ChatContentBlock[] = [
      { type: 'markdown', text: '## 结论\n增长了 **12%**。' },
      { type: 'image', source: { type: 'url', url: 'https://cdn.example.com/chart.png' }, alt: '趋势图' },
      { type: 'video', source: { type: 'url', url: 'https://cdn.example.com/demo.mp4' }, title: '演示' },
    ];
    expect(formatExternalReply('结果如下', content)).toBe(
      '结果如下\n\n## 结论\n增长了 **12%**。\n\n[趋势图](https://cdn.example.com/chart.png)\n\n[演示](https://cdn.example.com/demo.mp4)',
    );
  });

  it('describes local artifacts without exposing renderer proxy URLs', () => {
    const content: ChatContentBlock[] = [{
      type: 'audio', source: { type: 'artifact', taskId: 'task-1', relPath: 'output/answer.mp3' }, alt: '语音回答',
    }];
    const result = formatExternalReply('已生成语音', content);
    expect(result).toContain('[语音回答] (output/answer.mp3)');
    expect(result).not.toContain('opc-media://');
  });

  it('removes proxy URLs embedded in assistant text or Markdown', () => {
    const result = formatExternalReply('看图 opc-media://asset/secret', [{
      type: 'markdown', text: '![预览](opc-media://asset/other) https://example.com/ok',
    }]);
    expect(result).not.toContain('opc-media://');
    expect(result).toContain('[媒体仅在桌面可用]');
    expect(result).toContain('https://example.com/ok');
  });
});
