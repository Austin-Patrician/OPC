import type { ChatContentBlock } from '@opc/shared/domain';
import { withoutDesktopMediaUrls } from '../blockArtifacts';

export type ParsedDingTalkAddress =
  | { chatKind: 'p2p'; staffId: string }
  | { chatKind: 'group'; openConversationId: string };

export interface DingTalkInboundResource {
  kind: 'image' | 'file';
  downloadCode: string;
  fileName?: string;
}

export interface DingTalkParsedInbound {
  text: string;
  resources: DingTalkInboundResource[];
}

export interface DingTalkOutboundSpec {
  msgType: 'text' | 'markdown';
  title: string;
  text: string;
}

export function formatDingTalkAddress(chatKind: 'p2p' | 'group', id: string): string {
  return chatKind === 'p2p' ? `dingtalk:dm:${id}` : `dingtalk:group:${id}`;
}

export function parseDingTalkAddress(address: string): ParsedDingTalkAddress | null {
  const trimmed = address.trim();
  if (trimmed.startsWith('dingtalk:dm:')) {
    const staffId = trimmed.slice('dingtalk:dm:'.length).trim();
    return staffId ? { chatKind: 'p2p', staffId } : null;
  }
  if (trimmed.startsWith('dingtalk:group:')) {
    const openConversationId = trimmed.slice('dingtalk:group:'.length).trim();
    return openConversationId ? { chatKind: 'group', openConversationId } : null;
  }
  return null;
}

interface DingTalkRichTextItem {
  text?: string;
  downloadCode?: string;
  pictureDownloadCode?: string;
  type?: string;
}

export interface DingTalkRobotPayload {
  msgtype?: string;
  text?: { content?: string };
  content?: {
    downloadCode?: string;
    fileName?: string;
    recognition?: string;
    richText?: DingTalkRichTextItem[];
  };
}

export function extractDingTalkInboundContent(
  payload: DingTalkRobotPayload,
): DingTalkParsedInbound {
  const msgtype = payload.msgtype ?? 'text';
  const resources: DingTalkInboundResource[] = [];

  switch (msgtype) {
    case 'text': {
      const content = typeof payload.text?.content === 'string' ? payload.text.content : '';
      return {
        text: content.replace(/\s+/g, ' ').trim(),
        resources,
      };
    }
    case 'richText': {
      const items = Array.isArray(payload.content?.richText) ? payload.content.richText : [];
      const textParts: string[] = [];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        if (typeof item.text === 'string' && item.text.trim()) {
          textParts.push(item.text.trim());
        }
        const downloadCode = item.pictureDownloadCode ?? item.downloadCode;
        if (typeof downloadCode === 'string' && downloadCode.trim()) {
          resources.push({ kind: 'image', downloadCode: downloadCode.trim() });
        }
      }
      const joined = textParts.join(' ').replace(/\s+/g, ' ').trim();
      return {
        text: joined || (resources.length > 0 ? '[富文本图片消息]' : ''),
        resources,
      };
    }
    case 'picture': {
      const downloadCode = payload.content?.downloadCode?.trim();
      if (downloadCode) {
        resources.push({ kind: 'image', downloadCode });
      }
      return {
        text: '[用户发送了一张图片]',
        resources,
      };
    }
    case 'file': {
      const downloadCode = payload.content?.downloadCode?.trim();
      const fileName = payload.content?.fileName?.trim();
      if (downloadCode) {
        resources.push({
          kind: 'file',
          downloadCode,
          ...(fileName ? { fileName } : {}),
        });
      }
      return {
        text: fileName ? `[用户发送了文件：${fileName}]` : '[用户发送了一个文件]',
        resources,
      };
    }
    case 'audio': {
      const recognition = payload.content?.recognition?.trim();
      const downloadCode = payload.content?.downloadCode?.trim();
      if (downloadCode) {
        resources.push({
          kind: 'file',
          downloadCode,
          fileName: 'voice-message.amr',
        });
      }
      return {
        text: recognition || '[用户发送了一段语音]',
        resources,
      };
    }
    case 'video': {
      const downloadCode = payload.content?.downloadCode?.trim();
      if (downloadCode) {
        resources.push({
          kind: 'file',
          downloadCode,
          fileName: 'video-message.mp4',
        });
      }
      return {
        text: '[用户发送了一段视频]',
        resources,
      };
    }
    default:
      return {
        text: `[${msgtype} 消息]`,
        resources,
      };
  }
}

function renderBlockAsMarkdown(block: ChatContentBlock): string {
  switch (block.type) {
    case 'markdown':
      return withoutDesktopMediaUrls(block.text.trim());
    case 'approval':
      return [
        `### ⚠️ 需要你的授权：${block.title}`,
        block.body,
        block.tool ? `涉及工具：\`${block.tool}\`` : '',
        '> 请前往桌面端「对话」点击允许或拒绝。',
      ]
        .filter(Boolean)
        .join('\n\n');
    case 'workflow':
      return [
        `### ${block.kind === 'question' ? '❓' : '📋'} ${block.title}`,
        block.body,
      ]
        .filter(Boolean)
        .join('\n\n');
    case 'image':
    case 'video':
    case 'audio':
    case 'file': {
      const label =
        ('alt' in block && block.alt?.trim()) ||
        block.title?.trim() ||
        ('name' in block && block.name?.trim()) ||
        block.type;
      if (block.source.type === 'url') {
        try {
          const url = new URL(block.source.url);
          if (url.protocol === 'https:' || url.protocol === 'http:') {
            return `[${label}](${url.href})`;
          }
        } catch {
          // Ignore malformed URLs.
        }
        return `[${label}]`;
      }
      return `📎 ${label} (\`${block.source.relPath}\`)`;
    }
  }
}

function hasMarkdownSyntax(text: string): boolean {
  return /(^#{1,6}\s|```|\*\*|\[[^\]]+\]\([^)]+\)|^[-*]\s|^>\s|\|.+\|)/m.test(text);
}

function extractMarkdownTitle(markdown: string): string {
  const firstLine = markdown
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, '').replace(/[*`>_]/g, '').trim())
    .find((line) => line.length > 0);
  if (!firstLine) return 'Buddy 回复';
  return firstLine.length > 36 ? `${firstLine.slice(0, 36)}…` : firstLine;
}

export function buildDingTalkOutboundMessages(
  blocks?: readonly ChatContentBlock[],
  fallbackText?: string,
): DingTalkOutboundSpec[] {
  const renderedBlocks = (blocks ?? [])
    .map((block) => renderBlockAsMarkdown(block))
    .filter((text) => text.length > 0);

  const combined =
    renderedBlocks.length > 0
      ? renderedBlocks.join('\n\n')
      : withoutDesktopMediaUrls((fallbackText ?? '').trim());

  if (!combined) return [];

  const hasNonMarkdown = blocks?.some((block) => block.type !== 'markdown') ?? false;
  const useMarkdown = hasNonMarkdown || hasMarkdownSyntax(combined) || combined.length > 260;

  if (!useMarkdown) {
    return [
      {
        msgType: 'text',
        title: 'Buddy 回复',
        text: combined,
      },
    ];
  }

  const MAX_CHUNK = 3200;
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < combined.length) {
    if (combined.length - cursor <= MAX_CHUNK) {
      chunks.push(combined.slice(cursor));
      break;
    }
    let splitAt = combined.lastIndexOf('\n', cursor + MAX_CHUNK);
    if (splitAt <= cursor + MAX_CHUNK / 2) {
      splitAt = cursor + MAX_CHUNK;
    }
    chunks.push(combined.slice(cursor, splitAt).trim());
    cursor = splitAt;
  }

  const baseTitle = extractMarkdownTitle(combined);
  return chunks.map((chunk, idx) => ({
    msgType: 'markdown',
    title: chunks.length > 1 ? `${baseTitle} (${idx + 1}/${chunks.length})` : baseTitle,
    text: chunk,
  }));
}
