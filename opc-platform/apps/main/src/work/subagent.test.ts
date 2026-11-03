import { describe, expect, it } from 'vitest';
import { buildSubagentPrompt } from './subagent';

/**
 * 子代理的提示词是契约：它只看得到这一段字。
 *
 * 三条硬话必须写在明面上——**不写父目录**、**不派子代理**、**只写结论**。其中第一条
 * 由沙箱兜底（它唯一可写的根是 scratch），第二条由 `investigateTool` 的串行开关兜底；
 * 写在这里是为了让模型第一次就知道了，而不是先撞一次墙。
 */
const base = {
  taskId: 'task-1',
  question: '8081 为什么起不来',
  expects: '一句话结论 + 相关日志行',
  deliverableSpec: 'server.js 监听 8081 并返回 ok',
  workspaceDir: '/tmp/workspace/task-1',
  scratchDir: '/tmp/scratch/task-1/sub-1',
  constraints: ['结论放最前面'],
};

describe('子代理的提示词', () => {
  it('说清它不是来交付的，并且给出去哪儿写结论', () => {
    const prompt = buildSubagentPrompt(base);

    expect(prompt).toContain('你不是来完成父任务的');
    expect(prompt).toContain('要查的问题：8081 为什么起不来');
    expect(prompt).toContain('希望给出的：一句话结论 + 相关日志行');
    expect(prompt).toContain('answer.md');
  });

  it('明确父目录只读、当前目录可写——两个绝对路径都给出来', () => {
    const prompt = buildSubagentPrompt(base);

    expect(prompt).toContain('/tmp/workspace/task-1');
    expect(prompt).toContain('只读');
    expect(prompt).toContain('/tmp/scratch/task-1/sub-1');
  });

  it('继承约束，但继承的不是历史', () => {
    const prompt = buildSubagentPrompt(base);
    expect(prompt).toContain('- 结论放最前面');
    // 父的对话历史一概不给：隔离正是它有价值的原因。
    expect(prompt).not.toContain('父的历史');
  });

  it('不许再往下派：它已经是最里面那一层', () => {
    expect(buildSubagentPrompt(base)).toContain('不要再派子代理');
  });

  it('没有额外要求时不留空行标题', () => {
    const prompt = buildSubagentPrompt({ ...base, expects: '', constraints: [] });
    expect(prompt).not.toContain('希望给出的');
    expect(prompt).not.toContain('必须遵守');
  });
});
