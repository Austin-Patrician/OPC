import { describe, expect, it } from 'vitest';
import type { Agent } from '@opc/shared/domain';
import { ChatService } from './chatService';

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
