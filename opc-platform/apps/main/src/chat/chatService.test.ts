import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openCompanyDatabase } from '../data/companyDatabase';
import { ChatService, ROUTER_ID } from './chatService';

/**
 * 聊天窗口里对面那个人是 Router，不是某个执行体。
 *
 * 这是 Super-agent 双层架构的第一条（docs/v2/04-superagent-check.md §1）：Router
 * 承接人类交互与分派，Worker 在隔离的上下文里干活、不直接对人说话。压扁这一层
 * 就是 v1 那个「单会话阻塞」的问题。
 */
describe('ChatService：Router 是聊天的对面', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('没有执行体也能开出一条会话——Router 常驻，不需要谁来当门面', () => {
    const chat = new ChatService({ agents: [], conversations: [] });
    const id = chat.ensureAssistant();
    const conversation = chat.getSnapshot().conversations.find((item) => item.id === id)!;

    expect(conversation.kind).toBe('dm');
    expect(conversation.memberIds).toEqual([ROUTER_ID]);
  });

  it('你说的话变成一条 Trigger，聊天本身不生成回复', async () => {
    // 故意留一个执行体在快照里：他要是不该被叫来回答，留着也不会被叫。
    const chat = new ChatService({ agents: [], conversations: [] });
    const triggers: { conversationId: string; text: string }[] = [];
    chat.onUserMessage = (input) => triggers.push(input);

    const id = chat.ensureAssistant();
    chat.sendMessage({ conversationId: id, text: '上次那个报表做完了吗' });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(triggers).toEqual([{ conversationId: id, text: '上次那个报表做完了吗' }]);
    const conversation = chat.getSnapshot().conversations.find((item) => item.id === id)!;
    // 只有你那一条。回复要等 Router 决定，不是这里编出来的。
    expect(conversation.messages).toHaveLength(1);
    expect(conversation.messages[0]!.senderId).toBe('user');
  });

  it('为当前会话维护助手阶段，并在完成后短暂回到在线', async () => {
    const chat = new ChatService({ agents: [], conversations: [] });
    const id = chat.ensureAssistant();

    chat.sendMessage({ conversationId: id, text: '生成一张图片' });
    expect(chat.getActivity(id)?.phase).toBe('delivered');
    chat.setActivity(id, 'thinking');
    chat.setActivity(id, 'delegating');
    chat.setActivity(id, 'working');
    chat.setActivity(id, 'organizing');
    chat.setActivity(id, 'typing');
    chat.completeActivity(id);
    expect(chat.getActivity(id)?.phase).toBe('completed');

    await vi.advanceTimersByTimeAsync(1_800);
    expect(chat.getActivity(id)?.phase).toBe('idle');
  });

  it('新一轮消息会使旧的完成回调失效', () => {
    const chat = new ChatService({ agents: [], conversations: [] });
    const id = chat.ensureAssistant();
    const first = chat.beginActivity(id)!;
    chat.completeActivity(id, first);
    const second = chat.beginActivity(id)!;

    expect(chat.completeActivity(id, first)).toBe(false);
    expect(chat.getActivity(id)?.phase).toBe('delivered');
    expect(second).toBeGreaterThan(first);
  });

  it('Router 说话走唯一的出口，署名是它自己', () => {
    const chat = new ChatService({ agents: [], conversations: [] });
    const id = chat.ensureAssistant();

    chat.appendRouterMessage(id, '三条线都在跑，最短的那条十分钟内有结果。');

    const conversation = chat.getSnapshot().conversations.find((item) => item.id === id)!;
    const reply = conversation.messages.at(-1)!;
    expect(reply.senderId).toBe(ROUTER_ID);
    expect(reply.senderName).toBe('助手');
  });

  it('Router 回复按顺序保留结构化媒体内容块', () => {
    const chat = new ChatService({ agents: [], conversations: [] });
    const id = chat.ensureAssistant();
    const content = [
      { type: 'markdown' as const, text: '结果如下' },
      { type: 'image' as const, source: { type: 'url' as const, url: 'https://example.com/chart.png' }, alt: '图表' },
    ];

    chat.appendRouterMessage(id, '结果如下', content);

    expect(chat.readTranscript(id).at(-1)?.content).toEqual(content);
  });

  it('工具审批处理后移除整条审批消息，并更新会话预览', () => {
    const chat = new ChatService({ agents: [], conversations: [] });
    const id = chat.ensureAssistant();

    chat.appendRouterMessage(id, '前一条结论');
    chat.appendApprovalCard(id, {
      type: 'approval',
      reportId: 'report-1',
      threadId: 'thread-1',
      taskId: 'task-1',
      tool: 'mcp__fs__write',
      title: '需要允许写入文件',
      body: '请确认是否继续',
      state: 'pending',
    });

    chat.updateApprovalCard('report-1', 'allowed');

    const conversation = chat.getSnapshot().conversations.find((item) => item.id === id)!;
    expect(conversation.messages).toHaveLength(1);
    expect(conversation.messages[0]?.text).toBe('前一条结论');
    expect(conversation.lastMessage).toBe('助手: 前一条结论');
  });

  it('Ontology 命令审批卡处理后从聊天中移除', () => {
    const chat = new ChatService({ agents: [], conversations: [] });
    const id = chat.ensureAssistant();
    chat.appendOntologyApprovalCard(id, {
      type: 'ontologyApproval',
      commandId: 'command-1',
      action: 'delegate_task',
      objectType: 'Task',
      title: '助手请求执行一项操作',
      body: '请确认',
      state: 'pending',
    });
    chat.updateOntologyApprovalCard('command-1', 'approved');
    expect(chat.readTranscript(id)).toEqual([]);
  });

  it('混合消息只移除审批块，保留其他内容', () => {
    const chat = new ChatService({ agents: [], conversations: [] });
    const id = chat.ensureAssistant();

    chat.appendRouterMessage(id, '结果和权限请求', [
      { type: 'markdown', text: '结果已经准备好' },
      {
        type: 'approval',
        reportId: 'report-2',
        threadId: 'thread-2',
        taskId: 'task-2',
        tool: 'mcp__fs__write',
        title: '需要允许写入文件',
        body: '请确认是否继续',
        state: 'pending',
      },
    ]);

    chat.updateApprovalCard('report-2', 'denied');

    const message = chat.getSnapshot().conversations.find((item) => item.id === id)!.messages[0]!;
    expect(message.content).toEqual([{ type: 'markdown', text: '结果已经准备好' }]);
  });

  it('工作流确认处理后也移除卡片，而不是留下已处理状态', () => {
    const chat = new ChatService({ agents: [], conversations: [] });
    const id = chat.ensureAssistant();
    chat.appendWorkflowCard(id, {
      type: 'workflow',
      reportId: 'report-workflow-1',
      threadId: 'thread-workflow-1',
      taskId: 'task-workflow-1',
      kind: 'report',
      title: '任务需要确认',
      body: '请确认结果',
      state: 'pending',
    });

    chat.updateWorkflowCard('report-workflow-1', 'resolved');

    const conversation = chat.getSnapshot().conversations.find((item) => item.id === id)!;
    expect(conversation.messages).toEqual([]);
    expect(conversation.lastMessage).toBe('还没有对话');
  });

  it('工作流卡移除后切换页面重载不会再次出现等待确认', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'opc-chat-workflow-'));
    const db = openCompanyDatabase(path.join(dir, 'company.db'));
    try {
      const chat = new ChatService({ agents: [], conversations: [], db });
      const id = chat.ensureAssistant();
      chat.appendWorkflowCard(id, {
        type: 'workflow',
        reportId: 'report-workflow-2',
        threadId: 'thread-workflow-2',
        kind: 'report',
        title: '任务需要确认',
        body: '请确认结果',
        state: 'pending',
      });
      chat.updateWorkflowCard('report-workflow-2', 'resolved');

      const reloaded = new ChatService({ agents: [], conversations: [], db });
      const conversation = reloaded.getSnapshot().conversations.find((item) => item.id === id)!;
      expect(conversation.messages).toEqual([]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('审批消息删除后不会在数据库重载时复现', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'opc-chat-approval-'));
    const db = openCompanyDatabase(path.join(dir, 'company.db'));
    try {
      const chat = new ChatService({ agents: [], conversations: [], db });
      const id = chat.ensureAssistant();
      chat.appendApprovalCard(id, {
        type: 'approval',
        reportId: 'report-3',
        threadId: 'thread-3',
        taskId: 'task-3',
        tool: 'mcp__fs__write',
        title: '需要允许写入文件',
        body: '请确认是否继续',
        state: 'pending',
      });
      chat.updateApprovalCard('report-3', 'allowed');

      const reloaded = new ChatService({ agents: [], conversations: [], db });
      const conversation = reloaded.getSnapshot().conversations.find((item) => item.id === id)!;
      expect(conversation.messages).toEqual([]);
      expect(conversation.lastMessage).toBe('还没有对话');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('任务进度不会写入对话消息流', () => {
    const chat = new ChatService({ agents: [], conversations: [] });
    const id = chat.ensureAssistant();
    chat.upsertTaskCard({ id: 'task-1' } as never);
    expect(chat.readTranscript(id)).toEqual([]);
  });

  it('Router 流式消息只在完成后落库，清理时不留下半截正文', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'opc-chat-stream-'));
    const db = openCompanyDatabase(path.join(dir, 'company.db'));
    try {
      const chat = new ChatService({ agents: [], conversations: [], db });
      const id = chat.ensureAssistant();
      const messageId = chat.beginRouterStream(id)!;
      chat.updateRouterStream(id, messageId, '半截');
      const during = chat.getSnapshot().conversations.find((item) => item.id === id)!;
      expect(during.messages[0]?.streaming).toBe(true);
      expect((db.prepare('SELECT COUNT(*) AS count FROM message').get() as { count: number }).count).toBe(0);

      chat.finishRouterStream(id, messageId, '完整答复');
      const after = chat.getSnapshot().conversations.find((item) => item.id === id)!;
      expect(after.messages[0]?.text).toBe('完整答复');
      expect(after.messages[0]?.streaming).toBe(false);
      expect((db.prepare('SELECT COUNT(*) AS count FROM message').get() as { count: number }).count).toBe(1);

      const second = chat.beginRouterStream(id)!;
      chat.updateRouterStream(id, second, '会被清除');
      chat.clearRouterStream(id);
      expect(chat.getSnapshot().conversations.find((item) => item.id === id)!.messages.map((m) => m.text)).toEqual(['完整答复']);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('初始旧会话会隐藏历史任务卡并从最新可见消息生成预览', () => {
    const chat = new ChatService({ agents: [], conversations: [{
      id: 'legacy', title: '旧会话', kind: 'dm', memberIds: [ROUTER_ID],
      lastMessage: '旧任务卡', timestamp: '08:00',
      messages: [
        { id: 'card', kind: 'task', senderId: 'worker', senderName: '执行体', timestamp: '08:00', task: {} } as never,
        { id: 'reply', kind: 'text', senderId: ROUTER_ID, senderName: '助手', timestamp: '08:01', text: '已经完成' },
      ],
    }] });
    const conversation = chat.getSnapshot().conversations[0]!;
    expect(conversation.messages.map((message) => message.id)).toEqual(['reply']);
    expect(conversation.lastMessage).toBe('助手: 已经完成');
  });

  it('再点一次不会开出第二条会话', () => {
    const chat = new ChatService({ agents: [], conversations: [] });
    expect(chat.ensureAssistant()).toBe(chat.ensureAssistant());
    expect(chat.getSnapshot().conversations).toHaveLength(1);
  });

  it('老数据里和执行体的旧私聊也不会有人替它回答', async () => {
    // v1 的库可能还留着"你 ↔ 某个员工"的会话。那条路上曾经有一个执行体用它的
    // 岗位人设直接回话（§2.2 明令禁止）。现在不管话落在哪条会话上，都只是给 Router
    // 的一条 Trigger。
    const chat = new ChatService({
      agents: [{ id: 'worker-1', name: '李雷', role: '工程师' } as never],
      conversations: [
        {
          id: 'dm-worker-1',
          title: '李雷',
          kind: 'dm',
          memberIds: ['worker-1'],
          messages: [],
          lastMessage: '',
          timestamp: '00:00',
        },
      ],
    });
    const triggers: { conversationId: string; text: string }[] = [];
    chat.onUserMessage = (input) => triggers.push(input);

    chat.sendMessage({ conversationId: 'dm-worker-1', text: '那个报表呢' });
    await vi.advanceTimersByTimeAsync(2_000);

    const conversation = chat.getSnapshot().conversations[0]!;
    expect(conversation.messages).toHaveLength(1);
    expect(conversation.messages[0]!.senderId).toBe('user');
    expect(triggers).toEqual([{ conversationId: 'dm-worker-1', text: '那个报表呢' }]);
  });
});
