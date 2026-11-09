import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearServerToolApprovals, readApprovalPolicy, setToolApproval, toolApproval } from './policy';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('MCP 工具审批策略', () => {
  it('工具例外覆盖服务器默认值，并可清除回退', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'opc-mcp-policy-'));
    dirs.push(dir);
    expect(toolApproval(readApprovalPolicy(dir), 'search', 'write', true)).toBe(true);
    setToolApproval(dir, 'search', 'write', false);
    expect(toolApproval(readApprovalPolicy(dir), 'search', 'write', true)).toBe(false);
    setToolApproval(dir, 'search', 'write', null);
    expect(toolApproval(readApprovalPolicy(dir), 'search', 'write', true)).toBe(true);
  });

  it('清除服务器例外后删除本地策略文件', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'opc-mcp-policy-'));
    dirs.push(dir);
    setToolApproval(dir, 'search', 'write', false);
    clearServerToolApprovals(dir, 'search');
    expect(() => readFileSync(path.join(dir, 'mcp-approval.json'))).toThrow();
  });
});
