import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MarkdownMemoryStore } from './markdownMemoryStore';
import { MemorySearchIndex } from './memorySearchIndex';

describe('MemorySearchIndex', () => {
  let rootDir: string;
  let store: MarkdownMemoryStore;
  let index: MemorySearchIndex;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-md-index-'));
    store = new MarkdownMemoryStore(rootDir);
    store.ensureInitialized();
    index = new MemorySearchIndex(store);
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('searches Chinese & English content by H2 sections with heading boost', () => {
    store.upsertPlaybookEntry(
      'Windows PowerShell',
      '避免：直接调用 bare pnpm → 正确做法：命令前先拼接 Node 与 corepack PATH',
    );
    store.upsertPlaybookEntry(
      'ESLint 校验',
      '避免：全仓运行 pnpm lint 扫到 dist → 正确做法：显式传入修改目录 pnpm exec eslint',
    );
    store.upsertTopicDoc(
      'arch',
      '桌面端架构',
      '## 进程通信\n- 主进程与渲染进程通过 packages/shared/src/ipc.ts 约定强类型通道。',
    );

    const hits = index.search('Windows 下 pnpm 找不到命令怎么办');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.relPath).toBe('PLAYBOOK.md');
    expect(hits[0]?.sectionTitle).toBe('Windows PowerShell');

    const routerRecall = index.recallForRouter('桌面端 进程通信 ipc pnpm');
    expect(routerRecall.playbook.some((h) => h.sectionTitle === 'Windows PowerShell')).toBe(true);
    expect(routerRecall.snippets.some((h) => h.relPath === 'topics/arch.md')).toBe(true);
  });

  it('detects direct external disk edits via mtimeMs without SQLite sync', () => {
    // Prime cache first
    expect(index.search('obsidian外部编辑')).toEqual([]);

    // Simulate user editing a markdown file directly in VS Code / Obsidian
    const topicPath = path.join(rootDir, 'topics', 'obsidian-sync.md');
    fs.writeFileSync(
      topicPath,
      '# 外部笔记\n\n## 同步测试\n- 用户在 Obsidian 直接修改并加入了火山引擎 API 密钥注意事项。\n',
      'utf8',
    );
    // Bump mtime explicitly so fast filesystems still register a delta
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(topicPath, future, future);

    const found = index.search('Obsidian 火山引擎 API');
    expect(found).toHaveLength(1);
    expect(found[0]?.relPath).toBe('topics/obsidian-sync.md');
    expect(found[0]?.sectionTitle).toBe('同步测试');
  });

  it('resolves memory:<relPath>#<section> references via readByRef', () => {
    store.addRule('回复先给结论');
    store.upsertPlaybookEntry('数据库迁移', '避免：篡改旧迁移 V1..V58 → 正确做法：追加新版本 V59');

    expect(index.readByRef('memory:RULES.md#1')).toBe('RULES.md#1: 回复先给结论');
    const pb = index.readByRef('memory:PLAYBOOK.md#数据库迁移');
    expect(pb).toContain('## 数据库迁移');
    expect(pb).toContain('追加新版本 V59');
  });
});
