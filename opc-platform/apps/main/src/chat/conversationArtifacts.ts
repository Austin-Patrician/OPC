import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  MAX_CHAT_ATTACHMENTS_PER_MESSAGE,
  MAX_CHAT_ATTACHMENT_BYTES,
  type ChatAttachmentRef,
  type Message,
  type WorkTask,
} from '@opc/shared/domain';

const MAX_USER_ATTACHMENT_SCAN_MESSAGES = 20;
const RECENT_ATTACHMENT_WINDOW = 6;
const FOLLOW_UP_ATTACHMENT_CUE_RE =
  /(附件|文件|简历|原件|原文|pdf|docx?|xlsx?|pptx?|图片|截图|发给你|传给你|上传了|已上传|刚才|上面|重试|再试|继续)/i;

function comparableAttachmentPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function validateUserAttachment(attachment: ChatAttachmentRef): ChatAttachmentRef | null {
  const rawPath = attachment.path?.trim();
  if (!rawPath) return null;
  const resolved = path.resolve(rawPath);
  try {
    const stat = statSync(resolved);
    if (!stat.isFile() || stat.size > MAX_CHAT_ATTACHMENT_BYTES) return null;
    return {
      ...attachment,
      path: resolved,
      size: stat.size,
      availability: 'available',
    };
  } catch {
    return null;
  }
}

function textMentionsAttachment(lowerText: string, name: string): boolean {
  if (!lowerText || !name) return false;
  const lowerName = name.toLowerCase();
  if (lowerText.includes(lowerName)) return true;
  const stem = path.posix.basename(lowerName, path.posix.extname(lowerName)).trim();
  return stem.length >= 2 && lowerText.includes(stem);
}

/**
 * Re-attaches valid user-uploaded files from earlier messages in the same chat
 * transcript when the current follow-up explicitly names them, uses follow-up/file
 * cues, or closely follows the most recent attachment turn.
 */
export function referencedConversationUserAttachments(input: {
  text: string;
  messages: readonly Message[];
  hasCurrentAttachments?: boolean;
}): ChatAttachmentRef[] {
  const lowerText = input.text.trim().toLowerCase();
  const hasCue = !input.hasCurrentAttachments && FOLLOW_UP_ATTACHMENT_CUE_RE.test(input.text);
  const selected: ChatAttachmentRef[] = [];
  const seen = new Set<string>();

  const pushUnique = (candidate: ChatAttachmentRef) => {
    if (selected.length >= MAX_CHAT_ATTACHMENTS_PER_MESSAGE) return;
    const key = comparableAttachmentPath(candidate.path);
    if (seen.has(key)) return;
    seen.add(key);
    selected.push(candidate);
  };

  let scannedUserMessages = 0;
  let capturedLatestBatch = false;

  for (let i = input.messages.length - 1; i >= 0; i -= 1) {
    const message = input.messages[i];
    if (!message || message.senderId !== 'user') continue;
    scannedUserMessages += 1;
    if (scannedUserMessages > MAX_USER_ATTACHMENT_SCAN_MESSAGES) break;

    const rawAttachments = message.attachments ?? [];
    if (rawAttachments.length === 0) continue;

    const validAttachments = rawAttachments
      .map(validateUserAttachment)
      .filter((item): item is ChatAttachmentRef => item !== null);
    if (validAttachments.length === 0) continue;

    const isRecent = input.messages.length - 1 - i < RECENT_ATTACHMENT_WINDOW;
    const includeEntireRecentBatch =
      !input.hasCurrentAttachments && !capturedLatestBatch && (hasCue || isRecent);
    if (!capturedLatestBatch) {
      capturedLatestBatch = true;
    }

    for (const attachment of validAttachments) {
      if (includeEntireRecentBatch || textMentionsAttachment(lowerText, attachment.name)) {
        pushUnique(attachment);
      }
    }

    if (selected.length >= MAX_CHAT_ATTACHMENTS_PER_MESSAGE) break;
  }

  return selected;
}

/**
 * Resolve artifacts that the assistant already showed in this conversation when
 * the user names them again. Tasks have isolated workspaces, so a path such as
 * `assets/result.png` is not automatically present in a later task's workspace.
 *
 * This only returns registered artifacts from assistant messages, and only when
 * the current user message explicitly names the path or filename.
 */
export function referencedConversationArtifacts(input: {
  text: string;
  messages: readonly Message[];
  workspaceRoot: string;
  getTask: (taskId: string) => WorkTask | undefined;
}): ChatAttachmentRef[] {
  const text = input.text.replaceAll('\\', '/');
  const candidates = new Map<string, { taskId: string; relPath: string }>();

  for (const message of input.messages) {
    if (message.senderId === 'user' || message.streaming) continue;
    for (const block of message.content ?? []) {
      if (
        !('source' in block) || block.source.type !== 'artifact' ||
        typeof block.source.taskId !== 'string' || typeof block.source.relPath !== 'string'
      ) continue;
      const relPath = block.source.relPath.replaceAll('\\', '/');
      const name = path.posix.basename(relPath);
      if (!relPath || !name || (!text.includes(relPath) && !text.includes(name))) continue;
      const key = `${block.source.taskId}\0${relPath}`;
      candidates.set(key, { taskId: block.source.taskId, relPath });
    }
  }

  const attachments: ChatAttachmentRef[] = [];
  for (const { taskId, relPath } of candidates.values()) {
    const task = input.getTask(taskId);
    const artifact = task?.artifacts.find((item) => item.relPath.replaceAll('\\', '/') === relPath);
    if (!task || !artifact) continue;

    const taskRootPath = path.resolve(input.workspaceRoot, task.workspaceRelPath);
    const candidatePath = path.resolve(taskRootPath, relPath);
    const candidateRelative = path.relative(taskRootPath, candidatePath);
    if (candidateRelative === '..' || candidateRelative.startsWith(`..${path.sep}`) || path.isAbsolute(candidateRelative)) continue;
    let taskRoot: string;
    let absolutePath: string;
    try {
      taskRoot = realpathSync(taskRootPath);
      absolutePath = realpathSync(candidatePath);
    } catch {
      continue;
    }
    const relative = path.relative(taskRoot, absolutePath);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    try {
      if (!statSync(absolutePath).isFile()) continue;
    } catch {
      continue;
    }

    attachments.push({
      id: `artifact-${taskId}-${artifact.id}`,
      name: path.posix.basename(relPath),
      path: absolutePath,
      size: artifact.bytes,
      source: 'file',
      availability: 'available',
    });
  }

  return attachments;
}
