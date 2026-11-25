import { describe, expect, it } from 'vitest';
import type { Message } from '@opc/shared/domain';
import {
  INITIAL_FIRST_ITEM_INDEX,
  filterResolvedActionBlocks,
  isLocallyResolvedEmptyActionMessage,
  mergeSnapshotMessages,
  prependOlderMessages,
} from './messageList';

function makeMessage(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    kind: 'text',
    senderId: 'router',
    senderName: '助手',
    timestamp: '10:00',
    text: `内容-${id}`,
    ...overrides,
  };
}

describe('messageList helpers', () => {
  it('mergeSnapshotMessages 在消息未变时复用原数组和原消息对象引用', () => {
    const m1 = makeMessage('m1', { content: [{ type: 'markdown', text: '第一条' }] });
    const m2 = makeMessage('m2', { senderId: 'user', senderName: '我', text: '第二条' });
    const current = [m1, m2];

    const incoming = [
      makeMessage('m1', { content: [{ type: 'markdown', text: '第一条' }] }),
      makeMessage('m2', { senderId: 'user', senderName: '我', text: '第二条' }),
    ];

    const next = mergeSnapshotMessages(current, incoming);
    expect(next).toBe(current);
    expect(next[0]).toBe(m1);
    expect(next[1]).toBe(m2);
  });

  it('mergeSnapshotMessages 在流式更新时只替换变化的那一条消息，保留历史消息引用', () => {
    const m1 = makeMessage('m1', { content: [{ type: 'markdown', text: '历史消息' }] });
    const m2 = makeMessage('m2', { text: '正在', content: [{ type: 'markdown', text: '正在' }], streaming: true });
    const current = [m1, m2];

    const incoming = [
      makeMessage('m1', { content: [{ type: 'markdown', text: '历史消息' }] }),
      makeMessage('m2', { text: '正在生成中', content: [{ type: 'markdown', text: '正在生成中' }], streaming: true }),
    ];

    const next = mergeSnapshotMessages(current, incoming);
    expect(next).not.toBe(current);
    expect(next[0]).toBe(m1);
    expect(next[1]).not.toBe(m2);
    expect(next[1]?.text).toBe('正在生成中');
  });

  it('mergeSnapshotMessages 会移除已被主进程取消的瞬态 streaming 消息并保留已翻页旧消息', () => {
    const oldLoaded = makeMessage('m0');
    const kept = makeMessage('m1');
    const cancelledStream = makeMessage('m-stream', { streaming: true, text: '半截' });
    const current = [oldLoaded, kept, cancelledStream];

    const incoming = [makeMessage('m1')];
    const next = mergeSnapshotMessages(current, incoming);

    expect(next.map((m) => m.id)).toEqual(['m0', 'm1']);
    expect(next[0]).toBe(oldLoaded);
    expect(next[1]).toBe(kept);
  });

  it('prependOlderMessages 原子计算 firstItemIndex 偏移并过滤重复与不可见消息', () => {
    const m10 = makeMessage('m10');
    const m11 = makeMessage('m11');
    const initial = {
      messages: [m10, m11],
      firstItemIndex: INITIAL_FIRST_ITEM_INDEX,
    };

    const older: Message[] = [
      makeMessage('m8'),
      makeMessage('task-hidden', { kind: 'task' }),
      makeMessage('m9'),
      makeMessage('m10', { text: '重复项不应增加索引偏移' }),
    ];

    const next = prependOlderMessages(initial, older);
    expect(next.messages.map((m) => m.id)).toEqual(['m8', 'task-hidden', 'm9', 'm10', 'm11']);
    // Only m8 and m9 are newly added visible messages; task-hidden is invisible and m10 already existed.
    expect(next.firstItemIndex).toBe(INITIAL_FIRST_ITEM_INDEX - 2);
    expect(next.messages[3]).toBe(m10);
  });

  it('mergeSnapshotMessages 在确认审批或请示卡片后会从列表中移除对应消息，不留下空头部', () => {
    const older = makeMessage('m0');
    const kept = makeMessage('m1');
    const approvalMsg = makeMessage('m-approval', {
      text: '需要允许工具权限',
      content: [
        {
          type: 'approval',
          reportId: 'r-approval-1',
          threadId: 't-1',
          taskId: 'task-1',
          tool: 'bash',
          title: '允许执行脚本',
          body: '允许运行 Python 脚本',
          state: 'pending',
        },
      ],
    });
    const workflowMsg = makeMessage('m-workflow', {
      text: '请示问题',
      content: [
        {
          type: 'workflow',
          reportId: 'r-workflow-1',
          threadId: 't-1',
          kind: 'question',
          title: '请确认方向',
          body: '是否继续？',
          state: 'pending',
        },
      ],
    });

    const afterRemoveOne = mergeSnapshotMessages(
      [older, kept, approvalMsg, workflowMsg],
      [kept, workflowMsg],
    );
    expect(afterRemoveOne.map((m) => m.id)).toEqual(['m0', 'm1', 'm-workflow']);

    const afterClearAll = mergeSnapshotMessages([approvalMsg], []);
    expect(afterClearAll).toEqual([]);
  });

  it('isLocallyResolvedEmptyActionMessage 仅在纯操作卡全部确认时隐藏整条消息', () => {
    const resolved = new Set(['r-1']);
    const pureApproval = makeMessage('m-pure', {
      content: [
        {
          type: 'approval',
          reportId: 'r-1',
          threadId: 't-1',
          taskId: 'task-1',
          tool: 'bash',
          title: '审批',
          body: '正文',
          state: 'pending',
        },
      ],
    });
    const mixed = makeMessage('m-mixed', {
      content: [
        { type: 'markdown', text: '附言说明' },
        {
          type: 'workflow',
          reportId: 'r-1',
          threadId: 't-1',
          kind: 'question',
          title: '请示',
          body: '问题',
          state: 'pending',
        },
      ],
    });

    expect(isLocallyResolvedEmptyActionMessage(pureApproval, resolved)).toBe(true);
    expect(isLocallyResolvedEmptyActionMessage(mixed, resolved)).toBe(false);
    expect(filterResolvedActionBlocks(mixed.content!, resolved)).toEqual([
      { type: 'markdown', text: '附言说明' },
    ]);
  });
});
