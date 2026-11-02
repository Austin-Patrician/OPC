import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    const chat = new ChatService({ agents: [], departments: [], conversations: [] });
    const id = chat.ensureAssistant();
    const conversation = chat.getSnapshot().conversations.find((item) => item.id === id)!;

    expect(conversation.kind).toBe('dm');
    expect(conversation.memberIds).toEqual([ROUTER_ID]);
  });

  it('老板说的话变成一条 Trigger，聊天本身不生成回复', async () => {
    // 故意留一个执行体在快照里：他要是不该被叫来回答，留着也不会被叫。
    const chat = new ChatService({ agents: [], departments: [], conversations: [] });
    const triggers: { conversationId: string; text: string }[] = [];
    chat.onBossMessage = (input) => triggers.push(input);

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
