import { describe, expect, it } from 'vitest';
import { loadSmokeScript } from './index';

/**
 * Guards the failure mode we actually hit: a template-embedded script that only
 * failed at runtime, inside Electron, after a full build.
 *
 * 第二种失败模式同样致命：脚本引用了**已经被删掉的通道或路由**。它在类型系统之外
 * （纯 JS 模板字符串），编译能过、单测能过，只有真跑起来才会 "Cannot read
 * properties of undefined"。所以这里把"不许出现"的旧名字显式钉住。
 */
describe('smoke script', () => {
  const script = loadSmokeScript();

  it('is syntactically valid JavaScript', () => {
    expect(() => new Function(`return ${script}`)).not.toThrow();
  });

  it('is a self-invoking async function that returns a report', () => {
    expect(script.trimStart().startsWith('(async () =>')).toBe(true);
    expect(script).toContain('executor');
    expect(script).toContain('diagnosticsOk');
  });

  it('only talks to bridges and routes that still exist', () => {
    // 组织架构 / 人才市场 / 项目页在 v2 里整体退场。
    for (const removed of ['opc.org', 'opc.projects', 'listBudgets', "'#/org'", "'#/market'", "'#/projects'"]) {
      expect(script).not.toContain(removed);
    }
    // 现在的入口：执行体名单、Router 会话、能力清单。
    for (const kept of ['opc.workers.list()', 'opc.chat.ensureAssistant()', 'opc.capabilities.list()']) {
      expect(script).toContain(kept);
    }
  });
});
