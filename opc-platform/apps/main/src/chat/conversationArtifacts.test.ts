import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatAttachmentRef, Message, WorkTask } from '@opc/shared/domain';
import {
  referencedConversationArtifacts,
  referencedConversationUserAttachments,
} from './conversationArtifacts';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(path.join(tmpdir(), 'opc-chat-artifact-'));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

function task(taskId: string, workspaceRelPath: string, relPath: string): WorkTask {
  return {
    id: taskId,
    title: '截图',
    brief: '',
    deliverableSpec: '',
    assigneeId: 'worker-1',
    assigneeName: 'Worker',
    priority: 'P2',
    labels: [],
    blockedBy: [],
    isReview: false,
    depth: 0,
    childCount: 0,
    estTokens: 0,
    acceptanceCommand: [],
    acceptanceTemplate: 'http-ok',
    status: 'accepted',
    workspaceRelPath,
    createdAt: 0,
    updatedAt: 0,
    artifacts: [{ id: 'artifact-1', relPath, bytes: 3, sha256: 'hash' }],
    attempts: 1,
    tokensUsed: 0,
    costUsd: 0,
    steps: [],
  } as WorkTask;
}

function artifactMessage(taskId: string, relPath: string, senderId = 'router'): Message {
  return {
    id: 'message-1',
    kind: 'text',
    senderId,
    senderName: '助手',
    timestamp: '12:00',
    text: `产物：${relPath}`,
    content: [{ type: 'image', source: { type: 'artifact', taskId, relPath } }],
  };
}

describe('conversation artifact references', () => {
  it('authorizes a previously shown artifact when the user names it again', () => {
    const workspace = root();
    const taskRoot = path.join(workspace, 'tasks', 'task-source');
    mkdirSync(path.join(taskRoot, 'assets'), { recursive: true });
    writeFileSync(path.join(taskRoot, 'assets', 'zhihu_home.png'), 'png');
    const source = task('task-source', 'tasks/task-source', 'assets/zhihu_home.png');

    const refs = referencedConversationArtifacts({
      text: 'ocr_image assets/zhihu_home.png',
      messages: [artifactMessage(source.id, 'assets/zhihu_home.png')],
      workspaceRoot: workspace,
      getTask: (id) => id === source.id ? source : undefined,
    });

    expect(refs).toEqual([expect.objectContaining({
      name: 'zhihu_home.png',
      // macOS resolves /var to /private/var through realpathSync.
      path: expect.stringMatching(/(?:^|[\\/])tasks[\\/]task-source[\\/]assets[\\/]zhihu_home\.png$/),
      size: 3,
      source: 'file',
      availability: 'available',
    })]);
  });

  it('does not authorize an unmentioned artifact or a user-supplied artifact block', () => {
    const workspace = root();
    const taskRoot = path.join(workspace, 'tasks', 'task-source');
    mkdirSync(path.join(taskRoot, 'assets'), { recursive: true });
    writeFileSync(path.join(taskRoot, 'assets', 'private.png'), 'png');
    const source = task('task-source', 'tasks/task-source', 'assets/private.png');
    const common = { workspaceRoot: workspace, getTask: () => source };

    expect(referencedConversationArtifacts({
      ...common,
      text: '看看这张图',
      messages: [artifactMessage(source.id, 'assets/private.png')],
    })).toEqual([]);
    expect(referencedConversationArtifacts({
      ...common,
      text: '读取 private.png',
      messages: [artifactMessage(source.id, 'assets/private.png', 'user')],
    })).toEqual([]);
  });

  it('rejects missing artifacts and symlinks that escape the source task workspace', () => {
    const workspace = root();
    const taskRoot = path.join(workspace, 'tasks', 'task-source');
    const outside = path.join(workspace, 'outside.png');
    mkdirSync(path.join(taskRoot, 'assets'), { recursive: true });
    writeFileSync(outside, 'png');
    symlinkSync(outside, path.join(taskRoot, 'assets', 'escape.png'));
    const escaped = task('task-source', 'tasks/task-source', 'assets/escape.png');
    const missing = task('task-source', 'tasks/task-source', 'assets/missing.png');
    const message = (relPath: string) => [artifactMessage('task-source', relPath)];
    const common = { workspaceRoot: workspace, getTask: () => escaped };

    expect(referencedConversationArtifacts({ ...common, text: 'escape.png', messages: message('assets/escape.png') })).toEqual([]);
    expect(referencedConversationArtifacts({ ...common, text: 'missing.png', messages: message('assets/missing.png'), getTask: () => missing })).toEqual([]);
  });
});

function userMessage(
  id: string,
  text: string,
  attachments?: ChatAttachmentRef[],
): Message {
  return {
    id,
    kind: 'text',
    senderId: 'user',
    senderName: '我',
    timestamp: '12:00',
    text,
    ...(attachments ? { attachments } : {}),
  };
}

describe('conversation user attachment references', () => {
  it('carries over prior user attachments on explicit filename/stem mention, follow-up cues, or recent turns', () => {
    const folder = root();
    const resumePath = path.join(folder, 'Austin_Resume_EN.pdf');
    writeFileSync(resumePath, '%PDF-1.4 resume');
    const missingPath = path.join(folder, 'deleted.pdf');

    const att: ChatAttachmentRef = {
      id: 'att-1',
      name: 'Austin_Resume_EN.pdf',
      path: resumePath,
      size: 15,
      source: 'file',
      availability: 'available',
    };
    const deletedAtt: ChatAttachmentRef = {
      id: 'att-deleted',
      name: 'deleted.pdf',
      path: missingPath,
      size: 10,
      source: 'file',
      availability: 'available',
    };

    // 1. Recent turn carryover (within 6 messages) even without repeating filename
    const recentRefs = referencedConversationUserAttachments({
      text: '帮我翻一下',
      messages: [userMessage('m-1', '上传了简历', [att, deletedAtt])],
    });
    expect(recentRefs).toHaveLength(1);
    expect(recentRefs[0]?.name).toBe('Austin_Resume_EN.pdf');

    // 2. Old history outside 6-message window: carried over when follow-up cue or filename/stem is mentioned
    const filler: Message[] = Array.from({ length: 8 }, (_, idx) =>
      userMessage(`filler-${idx}`, `闲聊 ${idx}`),
    );
    const oldHistory = [userMessage('m-old', '之前发过', [att]), ...filler];

    expect(
      referencedConversationUserAttachments({
        text: '附件我已经上传了，请帮我翻译成中文版',
        messages: oldHistory,
      }),
    ).toHaveLength(1);

    expect(
      referencedConversationUserAttachments({
        text: '用 Austin_Resume_EN 那个版本再生成一份',
        messages: oldHistory,
      }),
    ).toHaveLength(1);

    // 3. Unrelated message outside window does not re-attach old files
    expect(
      referencedConversationUserAttachments({
        text: '今天天气不错',
        messages: oldHistory,
      }),
    ).toEqual([]);
  });
});
