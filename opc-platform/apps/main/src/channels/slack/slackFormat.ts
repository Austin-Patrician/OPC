import type { ChatContentBlock } from '@opc/shared/domain';
import { withoutDesktopMediaUrls } from '../blockArtifacts';

const SLACK_MAX_TEXT_CHARS = 3800;

export function formatSlackAddress(channelId: string): string {
  return `slack:channel:${channelId}`;
}

export function parseSlackAddress(address: string): string | null {
  const trimmed = address.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('slack:channel:')) {
    const id = trimmed.slice('slack:channel:'.length).trim();
    return id || null;
  }
  if (/^[CDG][A-Z0-9]{8,}$/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

export function stripSlackBotMention(text: string, botUserId?: string): string {
  let result = text;
  if (botUserId) {
    const escaped = botUserId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`<@${escaped}(?:\\|[^>]+)?>`, 'g'), '');
  } else {
    result = result.replace(/^<@[A-Z0-9]+(?:\|[^>]+)?>\s*/i, '');
  }
  return result.replace(/[^\S\n]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
}

function convertInlineSegment(segment: string): string {
  let text = segment;
  // Links: [label](url) -> <url|label> (handles http/https links cleanly).
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>');
  // Headings at start of line -> *Heading*
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');
  // Bold **text** or __text__ -> *text*
  text = text.replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/__(.+?)__/g, '*$1*');
  // Strikethrough ~~text~~ -> ~text~
  text = text.replace(/~~(.+?)~~/g, '~$1~');
  return text;
}

/**
 * Converts standard Markdown into Slack `mrkdwn`, preserving fenced code blocks
 * and inline code spans verbatim.
 */
export function markdownToSlackMrkdwn(markdown: string): string {
  const sanitized = withoutDesktopMediaUrls(markdown);
  const parts = sanitized.split(/(```[\s\S]*?```|`[^`\n]+`)/g);
  return parts
    .map((part, idx) => {
      // Odd indices matched code fences / inline code and must remain untouched.
      if (idx % 2 === 1) return part;
      return convertInlineSegment(part);
    })
    .join('')
    .trim();
}

function renderBlockAsMrkdwn(block: ChatContentBlock): string {
  switch (block.type) {
    case 'markdown':
      return markdownToSlackMrkdwn(block.text.trim());
    case 'approval':
      return [
        `⚠️ *需要你的授权：${block.title}*`,
        markdownToSlackMrkdwn(block.body),
        block.tool ? `涉及工具：\`${block.tool}\`` : '',
        '> 请前往桌面端「对话」点击允许或拒绝。',
      ]
        .filter(Boolean)
        .join('\n\n');
    case 'workflow':
      return [
        `${block.kind === 'question' ? '❓' : '📋'} *${block.title}*`,
        markdownToSlackMrkdwn(block.body),
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
            return `<${url.href}|${label}>`;
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

export function buildSlackOutboundMessages(
  blocks?: readonly ChatContentBlock[],
  fallbackText?: string,
): string[] {
  const renderedBlocks = (blocks ?? [])
    .map((block) => renderBlockAsMrkdwn(block))
    .filter((text) => text.length > 0);

  const combined =
    renderedBlocks.length > 0
      ? renderedBlocks.join('\n\n')
      : markdownToSlackMrkdwn((fallbackText ?? '').trim());

  if (!combined) return [];

  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < combined.length) {
    if (combined.length - cursor <= SLACK_MAX_TEXT_CHARS) {
      chunks.push(combined.slice(cursor));
      break;
    }
    let splitAt = combined.lastIndexOf('\n', cursor + SLACK_MAX_TEXT_CHARS);
    if (splitAt <= cursor + SLACK_MAX_TEXT_CHARS / 2) {
      splitAt = cursor + SLACK_MAX_TEXT_CHARS;
    }
    chunks.push(combined.slice(cursor, splitAt).trim());
    cursor = splitAt;
  }

  return chunks.filter((chunk) => chunk.length > 0);
}
