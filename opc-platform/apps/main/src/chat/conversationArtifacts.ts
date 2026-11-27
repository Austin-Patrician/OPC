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
const MAX_CUE_USER_MESSAGE_DISTANCE = 10;
const GENERIC_ATTACHMENT_STEM_RE =
  /^(?:pdf|doc|docx|xls|xlsx|ppt|pptx|png|jpg|jpeg|webp|gif|svg|txt|csv|md|json|html|zip|mp3|mp4|file|image|img|photo|pic|test|temp|tmp|output|result|report|draft|final|copy|new|untitled|新建|文件|图片|截图|报告|文档|表格|附件)$/i;
const NEGATED_ATTACHMENT_CUE_RE =
  /(?:没有|没|未|不带|不要|别带|无需|不用).{0,10}(?:上传|附件|文件)/i;

const BACK_REF_PREFIX_SOURCE =
  '(?:(?:刚才|刚刚|上面|前面|之前|上次)(?:传的|发的|上传的|给你的)?(?:那张|那个|那份|这张|这个|这份|那批|这批|那些|这些|的)?|(?:那张|那个|那份|这份|这张|那批|这批)(?:上传的|传的|发的)?)';
const TYPED_CUE_PATTERNS: readonly {
  kind: Exclude<AttachmentCueKind, 'any'>;
  re: RegExp;
}[] = [
  { kind: 'image', re: new RegExp(`${BACK_REF_PREFIX_SOURCE}(?:图片|截图|照片|图)`, 'i') },
  { kind: 'pdf', re: new RegExp(`${BACK_REF_PREFIX_SOURCE}pdf`, 'i') },
  { kind: 'word', re: new RegExp(`${BACK_REF_PREFIX_SOURCE}(?:docx?|word)`, 'i') },
  { kind: 'spreadsheet', re: new RegExp(`${BACK_REF_PREFIX_SOURCE}(?:xlsx?|csv|表格|excel)`, 'i') },
  { kind: 'presentation', re: new RegExp(`${BACK_REF_PREFIX_SOURCE}(?:pptx?|ppt|演示文稿|幻灯片)`, 'i') },
  { kind: 'document', re: new RegExp(`${BACK_REF_PREFIX_SOURCE}(?:简历|文档)`, 'i') },
];
const GENERIC_BACK_REF_RE = new RegExp(`${BACK_REF_PREFIX_SOURCE}(?:文件|材料|资料)`, 'i');
const GENERIC_UPLOAD_CUE_RE =
  /(?:(?<!带个|加个|附带)附件|原件|原文|(?:已|已经)?上传(?:了|过|的)|发给你|传给你)/i;

type AttachmentCueKind =
  | 'any'
  | 'image'
  | 'pdf'
  | 'word'
  | 'spreadsheet'
  | 'presentation'
  | 'document';

function matchExplicitPriorAttachmentCue(text: string): AttachmentCueKind | null {
  const trimmed = text.trim();
  if (!trimmed || NEGATED_ATTACHMENT_CUE_RE.test(trimmed)) return null;
  for (const { kind, re } of TYPED_CUE_PATTERNS) {
    if (re.test(trimmed)) return kind;
  }
  if (GENERIC_BACK_REF_RE.test(trimmed) || GENERIC_UPLOAD_CUE_RE.test(trimmed)) {
    return 'any';
  }
  return null;
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg', '.ico', '.avif', '.tif', '.tiff', '.heic']);
const WORD_EXTS = new Set(['.doc', '.docx']);
const SPREADSHEET_EXTS = new Set(['.xls', '.xlsx', '.xlsm', '.csv', '.tsv', '.ods']);
const PRESENTATION_EXTS = new Set(['.ppt', '.pptx']);
const DOCUMENT_EXTS = new Set([
  '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.csv',
  '.md', '.txt', '.rtf', '.html', '.pages', '.odt',
]);

function matchesAttachmentCueKind(
  attachment: ChatAttachmentRef,
  kind: AttachmentCueKind,
): boolean {
  if (kind === 'any') return true;
  const ext = path.extname(attachment.name || attachment.path).toLowerCase();
  const mime = attachment.mimeType?.toLowerCase() ?? '';
  switch (kind) {
    case 'image':
      return IMAGE_EXTS.has(ext) || mime.startsWith('image/');
    case 'pdf':
      return ext === '.pdf' || mime === 'application/pdf';
    case 'word':
      return WORD_EXTS.has(ext) || mime.includes('wordprocessingml') || mime === 'application/msword';
    case 'spreadsheet':
      return SPREADSHEET_EXTS.has(ext) || mime.includes('spreadsheetml') || mime === 'text/csv';
    case 'presentation':
      return PRESENTATION_EXTS.has(ext) || mime.includes('presentationml') || mime === 'application/vnd.ms-powerpoint';
    case 'document':
      return DOCUMENT_EXTS.has(ext) || mime === 'application/pdf' || mime.includes('wordprocessingml');
  }
}

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
  return stem.length >= 3 && !GENERIC_ATTACHMENT_STEM_RE.test(stem) && lowerText.includes(stem);
}

/**
 * Re-attaches valid user-uploaded files from earlier messages in the same chat
 * transcript when the current follow-up explicitly names them, uses an
 * unambiguous prior-attachment reference matching the file kind, or immediately
 * continues an unreplied / captionless upload turn.
 */
export function referencedConversationUserAttachments(input: {
  text: string;
  messages: readonly Message[];
  hasCurrentAttachments?: boolean;
}): ChatAttachmentRef[] {
  const lowerText = input.text.trim().toLowerCase();
  const cueKind = !input.hasCurrentAttachments
    ? matchExplicitPriorAttachmentCue(input.text)
    : null;
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

    const isUnrepliedConsecutiveUserUpload = input.messages
      .slice(i + 1)
      .every((later) => later.senderId === 'user');
    const isImmediateFollowUpToCaptionlessUpload =
      (message.text ?? '').trim() === '' && input.messages.length - 1 - i <= 2;
    const allowImmediateBatch =
      !input.hasCurrentAttachments &&
      !capturedLatestBatch &&
      (isUnrepliedConsecutiveUserUpload || isImmediateFollowUpToCaptionlessUpload);
    const allowCueBatch =
      !input.hasCurrentAttachments &&
      !capturedLatestBatch &&
      cueKind !== null &&
      scannedUserMessages <= MAX_CUE_USER_MESSAGE_DISTANCE;
    if (!capturedLatestBatch) {
      capturedLatestBatch = true;
    }

    for (const attachment of validAttachments) {
      if (
        allowImmediateBatch ||
        (allowCueBatch && matchesAttachmentCueKind(attachment, cueKind)) ||
        textMentionsAttachment(lowerText, attachment.name)
      ) {
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
