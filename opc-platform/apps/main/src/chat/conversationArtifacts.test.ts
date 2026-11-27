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

function assistantMessage(id: string, text: string): Message {
  return {
    id,
    kind: 'text',
    senderId: 'router',
    senderName: '助手',
    timestamp: '12:01',
    text,
  };
}

describe('conversation user attachment references', () => {
  it('carries over prior user attachments on explicit filename/stem mention, explicit cues, or consecutive unreplied turns', () => {
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

    // 1. Consecutive unreplied user follow-up carries over immediately prior upload
    const recentRefs = referencedConversationUserAttachments({
      text: '帮我翻一下',
      messages: [userMessage('m-1', '上传了简历', [att, deletedAtt])],
    });
    expect(recentRefs).toHaveLength(1);
    expect(recentRefs[0]?.name).toBe('Austin_Resume_EN.pdf');

    // 2. Old history after replies: carried over when explicit upload cue or filename/stem is mentioned
    const filler: Message[] = Array.from({ length: 8 }, (_, idx) =>
      userMessage(`filler-${idx}`, `闲聊 ${idx}`),
    );
    const oldHistory = [
      userMessage('m-old', '之前发过', [att]),
      assistantMessage('a-old', '已收到，帮你处理完成。'),
      ...filler,
    ];

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

  it('does not leak historical resume PDF into unrelated new PPT or image requests', () => {
    const folder = root();
    const resumePath = path.join(folder, '【Senior .NET Engineer_上海 30-50K】张浮生 9年.pdf');
    writeFileSync(resumePath, '%PDF-1.4 resume');
    const resumeAtt: ChatAttachmentRef = {
      id: 'att-resume',
      name: '【Senior .NET Engineer_上海 30-50K】张浮生 9年.pdf',
      path: resumePath,
      size: 15,
      source: 'file',
      availability: 'available',
    };
    const settledHistory: Message[] = [
      userMessage('u-1', '帮我把简历翻译成英文', [resumeAtt]),
      assistantMessage('a-1', '英文简历已生成并保存。'),
      userMessage('u-2', '生成一个可爱的鲸鱼娘的三视图'),
      assistantMessage('a-2', '鲸鱼娘三视图已生成。'),
    ];

    expect(
      referencedConversationUserAttachments({
        text: '再给我做一个PPT, 5页，报告的内容是推荐大家订阅Gemini  Pro模型，最新比较好用，黑五性价比也高',
        messages: settledHistory,
      }),
    ).toEqual([]);

    // Even immediately after the assistant reply to the upload turn, unrelated prompts must not inherit it.
    const immediatelyAfterUploadTurn: Message[] = [
      userMessage('u-1', '帮我把简历翻译成英文', [resumeAtt]),
      assistantMessage('a-1', '英文简历已生成并保存。'),
    ];
    for (const prompt of [
      '生成一个可爱的鲸鱼娘的三视图',
      '帮我导出一个 PDF 报告',
      '继续',
      '重试',
    ]) {
      expect(
        referencedConversationUserAttachments({
          text: prompt,
          messages: immediatelyAfterUploadTurn,
        }),
      ).toEqual([]);
    }
  });

  it('enforces type-aware deictic cues, negated mentions, generic stem guard, and captionless follow-up', () => {
    const folder = root();
    const pdfPath = path.join(folder, 'resume.pdf');
    const pngPath = path.join(folder, 'whale_girl.png');
    const pptPath = path.join(folder, 'ppt.pptx');
    writeFileSync(pdfPath, '%PDF-1.4');
    writeFileSync(pngPath, 'png');
    writeFileSync(pptPath, 'pptx');

    const pdfAtt: ChatAttachmentRef = {
      id: 'att-pdf',
      name: 'resume.pdf',
      path: pdfPath,
      size: 8,
      mimeType: 'application/pdf',
      source: 'file',
      availability: 'available',
    };
    const pngAtt: ChatAttachmentRef = {
      id: 'att-png',
      name: 'whale_girl.png',
      path: pngPath,
      size: 3,
      mimeType: 'image/png',
      source: 'file',
      availability: 'available',
    };
    const genericPptAtt: ChatAttachmentRef = {
      id: 'att-ppt',
      name: 'ppt.pptx',
      path: pptPath,
      size: 4,
      source: 'file',
      availability: 'available',
    };

    // Cross-type deictic cue isolation
    expect(
      referencedConversationUserAttachments({
        text: '把刚才那张图片改一下背景',
        messages: [userMessage('u-1', '翻译这个PDF', [pdfAtt]), assistantMessage('a-1', '好的')],
      }),
    ).toEqual([]);
    expect(
      referencedConversationUserAttachments({
        text: '把刚才那张图片改一下背景',
        messages: [userMessage('u-1', '看下这张图', [pngAtt]), assistantMessage('a-1', '好的')],
      }).map((item) => item.name),
    ).toEqual(['whale_girl.png']);

    // Negated mentions never trigger carryover
    expect(
      referencedConversationUserAttachments({
        text: '我没有在对话中上传附件，不要带附件',
        messages: [userMessage('u-1', '看下这张图', [pdfAtt]), assistantMessage('a-1', '好的')],
      }),
    ).toEqual([]);

    // Generic stem "ppt" must not match "做一个PPT", whereas exact "ppt.pptx" does
    const pptHistory = [userMessage('u-1', '先看下', [genericPptAtt]), assistantMessage('a-1', '看过了')];
    expect(
      referencedConversationUserAttachments({
        text: '再给我做一个PPT',
        messages: pptHistory,
      }),
    ).toEqual([]);
    expect(
      referencedConversationUserAttachments({
        text: '修改 ppt.pptx 里的第三页',
        messages: pptHistory,
      }).map((item) => item.name),
    ).toEqual(['ppt.pptx']);

    // Captionless upload + 1 assistant clarification + immediate answer still carries over
    expect(
      referencedConversationUserAttachments({
        text: '帮我翻译成中文',
        messages: [
          userMessage('u-1', '', [pdfAtt]),
          assistantMessage('a-1', '你希望我如何处理这份文件？'),
        ],
      }).map((item) => item.name),
    ).toEqual(['resume.pdf']);
  });
});
