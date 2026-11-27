import type { ContextView, EntryId } from '@earendil-works/pi-durable';
import type { CompactionSettings, ProviderConfig } from '@opc/shared/domain';
import { describe, expect, it } from 'vitest';
import {
  buildCrossTurnImageEvictionEdits,
  buildWorkerCompactionSettings,
  capWorkerThinkingLevel,
  createWorkerContextHygieneExtension,
  estimateActiveContextTokens,
  pruneToolImagesInMessages,
  type ContextMessage,
} from './contextHygiene';

function assistantToolCall(id: string, path: string): ContextMessage {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name: 'read', arguments: { path } }],
    api: 'openai-completions',
    provider: 'p',
    model: 'm',
    usage: {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
    timestamp: 1,
  };
}

function toolResultWithImage(toolCallId: string, base64Len = 100_000): ContextMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName: 'read',
    content: [{ type: 'image', data: 'a'.repeat(base64Len), mimeType: 'image/png' }],
    isError: false,
    timestamp: 2,
  };
}

function userWithImage(base64Len = 100_000): ContextMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text: '看看这张参考图' },
      { type: 'image', data: 'u'.repeat(base64Len), mimeType: 'image/png' },
    ],
    timestamp: 0,
  };
}

describe('worker contextHygiene', () => {
  it('pruneToolImagesInMessages 在图片数未超过阈值且总字节满足预算时原样返回 undefined', () => {
    const messages: ContextMessage[] = [
      assistantToolCall('c1', 'output/p1.png'),
      toolResultWithImage('c1', 100_000),
      assistantToolCall('c2', 'output/p2.png'),
      toolResultWithImage('c2', 100_000),
    ];

    expect(pruneToolImagesInMessages(messages)).toBeUndefined();
    // 原消息内容未被原地修改
    expect((messages[1] as Extract<ContextMessage, { role: 'toolResult' }>).content[0]?.type).toBe('image');
  });

  it('pruneToolImagesInMessages 超过 2 张时仅保留最新 2 张并卸载旧图，绝不触碰 user 消息附件图', () => {
    const messages: ContextMessage[] = [
      userWithImage(250_000),
      assistantToolCall('c1', 'output/p1.png'),
      toolResultWithImage('c1', 120_000),
      assistantToolCall('c2', 'output/p2.png'),
      toolResultWithImage('c2', 120_000),
      assistantToolCall('c3', 'output/p3.png'),
      toolResultWithImage('c3', 120_000),
    ];

    const pruned = pruneToolImagesInMessages(messages);
    expect(pruned).toBeDefined();
    // user 附件图完整保留
    expect((pruned![0] as Extract<ContextMessage, { role: 'user' }>).content[1]).toMatchObject({
      type: 'image',
    });
    // 最早的 toolResult c1 被替换为带路径提示的占位文本
    const c1Content = (pruned![2] as Extract<ContextMessage, { role: 'toolResult' }>).content;
    expect(c1Content[0]).toMatchObject({ type: 'text' });
    expect((c1Content[0] as { text: string }).text).toContain('output/p1.png');
    expect((c1Content[0] as { text: string }).text).toContain('重新 read');
    // 最新 2 张 c2, c3 保留
    expect((pruned![4] as Extract<ContextMessage, { role: 'toolResult' }>).content[0]?.type).toBe('image');
    expect((pruned![6] as Extract<ContextMessage, { role: 'toolResult' }>).content[0]?.type).toBe('image');
  });

  it('pruneToolImagesInMessages 在第 2 新图超出现有字节预算时仅保留最新 1 张大图', () => {
    const messages: ContextMessage[] = [
      assistantToolCall('c1', 'output/p1.png'),
      toolResultWithImage('c1', 500_000),
      assistantToolCall('c2', 'output/p2.png'),
      toolResultWithImage('c2', 500_000),
    ];

    const pruned = pruneToolImagesInMessages(messages);
    expect(pruned).toBeDefined();
    expect((pruned![1] as Extract<ContextMessage, { role: 'toolResult' }>).content[0]?.type).toBe('text');
    expect((pruned![3] as Extract<ContextMessage, { role: 'toolResult' }>).content[0]?.type).toBe('image');
  });

  it('createWorkerContextHygieneExtension 通过 beforeRequest hook 应用裁剪', async () => {
    const ext = createWorkerContextHygieneExtension({ maxImages: 1 });
    const hookDef = ext.hooks?.[0] as {
      handlers: { beforeRequest: (req: { messages: ContextMessage[] }) => { messages: ContextMessage[] } | undefined };
    };
    const messages: ContextMessage[] = [
      assistantToolCall('c1', 'output/p1.png'),
      toolResultWithImage('c1', 50_000),
      assistantToolCall('c2', 'output/p2.png'),
      toolResultWithImage('c2', 50_000),
    ];

    const res = hookDef.handlers.beforeRequest({ messages });
    expect(res?.messages).toBeDefined();
    expect((res!.messages[1] as Extract<ContextMessage, { role: 'toolResult' }>).content[0]?.type).toBe('text');
    expect((res!.messages[3] as Extract<ContextMessage, { role: 'toolResult' }>).content[0]?.type).toBe('image');
  });

  it('buildCrossTurnImageEvictionEdits 按 contributions 识别并卸载上一轮工具图片，跳过已卸载条目', () => {
    const call1 = assistantToolCall('c1', 'output/preview/page_1.png');
    const tr1 = toolResultWithImage('c1', 80_000);
    const alreadyReplaced: ContextMessage = {
      role: 'toolResult',
      toolCallId: 'c0',
      toolName: 'read',
      content: [{ type: 'text', text: '[上一轮任务已查看的图片已卸载]' }],
      isError: false,
      timestamp: 1,
    };

    const view: ContextView = {
      head: undefined,
      entries: [
        // 原始 entry.model 里仍带着 image，但 contributions[0] 已被旧 ContextEdit 替换成纯文本
        { id: 10 as EntryId, conversationId: 1 as never, kind: 'pi.tool-result', model: [tr1] },
        { id: 11 as EntryId, conversationId: 1 as never, kind: 'pi.assistant', model: [call1] },
        { id: 12 as EntryId, conversationId: 1 as never, kind: 'pi.tool-result', model: [tr1] },
      ],
      contributions: [[alreadyReplaced], [call1], [tr1]],
      messages: [alreadyReplaced, call1, tr1],
    };

    const edits = buildCrossTurnImageEvictionEdits(view);
    expect(edits).toHaveLength(1);
    expect(edits[0]?.target).toBe(12);
    expect(edits[0]?.action).toBe('replace');
    if (edits[0]?.action === 'replace') {
      const replaced = edits[0].messages[0] as Extract<ContextMessage, { role: 'toolResult' }>;
      expect(replaced.toolCallId).toBe('c1');
      expect(replaced.content[0]).toMatchObject({ type: 'text' });
      expect((replaced.content[0] as { text: string }).text).toContain('output/preview/page_1.png');
    }
  });

  it('estimateActiveContextTokens 结合最近 usage 与后续图片固定估算 token，不被 base64 字符数放大', () => {
    const view: ContextView = {
      head: undefined,
      entries: [],
      contributions: [],
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.png' } }],
          api: 'openai-completions',
          provider: 'p',
          model: 'm',
          usage: {
            input: 30_000,
            cacheRead: 10_000,
            output: 500,
            cacheWrite: 0,
            totalTokens: 40_500,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'toolUse',
          timestamp: 1,
        },
        toolResultWithImage('c1', 1_200_000),
      ],
    };

    const tokens = estimateActiveContextTokens(view);
    // 40500 + 24 + 1600 = 42124，而不会错误算成 40500 + 400000
    expect(tokens).toBeGreaterThan(40_500);
    expect(tokens).toBeLessThan(45_000);
  });

  it('buildWorkerCompactionSettings 为 1M 窗口模型计算 ~90K 软压缩覆盖且不改 reserveTokens', () => {
    const base: CompactionSettings = {
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
      backgroundTokens: 32_768,
    };
    const providers: ProviderConfig[] = [
      {
        id: 'relay',
        name: 'Relay',
        baseUrl: 'https://example.com',
        api: 'openai-completions',
        isCustom: true,
        hasKey: true,
        updatedAt: 0,
        models: [
          { id: 'deepseek-v4.1-flash', name: 'DS', capability: 'chat', contextWindow: 1_000_000 },
          { id: 'small-32k', name: 'Small', capability: 'chat', contextWindow: 32_768 },
        ],
      },
    ];

    const result = buildWorkerCompactionSettings(base, providers);
    expect(result.reserveTokens).toBe(16_384);
    expect(result.modelOverrides?.['relay/small-32k']).toBeUndefined();

    const override = result.modelOverrides?.['relay/deepseek-v4.1-flash'];
    expect(override).toBeDefined();
    expect(override?.reserveTokens).toBeUndefined();
    const effectiveBackgroundTrigger = 1_000_000 - base.reserveTokens - (override?.backgroundTokens ?? 0);
    expect(effectiveBackgroundTrigger).toBe(90_000);
  });

  it('buildWorkerCompactionSettings 在禁用压缩或 backgroundTokens=0 时不生成覆盖', () => {
    const providers: ProviderConfig[] = [
      {
        id: 'relay',
        name: 'Relay',
        baseUrl: 'https://example.com',
        api: 'openai-completions',
        isCustom: true,
        hasKey: true,
        updatedAt: 0,
        models: [{ id: 'big', name: 'Big', capability: 'chat', contextWindow: 1_000_000 }],
      },
    ];

    expect(
      buildWorkerCompactionSettings(
        { enabled: false, reserveTokens: 16_384, keepRecentTokens: 20_000, backgroundTokens: 32_768 },
        providers,
      ).modelOverrides,
    ).toBeUndefined();
    expect(
      buildWorkerCompactionSettings(
        { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000, backgroundTokens: 0 },
        providers,
      ).modelOverrides,
    ).toBeUndefined();
  });

  it('capWorkerThinkingLevel 将 high/xhigh/max 限制为 medium，保留 low/minimal/off 并支持 uncap', () => {
    expect(capWorkerThinkingLevel('high')).toBe('medium');
    expect(capWorkerThinkingLevel('xhigh')).toBe('medium');
    expect(capWorkerThinkingLevel('max')).toBe('medium');
    expect(capWorkerThinkingLevel('medium')).toBe('medium');
    expect(capWorkerThinkingLevel('low')).toBe('low');
    expect(capWorkerThinkingLevel('minimal')).toBe('minimal');
    expect(capWorkerThinkingLevel('off')).toBe('off');
    expect(capWorkerThinkingLevel('high', { uncap: true })).toBe('high');
  });
});
