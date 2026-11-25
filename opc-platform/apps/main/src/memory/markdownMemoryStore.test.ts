import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MarkdownMemoryStore,
  MAX_RULES,
  MAX_SNAPSHOTS,
  MAX_USER_PROFILE_CHARS,
} from './markdownMemoryStore';
import { MemoryReflector } from './memoryReflector';

describe('MarkdownMemoryStore', () => {
  let rootDir: string;
  let store: MarkdownMemoryStore;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-md-memory-'));
    store = new MarkdownMemoryStore(rootDir);
    store.ensureInitialized();
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('initializes clean slate templates with zero legacy migration', () => {
    const docs = store.listDocs();
    expect(docs.map((d) => d.relPath)).toEqual(['USER.md', 'RULES.md', 'PLAYBOOK.md']);
    expect(store.readDoc('USER.md').content).toContain('## 身份与角色');
    expect(store.readDoc('USER.md').content).toContain('## 工作与本地环境');
    expect(store.readDoc('USER.md').content).toContain('## 沟通与输出习惯');
    expect(store.readDoc('USER.md').content).toContain('## 近期关注');
    expect(store.listRules()).toEqual([]);
  });

  it('rejects path traversal, hidden paths, and non-markdown writes', () => {
    expect(() => store.readDoc('../secret.md')).toThrow();
    expect(() => store.writeDoc('.snapshots/hack.md', 'x')).toThrow();
    expect(() => store.writeDoc('topics/notes.txt', 'x')).toThrow();
    expect(() => store.writeDoc('UNKNOWN.md', 'x')).toThrow();
    expect(() => store.deleteDoc('RULES.md')).toThrow();
  });

  it('enforces MAX_RULES=20, deduplicates, replaces, and removes cleanly', () => {
    for (let i = 1; i <= MAX_RULES; i += 1) {
      const res = store.addRule(`铁律条目 ${i}`);
      expect(res.ok).toBe(true);
    }
    expect(store.listRules()).toHaveLength(MAX_RULES);

    // Duplicate rule does not error and does not add a 21st line
    const dup = store.addRule('铁律条目 1');
    expect(dup.ok).toBe(true);
    if (dup.ok) expect(dup.changed).toBe(false);

    // 21st distinct rule is rejected
    const overflow = store.addRule('第 21 条超限铁律');
    expect(overflow.ok).toBe(false);

    // Replace existing rule succeeds even at capacity
    const replaced = store.addRule('更新后的铁律 2', { replace: '铁律条目 2' });
    expect(replaced.ok).toBe(true);
    expect(store.listRules()).toContain('更新后的铁律 2');
    expect(store.listRules()).not.toContain('铁律条目 2');

    // Remove by memory:RULES.md#1 reference
    const removed = store.removeRule('memory:RULES.md#1');
    expect(removed.ok).toBe(true);
    expect(store.listRules()).toHaveLength(MAX_RULES - 1);
  });

  it('creates automatic snapshots capped at 30 and supports reversible rollback', () => {
    store.writeDoc('PLAYBOOK.md', '# 避坑\n\n## 初始\n- 初始版本\n', { reason: 'seed' });
    for (let i = 1; i <= MAX_SNAPSHOTS + 5; i += 1) {
      store.upsertPlaybookEntry('场景', `避坑条目 ${i}`, `auto-${i}`);
    }
    const snapshots = store.listSnapshots();
    expect(snapshots.length).toBeLessThanOrEqual(MAX_SNAPSHOTS);

    const target = snapshots.at(-1)!;
    const rollback = store.rollbackSnapshot(target.id);
    expect(rollback.ok).toBe(true);
    expect(rollback.relPath).toBe('PLAYBOOK.md');
    expect(store.readDoc('PLAYBOOK.md').content).not.toContain(`避坑条目 ${MAX_SNAPSHOTS + 5}`);
  });

  it('updates USER.md sections while enforcing MAX_USER_PROFILE_CHARS budget', () => {
    store.updateUserSection('工作与本地环境', ['Windows 11 + PowerShell 7', '使用 pnpm']);
    const longFocus = Array.from({ length: 40 }, (_, i) => `正在深入推进第 ${i} 号长期重点工程与多阶段改造细节项目`);
    store.updateUserSection('近期关注', longFocus);
    const content = store.readDoc('USER.md').content;
    expect(content.length).toBeLessThanOrEqual(MAX_USER_PROFILE_CHARS);
    expect(content).toContain('Windows 11 + PowerShell 7');
  });

  it('routes Router remember/forget and renders Router & Worker core blocks', () => {
    const r1 = store.rememberFromRouter('回答一律先给结论，不超过三句', { standing: true });
    expect(r1.ok).toBe(true);

    const r2 = store.rememberFromRouter('避免使用 bash sleep 做定时等待 → 正确做法：使用 schedule 工具', {
      kind: 'workflow',
      subject: '调度习惯',
    });
    expect(r2.ok).toBe(true);

    const r3 = store.rememberFromRouter('核心仓库位于 E:\\code\\opc-platform', { kind: 'fact' });
    expect(r3.ok).toBe(true);

    store.upsertTopicDoc('release', '发布流程', '- 打包前先跑 pnpm typecheck');

    const routerBlock = store.renderRouterStandingBlock({
      tone: 'balanced',
      detail: 'concise',
      instructions: '',
      assistantName: 'Friday',
    });
    expect(routerBlock).toContain('你的名称/自称：Friday');
    expect(routerBlock).toContain('回答一律先给结论，不超过三句');
    expect(routerBlock).toContain('核心仓库位于');
    expect(routerBlock).toContain('topics/release.md');

    const workerBlock = store.renderWorkerCoreBlock();
    expect(workerBlock).toContain('核心仓库位于');
    expect(workerBlock).toContain('[铁律] 回答一律先给结论，不超过三句');

    if (r1.ok) {
      expect(store.forgetByRef(r1.id).ok).toBe(true);
      expect(store.listRules()).toEqual([]);
    }
  });

  it('deduplicates signals in .state.json and tracks reflection cursor', () => {
    const s1 = store.recordSignal({ origin: 'rework', text: '图表必须带单位', threadId: 'th-1' });
    const s2 = store.recordSignal({ origin: 'rework', text: '图表必须带单位', threadId: 'th-1' });
    expect(s1).not.toBeNull();
    expect(s2).toBeNull();
    expect(store.readState().pendingSignals).toHaveLength(1);

    store.consumeSignals([s1!.id]);
    expect(store.readState().pendingSignals).toHaveLength(0);

    store.updateReflectionCursor('msg-99', 123456);
    expect(store.readState().lastReflectedMessageId).toBe('msg-99');
    expect(store.readState().lastReflectedAt).toBe(123456);
  });

  it('resetAfterConversationClear flushes memory when requested and discards pending signals when skipped', async () => {
    store.addRule('回答先给结论', { reason: 'user' });
    store.recordSignal({ origin: 'correction', text: '以后用简洁表格', threadId: 'th-1' });
    store.updateReflectionCursor('msg-50', 100);

    const complete = vi.fn(async () => JSON.stringify({ dailyNote: '记录一条重要偏好' }));
    const reflector = new MemoryReflector({
      store,
      complete,
      readMessagesSince: () => [
        { id: 'msg-51', senderId: 'user', text: '记住以后优先给表格', createdAt: 200 },
      ],
    });

    // When flush = false, skip LLM reflection, drop pending signals, reset cursor, keep RULES.md intact
    await reflector.resetAfterConversationClear({ flush: false });
    expect(complete).not.toHaveBeenCalled();
    expect(store.readState().pendingSignals).toHaveLength(0);
    expect(store.readState().lastReflectedMessageId).toBeNull();
    expect(store.listRules()).toEqual(['回答先给结论']);

    // When flush = true, run reflection first then reset cursor
    store.updateReflectionCursor('msg-60', 300);
    store.recordSignal({ origin: 'correction', text: '图表附单位', threadId: 'th-2' });
    await reflector.resetAfterConversationClear({ flush: true });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(store.readState().pendingSignals).toHaveLength(0);
    expect(store.readState().lastReflectedMessageId).toBeNull();
    expect(store.listRules()).toEqual(['回答先给结论']);

    reflector.dispose();
  });
});
