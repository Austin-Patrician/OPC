import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ChatAttachmentRef, Message, WorkTask } from '@opc/shared/domain';

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
