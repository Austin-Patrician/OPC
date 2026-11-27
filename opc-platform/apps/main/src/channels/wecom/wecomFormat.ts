import path from 'node:path';
import type { ChatContentBlock } from '@opc/shared/domain';
import { withoutDesktopMediaUrls } from '../blockArtifacts';

export const WECOM_MAX_MARKDOWN_BYTES = 3800;
const WECOM_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const WECOM_MAX_FILE_BYTES = 20 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

export type WeComParsedAddress = {
  chatKind: 'p2p' | 'group';
  targetId: string;
};

export function formatWeComAddress(chatKind: 'p2p' | 'group', targetId: string): string {
  return chatKind === 'group' ? `wecom:group:${targetId}` : `wecom:dm:${targetId}`;
}

export function parseWeComAddress(address: string): WeComParsedAddress | null {
  const trimmed = address.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('wecom:dm:')) {
    const targetId = trimmed.slice('wecom:dm:'.length).trim();
    return targetId ? { chatKind: 'p2p', targetId } : null;
  }
  if (trimmed.startsWith('wecom:group:')) {
    const targetId = trimmed.slice('wecom:group:'.length).trim();
    return targetId ? { chatKind: 'group', targetId } : null;
  }
  return null;
}

export function stripWeComAtMention(text: string): string {
  return text
    .replace(/^(?:@[^\s\u2005]+\s*)+/u, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

export function splitUtf8Chunks(
  text: string,
  maxBytes = WECOM_MAX_MARKDOWN_BYTES,
): string[] {
  const normalized = text.trim();
  if (!normalized) return [];
  if (Buffer.byteLength(normalized, 'utf8') <= maxBytes) {
    return [normalized];
  }

  const chunks: string[] = [];
  let rest = normalized;
  while (rest.length > 0) {
    if (Buffer.byteLength(rest, 'utf8') <= maxBytes) {
      const trimmed = rest.trim();
      if (trimmed) chunks.push(trimmed);
      break;
    }

    // Walk by Unicode code point so we never split inside a surrogate pair or multi-byte char.
    const chars = Array.from(rest);
    let byteCount = 0;
    let maxIdx = 0;
    let lastNewlineIdx = -1;
    let newlineBytes = 0;

    for (let i = 0; i < chars.length; i += 1) {
      const ch = chars[i]!;
      const charBytes = Buffer.byteLength(ch, 'utf8');
      if (byteCount + charBytes > maxBytes) {
        break;
      }
      byteCount += charBytes;
      maxIdx = i + 1;
      if (ch === '\n') {
        lastNewlineIdx = i + 1;
        newlineBytes = byteCount;
      }
    }

    if (maxIdx === 0) {
      maxIdx = 1;
    }

    const splitIdx =
      lastNewlineIdx > 0 && newlineBytes >= maxBytes / 2 ? lastNewlineIdx : maxIdx;
    const head = chars.slice(0, splitIdx).join('').trim();
    if (head) chunks.push(head);
    rest = chars.slice(splitIdx).join('').trimStart();
  }

  return chunks;
}

function renderBlockAsWeComMarkdown(block: ChatContentBlock): string {
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

export function buildWeComOutboundMessages(
  blocks?: readonly ChatContentBlock[],
  fallbackText?: string,
): string[] {
  const renderedBlocks = (blocks ?? [])
    .map((block) => renderBlockAsWeComMarkdown(block))
    .filter((text) => text.length > 0);

  const combined =
    renderedBlocks.length > 0
      ? renderedBlocks.join('\n\n')
      : withoutDesktopMediaUrls((fallbackText ?? '').trim()).trim();

  if (!combined) return [];
  return splitUtf8Chunks(combined, WECOM_MAX_MARKDOWN_BYTES);
}

export function detectWeComMediaType(
  filePath: string,
  sizeBytes: number,
): 'image' | 'file' | 'too_large' {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > WECOM_MAX_FILE_BYTES) {
    return 'too_large';
  }
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext) && sizeBytes <= WECOM_MAX_IMAGE_BYTES) {
    return 'image';
  }
  return 'file';
}
