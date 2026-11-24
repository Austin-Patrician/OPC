import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownMemoryStore } from './markdownMemoryStore';
import { MemoryReflector, parseReflectionPatch, type TranscriptMessageForReflection } from './memoryReflector';

describe('MemoryReflector', () => {
  let rootDir: string;
  let store: MarkdownMemoryStore;
  let messages: TranscriptMessageForReflection[];

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-reflector-'));
    store = new MarkdownMemoryStore(rootDir);
    store.ensureInitialized();
    messages = [];
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('applies whole-document JSON patches, advances cursor, consumes signals, and writes snapshots', async () => {
    messages.push(
      { id: 'm1', senderId: 'user', text: '我平时主要在 Windows 上用 pnpm 开发', createdAt: 1 },
      { id: 'm2', senderId: 'router', text: '明白，已记住你的开发环境。', createdAt: 2 },
    );

    const reflector = new MemoryReflector({
      store,
      readMessagesSince: (afterId) => {
        if (!afterId) return messages;
        const idx = messages.findIndex((m) => m.id === afterId);
        return idx >= 0 ? messages.slice(idx + 1) : messages;
      },
      complete: async ({ userPrompt }) => {
        // Prompt includes existing files + signals + incremental messages
        expect(userPrompt).toContain('现有 USER.md');
        expect(userPrompt).toContain('用户退回返工');
        return JSON.stringify({
          userSections: {
            工作与本地环境: ['Windows + PowerShell 环境，包管理器使用 pnpm'],
          },
          rulesAdd: ['所有回复先给结论，不写客套废话'],
          playbookUpserts: [
            { section: '数据可视化', entry: '避免：图表遗漏坐标轴单位 → 正确做法：所有图表必须在轴标题标注单位' },
          ],
          topicUpdates: [
            { slug: 'opc-workbench', title: 'OPC 工作台', content: '- 使用 Electron + React 19 + Markdown-First 记忆体系', mode: 'append' },
          ],
          dailyNote: '确定了基于本地 Markdown 的全新记忆工作台方案',
        });
      },
    });

    reflector.recordSignal({
      origin: 'rework',
      text: '图表要标上单位，以后都一样',
      threadId: 'th-1',
    });

    const run = await reflector.reflectNow();
    expect(run.status).toBe('done');
    expect(run.changedFiles).toContain('USER.md');
    expect(run.changedFiles).toContain('RULES.md');
    expect(run.changedFiles).toContain('PLAYBOOK.md');
    expect(run.changedFiles).toContain('topics/opc-workbench.md');

    expect(store.readDoc('USER.md').content).toContain('Windows + PowerShell 环境');
    expect(store.listRules()).toEqual(['所有回复先给结论，不写客套废话']);
    expect(store.readDoc('PLAYBOOK.md').content).toContain('数据可视化');
    expect(store.readState().lastReflectedMessageId).toBe('m2');
    expect(store.readState().pendingSignals).toHaveLength(0);
    expect(store.listSnapshots().length).toBeGreaterThanOrEqual(3);

    // Second manual run with no new messages or signals skips gracefully
    const skipped = await reflector.reflectNow();
    expect(skipped.status).toBe('skipped');
    reflector.dispose();
  });

  it('triggers debounced reflection automatically on failure/recovery signals and batch messages', async () => {
    vi.useFakeTimers();
    try {
      const complete = vi.fn(async () =>
        JSON.stringify({
          playbookUpserts: [
            { section: '端口检查', entry: '避免：未检查端口占用直接起服 → 正确做法：先清理残留进程' },
          ],
        }),
      );

      const reflector = new MemoryReflector({
        store,
        signalDebounceMs: 100,
        messageBatchThreshold: 3,
        idleMs: 500,
        readMessagesSince: () => messages,
        complete,
      });

      reflector.recordSignal({
        origin: 'task_recovery',
        text: '任务重试后通过：首次 EADDRINUSE 端口占用',
      });
      await vi.advanceTimersByTimeAsync(120);

      expect(complete).toHaveBeenCalledTimes(1);
      expect(store.readDoc('PLAYBOOK.md').content).toContain('端口检查');

      // 3rd user message hits batch threshold
      messages.push({ id: 'm10', senderId: 'user', text: '消息', createdAt: 10 });
      reflector.noteUserMessage();
      reflector.noteUserMessage();
      reflector.noteUserMessage();
      await vi.advanceTimersByTimeAsync(10);

      expect(complete).toHaveBeenCalledTimes(2);
      reflector.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('parses fenced JSON defensively and ignores malformed output', () => {
    const parsed = parseReflectionPatch('这里有一些思考...\n```json\n{"rulesAdd": ["测试规则"]}\n```');
    expect(parsed.rulesAdd).toEqual(['测试规则']);
    expect(parseReflectionPatch('not json at all')).toEqual({});
  });
});
