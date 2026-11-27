import path from 'node:path';
import type { ChatContentBlock } from '@opc/shared/domain';
import { withoutDesktopMediaUrls } from '../blockArtifacts';

export const TELEGRAM_MAX_TEXT_CHARS = 3800;

const TELEGRAM_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const TELEGRAM_MAX_FILE_BYTES = 50 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.ogg', '.wav']);
const VIDEO_EXTENSIONS = new Set(['.mp4']);

export type TelegramParsedAddress = {
  chatId: string;
  topicId?: number;
};

export function formatTelegramAddress(chatId: string | number, topicId?: number): string {
  const base = `telegram:chat:${String(chatId).trim()}`;
  if (typeof topicId === 'number' && Number.isInteger(topicId) && topicId > 0) {
    return `${base}:topic:${topicId}`;
  }
  return base;
}

export function parseTelegramAddress(address: string): TelegramParsedAddress | null {
  const trimmed = address.trim();
  const match = /^telegram:chat:(-?\d+)(?::topic:(\d+))?$/.exec(trimmed);
  if (!match) return null;
  const chatId = match[1];
  if (!chatId) return null;
  const topicRaw = match[2];
  if (topicRaw) {
    const topicId = Number(topicRaw);
    if (Number.isInteger(topicId) && topicId > 0) {
      return { chatId, topicId };
    }
  }
  return { chatId };
}

export function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeRegExp(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function hasTelegramBotMention(
  text: string,
  entities: readonly { type?: string; offset?: number; length?: number }[] | undefined,
  botUsername?: string,
): boolean {
  if (!botUsername || !text) return false;
  const handle = `@${botUsername.toLowerCase()}`;
  if (entities?.length) {
    for (const entity of entities) {
      if (
        typeof entity.offset !== 'number' ||
        typeof entity.length !== 'number' ||
        entity.offset < 0 ||
        entity.length <= 0
      ) {
        continue;
      }
      const slice = text.slice(entity.offset, entity.offset + entity.length).toLowerCase();
      if (entity.type === 'mention' && slice === handle) {
        return true;
      }
      if (entity.type === 'bot_command' && slice.endsWith(handle)) {
        return true;
      }
    }
  }
  return new RegExp(`(?:^|\\s|\\/)${escapeRegExp(handle)}(?=$|\\s|[:：,，.!?])`, 'i').test(text);
}

export function stripTelegramBotMention(text: string, botUsername?: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (botUsername) {
    const startRe = new RegExp(`^\\/start(?:@${escapeRegExp(botUsername)})?\\s*$`, 'i');
    if (startRe.test(trimmed)) return '你好';
  } else if (/^\/start\s*$/i.test(trimmed)) {
    return '你好';
  }

  let result = trimmed;
  if (botUsername) {
    const escaped = escapeRegExp(botUsername);
    result = result
      .replace(new RegExp(`(\\/[a-z0-9_]+)@${escaped}(?=\\b|$)`, 'gi'), '$1')
      .replace(new RegExp(`(?:^|\\s)@${escaped}(?=$|\\s|[:：,，.!?])`, 'gi'), ' ');
  }
  return result
    .replace(/[^\S\n]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function convertMarkdownSegmentToHtml(segment: string): string {
  const links: string[] = [];
  const withPlaceholders = segment.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_m, label: string, url: string) => {
      const safeHref = escapeTelegramHtml(url).replace(/"/g, '&quot;');
      const token = `\uFFF0TGLINK${links.length}\uFFF1`;
      links.push(`<a href="${safeHref}">${escapeTelegramHtml(label)}</a>`);
      return token;
    },
  );

  let html = escapeTelegramHtml(withPlaceholders);

  // Convert consecutive > blockquote lines into a single <blockquote>...</blockquote> block.
  html = html.replace(/(?:^&gt;\s?.*(?:\n|$))+/gm, (block) => {
    const inner = block
      .replace(/\n$/, '')
      .split('\n')
      .map((line) => line.replace(/^&gt;\s?/, ''))
      .join('\n');
    return `<blockquote>${inner}</blockquote>\n`;
  });

  // Headings -> bold line
  html = html.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
  // Bold **text** or __text__
  html = html.replace(/\*\*([^\n]+?)\*\*/g, '<b>$1</b>').replace(/__([^\n]+?)__/g, '<b>$1</b>');
  // Strikethrough ~~text~~
  html = html.replace(/~~([^\n]+?)~~/g, '<s>$1</s>');
  // Italic *text*
  html = html.replace(/(?<!\*)\*([^\n*]+?)\*(?!\*)/g, '<i>$1</i>');

  return html.replace(/\uFFF0TGLINK(\d+)\uFFF1/g, (_m, idxRaw: string) => {
    const idx = Number(idxRaw);
    return links[idx] ?? '';
  });
}

/**
 * Converts standard Markdown into Telegram HTML `parse_mode: 'HTML'`, keeping
 * fenced code blocks and inline code spans HTML-escaped and untouched.
 */
export function markdownToTelegramHtml(markdown: string): string {
  const sanitized = withoutDesktopMediaUrls(markdown);
  const parts = sanitized.split(/(```[\s\S]*?```|`[^`\n]+`)/g);

  return parts
    .map((part, idx) => {
      if (idx % 2 === 1) {
        if (part.startsWith('```') && part.endsWith('```')) {
          const inner = part.slice(3, -3);
          const firstNewline = inner.indexOf('\n');
          if (firstNewline >= 0) {
            const lang = inner.slice(0, firstNewline).trim();
            const code = inner.slice(firstNewline + 1).replace(/\n$/, '');
            if (/^[a-zA-Z0-9_+-]+$/.test(lang)) {
              return `<pre><code class="language-${lang}">${escapeTelegramHtml(code)}</code></pre>`;
            }
            return `<pre><code>${escapeTelegramHtml(code)}</code></pre>`;
          }
          return `<pre><code>${escapeTelegramHtml(inner)}</code></pre>`;
        }
        return `<code>${escapeTelegramHtml(part.slice(1, -1))}</code>`;
      }
      return convertMarkdownSegmentToHtml(part);
    })
    .join('')
    .trim();
}

export function splitMarkdownChunks(
  text: string,
  maxChars = TELEGRAM_MAX_TEXT_CHARS,
): string[] {
  const normalized = text.trim();
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];

  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < normalized.length) {
    if (normalized.length - cursor <= maxChars) {
      const tail = normalized.slice(cursor).trim();
      if (tail) chunks.push(tail);
      break;
    }

    let splitAt = normalized.lastIndexOf('\n\n', cursor + maxChars);
    if (splitAt <= cursor + maxChars / 2) {
      splitAt = normalized.lastIndexOf('\n', cursor + maxChars);
    }
    if (splitAt <= cursor + maxChars / 2) {
      splitAt = cursor + maxChars;
    }

    const head = normalized.slice(cursor, splitAt).trim();
    if (head) chunks.push(head);
    cursor = splitAt;
  }

  return chunks;
}

function renderBlockAsMarkdown(block: ChatContentBlock): string {
  switch (block.type) {
    case 'markdown':
      return withoutDesktopMediaUrls(block.text).trim();
    case 'approval':
      return [
        `> ⚠️ **需要你的授权：${block.title}**`,
        withoutDesktopMediaUrls(block.body).trim(),
        block.tool ? `涉及工具：\`${block.tool}\`` : '',
        '> 请前往桌面端「对话」点击允许或拒绝。',
      ]
        .filter(Boolean)
        .join('\n\n');
    case 'workflow':
      return [
        `${block.kind === 'question' ? '❓' : '📋'} **${block.title}**`,
        withoutDesktopMediaUrls(block.body).trim(),
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

export function buildTelegramOutboundMessages(
  blocks?: readonly ChatContentBlock[],
  fallbackText?: string,
): Array<{ html: string; plain: string }> {
  const renderedBlocks = (blocks ?? [])
    .map((block) => renderBlockAsMarkdown(block))
    .filter((text) => text.length > 0);

  const combined =
    renderedBlocks.length > 0
      ? renderedBlocks.join('\n\n')
      : withoutDesktopMediaUrls((fallbackText ?? '').trim()).trim();

  if (!combined) return [];
  return splitMarkdownChunks(combined, TELEGRAM_MAX_TEXT_CHARS).map((chunk) => ({
    html: markdownToTelegramHtml(chunk),
    plain: chunk,
  }));
}

export type TelegramMediaMethod =
  | 'sendPhoto'
  | 'sendAudio'
  | 'sendVideo'
  | 'sendDocument'
  | 'too_large';

export function detectTelegramMediaMethod(
  filePath: string,
  sizeBytes: number,
): TelegramMediaMethod {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > TELEGRAM_MAX_FILE_BYTES) {
    return 'too_large';
  }
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext) && sizeBytes <= TELEGRAM_MAX_IMAGE_BYTES) {
    return 'sendPhoto';
  }
  if (AUDIO_EXTENSIONS.has(ext)) {
    return 'sendAudio';
  }
  if (VIDEO_EXTENSIONS.has(ext)) {
    return 'sendVideo';
  }
  return 'sendDocument';
}
