import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '@opc/shared/domain';
import { ChatService, ROUTER_ID } from './chatService';

/**
 * The chat snapshot is a projection of the org, so it has to be refreshed when the
 * org changes. It used to be built once at launch: a newly hired employee never
 * joined their department group, and a transfer left them in the old one, until the
 * app was restarted. `syncOrg` is what the IPC layer calls after every org mutation.
 */

function agent(id: string, departmentId: string, name = id): Agent {
  return {
    id,
    name,
    role: '工程师',
    level: 'P5',
    departmentId,
    model: '',
    status: 'online',
    skills: [],
    briefMd: '',
  };
}

function department(id: string, name = id) {
  return { id, name, code: '', color: '#000000', description: '', leadAgentId: '', groupConversationId: '' };
}

function service() {
  return new ChatService({
    agents: [agent('agent-a', 'dept-1', '甲')],
    departments: [department('dept-1', '工程部')],
    conversations: [],
  });
}

describe('ChatService.syncOrg', () => {
  it('puts a newly hired employee into their department group', () => {
    const chat = service();
    const groupId = chat.ensureDepartmentGroup('dept-1');

    chat.syncOrg(
      [agent('agent-a', 'dept-1', '甲'), agent('agent-b', 'dept-1', '乙')],
      [department('dept-1', '工程部')],
    );

    const group = chat.getSnapshot().conversations.find((item) => item.id === groupId)!;
    expect(group.memberIds).toEqual(['agent-a', 'agent-b']);
  });

  it('takes a transferred employee out of the old department group', () => {
    const chat = service();
    const groupId = chat.ensureDepartmentGroup('dept-1');
    expect(chat.getSnapshot().conversations.find((item) => item.id === groupId)!.memberIds).toEqual(['agent-a']);

    chat.syncOrg(
      [agent('agent-a', 'dept-2')],
      [department('dept-1', '工程部'), department('dept-2', '市场部')],
    );

    const group = chat.getSnapshot().conversations.find((item) => item.id === groupId)!;
    expect(group.memberIds).toEqual([]);
    // The department itself is still listed: an empty group is a real state, not a
    // reason to drop the department.
    expect(chat.getSnapshot().departments.map((item) => item.id)).toEqual(['dept-1', 'dept-2']);
  });

  it('leaves the transcript alone while the roster changes', () => {
    const chat = service();
    const groupId = chat.ensureDepartmentGroup('dept-1');
    chat.sendMessage({ conversationId: groupId, text: '今天先对一下接口' });

    const before = chat.getSnapshot().conversations.find((item) => item.id === groupId)!;
    chat.syncOrg([agent('agent-a', 'dept-1'), agent('agent-b', 'dept-1')], [department('dept-1')]);
    const after = chat.getSnapshot().conversations.find((item) => item.id === groupId)!;

    expect(after.messages.map((message) => message.text)).toEqual(before.messages.map((message) => message.text));
    expect(after.memberIds).toHaveLength(2);
  });
});

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
    const chat = new ChatService({ agents: [], departments: [], conversations: [] });
    const id = chat.ensureAssistant();
    const conversation = chat.getSnapshot().conversations.find((item) => item.id === id)!;

    expect(conversation.kind).toBe('dm');
    expect(conversation.memberIds).toEqual([ROUTER_ID]);
  });

  it('老板说的话变成一条 Trigger，聊天本身不生成回复', async () => {
    const chat = new ChatService({
      agents: [agent('agent-a', 'dept-1', '甲')],
      departments: [],
      conversations: [],
    });
    const triggers: { conversationId: string; text: string }[] = [];
    chat.onBossMessage = (input) => triggers.push(input);
    // 旧路径必须死了：还有任何一个执行体被叫来"替 Router 说话"都是错的。
    chat.replyWithModel = async () => {
      throw new Error('聊天不该自己生成回复');
    };

    const id = chat.ensureAssistant();
    chat.sendMessage({ conversationId: id, text: '上次那个报表做完了吗' });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(triggers).toEqual([{ conversationId: id, text: '上次那个报表做完了吗' }]);
    const conversation = chat.getSnapshot().conversations.find((item) => item.id === id)!;
    // 只有老板那一条。回复要等 Router 决定，不是这里编出来的。
    expect(conversation.messages).toHaveLength(1);
    expect(conversation.messages[0]!.senderId).toBe('user');
  });

  it('Router 说话走唯一的出口，署名是它自己', () => {
    const chat = new ChatService({ agents: [], departments: [], conversations: [] });
    const id = chat.ensureAssistant();

    chat.appendRouterMessage(id, '三条线都在跑，最短的那条十分钟内有结果。');

    const conversation = chat.getSnapshot().conversations.find((item) => item.id === id)!;
    const reply = conversation.messages.at(-1)!;
    expect(reply.senderId).toBe(ROUTER_ID);
    expect(reply.senderName).toBe('助手');
  });

  it('再点一次不会开出第二条会话', () => {
    const chat = new ChatService({ agents: [], departments: [], conversations: [] });
    expect(chat.ensureAssistant()).toBe(chat.ensureAssistant());
    expect(chat.getSnapshot().conversations).toHaveLength(1);
  });
});
