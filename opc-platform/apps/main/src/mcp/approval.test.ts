import { describe, expect, it, vi } from 'vitest';
import type { ToolHookCall } from '@earendil-works/pi-durable';
import { approvalHook, driveApproval, registerApprovalBridge, type ApprovalBridge } from './approval';

/**
 * 动作级审批（M3）。
 *
 * 服务器会自己声明 `destructiveHint` / `openWorldHint`——这里是"要不要停一下"的判据。
 * 锁三件事：**没有放行条就拦、有就放行、拦下时必须去问人**。
 *
 * 第三条是最要紧的：模型被拦之后最常见的反应是换个做法继续，而不是回头报告"我被拦了"。
 * 那条话如果只写在工具返回里，你就永远看不到自己被拦住过。
 */
const call = (name: string): ToolHookCall => ({ id: 'c1', name, arguments: {} }) as ToolHookCall;

function bridge(overrides: Partial<ApprovalBridge> = {}) {
  const asked: { taskId: string; tool: string; title: string }[] = [];
  const value: ApprovalBridge = {
    taskId: () => 'task-1',
    hasPermit: () => false,
    ask: (input) => asked.push(input),
    ...overrides,
  };
  const undo = registerApprovalBridge('conv-1', value);
  return { value, asked, undo };
}

describe('拦截', () => {
  it('没有放行条：拦下来，并且**去问人**', () => {
    const { asked, undo } = bridge();
    const hook = approvalHook(new Map([['mcp__fs__write', '[fs] write_file']]))!;
    const result = driveApproval(hook, call('mcp__fs__write'), 'conv-1');

    expect(result?.block).toContain('需要他点头');
    expect(asked).toEqual([{ taskId: 'task-1', tool: 'mcp__fs__write', title: '[fs] write_file' }]);
    undo();
  });

  it('有放行条就放行，不重复问', () => {
    const { asked, undo } = bridge({ hasPermit: () => true });
    const hook = approvalHook(new Map([['mcp__fs__write', '[fs] write_file']]))!;

    expect(driveApproval(hook, call('mcp__fs__write'), 'conv-1')).toBeUndefined();
    expect(asked).toHaveLength(0);
    undo();
  });

  it('不需要审批的工具、不在任务里的会话，都不拦', () => {
    const { undo } = bridge();
    const hook = approvalHook(new Map([['mcp__fs__write', '[fs] write_file']]))!;

    expect(driveApproval(hook, call('mcp__read__search'), 'conv-1')).toBeUndefined();
    expect(driveApproval(hook, call('mcp__fs__write'), 'another-conversation')).toBeUndefined();
    undo();
  });

  it('没有要拦的工具就不装 hook：空表上跑一个每次调用都问的监听没有意义', () => {
    expect(approvalHook(new Map())).toBeNull();
  });

  it('撤销桥之后不再拦：那条会话已经不是这件活了', () => {
    const { undo } = bridge();
    const hook = approvalHook(new Map([['mcp__fs__write', '[fs] write_file']]))!;
    undo();
    expect(driveApproval(hook, call('mcp__fs__write'), 'conv-1')).toBeUndefined();
  });
});

describe('放行条', () => {
  it('是按"哪件活 × 哪个工具"给的', async () => {
    const { TaskRepository } = await import('../data/taskRepository');
    const { ThreadRepository } = await import('../data/threadRepository');
    const { openCompanyDatabase } = await import('../data/companyDatabase');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');

    const dir = mkdtempSync(path.join(tmpdir(), 'opc-permit-'));
    const db = openCompanyDatabase(path.join(dir, 'company.db'));
    const repository = new TaskRepository(db);
    const threads = new ThreadRepository(db);
    const home = threads.createThread({ title: '台', goal: '台' });
    const worker = threads.createWorker({ name: '执行体', threadId: home.id });
    const task = repository.createTask(
      {
        title: 't',
        brief: 'b',
        deliverableSpec: 'd',
        assigneeId: worker.id,
        estTokens: 1,
        acceptanceCommand: [],
        acceptanceTemplate: 'http-ok',
      },
      'tasks/t',
      'task-t',
    );

    repository.grantMcpPermit(task.id, 'mcp__fs__write');
    expect(repository.hasMcpPermit(task.id, 'mcp__fs__write')).toBe(true);
    // 另一件活、另一个工具都不算。
    expect(repository.hasMcpPermit('task-other', 'mcp__fs__write')).toBe(false);
    expect(repository.hasMcpPermit(task.id, 'mcp__fs__delete')).toBe(false);

    // 过期就不算。
    repository.grantMcpPermit(task.id, 'mcp__fs__delete', -1);
    expect(repository.hasMcpPermit(task.id, 'mcp__fs__delete')).toBe(false);

    repository.clearMcpPermits(task.id);
    expect(repository.hasMcpPermit(task.id, 'mcp__fs__write')).toBe(false);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

// `vi` 留着不引警告
void vi;
