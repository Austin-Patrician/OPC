import type { ChatContentBlock } from '@opc/shared/domain';
import {
  extractArtifactsFromBlocks,
  withoutDesktopMediaUrls,
  type OutboundArtifactRef,
} from '../blockArtifacts';

export { extractArtifactsFromBlocks };
export type FeishuOutboundArtifactRef = OutboundArtifactRef;

export interface FeishuMentionItem {
  key: string;
  name: string;
  id?: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
}

export interface FeishuInboundResource {
  kind: 'image' | 'file';
  fileKey: string;
  fileName?: string;
}

export interface FeishuParsedInbound {
  text: string;
  resources: FeishuInboundResource[];
}

export interface FeishuOutboundMessageSpec {
  msgType: 'text' | 'interactive';
  content: string;
}

export function formatFeishuAddress(chatId: string): string {
  return `feishu:chat:${chatId}`;
}

export function parseFeishuAddress(address: string): string | null {
  const trimmed = address.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('feishu:chat:')) {
    const id = trimmed.slice('feishu:chat:'.length).trim();
    return id || null;
  }
  if (trimmed.startsWith('oc_') || trimmed.startsWith('ou_')) {
    return trimmed;
  }
  return null;
}

export function stripFeishuMentions(text: string, mentions?: FeishuMentionItem[]): string {
  let result = text;
  if (mentions) {
    for (const mention of mentions) {
      if (!mention.key) continue;
      const escaped = mention.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(escaped, 'g'), '');
    }
  }
  // Remove leftover Feishu placeholder tokens such as @_user_1 or @_all if unreferenced.
  result = result.replace(/@_user_\d+/g, '');
  return result.replace(/[ \t]+\n/g, '\n').replace(/\s{2,}/g, ' ').trim();
}

interface PostElement {
  tag?: string;
  text?: string;
  href?: string;
  user_name?: string;
  image_key?: string;
}

function parsePostLocale(
  localeObj: unknown,
  parts: string[],
  resources: FeishuInboundResource[],
): void {
  if (!localeObj || typeof localeObj !== 'object') return;
  const record = localeObj as { title?: unknown; content?: unknown };
  if (typeof record.title === 'string' && record.title.trim()) {
    parts.push(record.title.trim());
  }
  if (!Array.isArray(record.content)) return;
  for (const row of record.content) {
    if (!Array.isArray(row)) continue;
    const lineParts: string[] = [];
    for (const item of row as PostElement[]) {
      if (!item || typeof item !== 'object') continue;
      if (item.tag === 'text' && typeof item.text === 'string') {
        lineParts.push(item.text);
      } else if (item.tag === 'a' && typeof item.text === 'string') {
        lineParts.push(item.href ? `[${item.text}](${item.href})` : item.text);
      } else if (item.tag === 'at' && typeof item.user_name === 'string') {
        lineParts.push(`@${item.user_name}`);
      } else if (item.tag === 'img' && typeof item.image_key === 'string') {
        resources.push({ kind: 'image', fileKey: item.image_key });
      }
    }
    const line = lineParts.join('').trim();
    if (line) parts.push(line);
  }
}

export function extractFeishuInboundContent(
  messageType: string,
  rawContent: string,
  mentions?: FeishuMentionItem[],
): FeishuParsedInbound {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawContent) as Record<string, unknown>;
  } catch {
    const clean = stripFeishuMentions(rawContent, mentions);
    return { text: clean, resources: [] };
  }

  const resources: FeishuInboundResource[] = [];

  switch (messageType) {
    case 'text': {
      const raw = typeof parsed.text === 'string' ? parsed.text : '';
      return { text: stripFeishuMentions(raw, mentions), resources };
    }
    case 'post': {
      const parts: string[] = [];
      if (parsed.zh_cn || parsed.en_us || parsed.ja_jp) {
        parsePostLocale(parsed.zh_cn ?? parsed.en_us ?? parsed.ja_jp, parts, resources);
      } else {
        parsePostLocale(parsed, parts, resources);
      }
      const combined = stripFeishuMentions(parts.join('\n'), mentions);
      return {
        text: combined || (resources.length > 0 ? '[富文本图片消息]' : ''),
        resources,
      };
    }
    case 'image': {
      const imageKey = typeof parsed.image_key === 'string' ? parsed.image_key : '';
      if (imageKey) resources.push({ kind: 'image', fileKey: imageKey });
      return { text: '[用户发送了一张图片]', resources };
    }
    case 'file':
    case 'audio':
    case 'media': {
      const fileKey = typeof parsed.file_key === 'string' ? parsed.file_key : '';
      const fileName = typeof parsed.file_name === 'string' ? parsed.file_name : undefined;
      if (fileKey) {
        resources.push({
          kind: 'file',
          fileKey,
          ...(fileName ? { fileName } : {}),
        });
      }
      return {
        text: fileName ? `[用户发送了文件：${fileName}]` : `[用户发送了${messageType}附件]`,
        resources,
      };
    }
    case 'interactive': {
      const title =
        parsed.title && typeof parsed.title === 'string' ? parsed.title : '卡片消息';
      return { text: `[${title}]`, resources };
    }
    default:
      return { text: `[${messageType} 消息]`, resources };
  }
}

function renderBlockAsMarkdown(block: ChatContentBlock): string {
  switch (block.type) {
    case 'markdown':
      return withoutDesktopMediaUrls(block.text.trim());
    case 'approval':
      return [
        `⚠️ **需要你的授权：${block.title}**`,
        block.body,
        block.tool ? `涉及工具：\`${block.tool}\`` : '',
        '请前往桌面端「对话」点击允许或拒绝。',
      ]
        .filter(Boolean)
        .join('\n\n');
    case 'workflow':
      return [
        `${block.kind === 'question' ? '❓' : '📋'} **${block.title}**`,
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

function hasRichMarkdown(text: string): boolean {
  return /(^#{1,6}\s|```|\*\*|\[[^\]]+\]\([^)]+\)|^[-*]\s|^>\s|\|.+\|)/m.test(text);
}

/**
 * Formats Router response blocks into Feishu interactive Markdown cards (for
 * structured or formatted content) or concise plain text.
 */
export function buildFeishuOutboundMessages(
  blocks?: readonly ChatContentBlock[],
  fallbackText?: string,
): FeishuOutboundMessageSpec[] {
  const renderedBlocks = (blocks ?? [])
    .map((block) => renderBlockAsMarkdown(block))
    .filter((text) => text.length > 0);

  const combined =
    renderedBlocks.length > 0 ? renderedBlocks.join('\n\n') : (fallbackText ?? '').trim();

  if (!combined) return [];

  const hasApproval = blocks?.some((block) => block.type === 'approval') ?? false;
  const hasCardSemantics =
    hasApproval ||
    (blocks?.some((block) => block.type !== 'markdown') ?? false) ||
    hasRichMarkdown(combined) ||
    combined.length > 260;

  if (!hasCardSemantics) {
    return [
      {
        msgType: 'text',
        content: JSON.stringify({ text: combined }),
      },
    ];
  }

  // Feishu card markdown elements are most readable under ~3800 chars per card.
  const MAX_CARD_CHARS = 3800;
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < combined.length) {
    if (combined.length - cursor <= MAX_CARD_CHARS) {
      chunks.push(combined.slice(cursor));
      break;
    }
    let splitAt = combined.lastIndexOf('\n', cursor + MAX_CARD_CHARS);
    if (splitAt <= cursor + MAX_CARD_CHARS / 2) {
      splitAt = cursor + MAX_CARD_CHARS;
    }
    chunks.push(combined.slice(cursor, splitAt).trim());
    cursor = splitAt;
  }

  return chunks.map((chunk, index) => {
    const card: Record<string, unknown> = {
      config: { wide_screen_mode: true, enable_forward: true },
      elements: [
        {
          tag: 'markdown',
          content: chunk,
        },
      ],
    };
    if (index === 0 && hasApproval) {
      card.header = {
        template: 'orange',
        title: { tag: 'plain_text', content: 'Buddy 需要你的授权' },
      };
    }
    return {
      msgType: 'interactive',
      content: JSON.stringify(card),
    };
  });
}

export function mapFeishuFileType(
  fileName: string,
): 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.opus')) return 'opus';
  if (lower.endsWith('.mp4')) return 'mp4';
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.doc') || lower.endsWith('.docx')) return 'doc';
  if (lower.endsWith('.xls') || lower.endsWith('.xlsx')) return 'xls';
  if (lower.endsWith('.ppt') || lower.endsWith('.pptx')) return 'ppt';
  return 'stream';
}
