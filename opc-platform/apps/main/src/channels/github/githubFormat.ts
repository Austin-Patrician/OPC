import path from 'node:path';
import type { ChatContentBlock } from '@opc/shared/domain';
import { withoutDesktopMediaUrls } from '../blockArtifacts';

export const GITHUB_MAX_COMMENT_CHARS = 60_000;
export const GITHUB_BOT_REPLY_MARKER = '<!-- opc-buddy-reply -->';

export interface GitHubParsedAddress {
  owner: string;
  repo: string;
  fullRepo: string;
  number: number;
}

export function formatGitHubAddress(ownerOrRepo: string, number: number): string {
  return `github:${ownerOrRepo.trim()}#${number}`;
}

export function parseGitHubAddress(address: string): GitHubParsedAddress | null {
  const trimmed = address.trim();
  const match = /^github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/.exec(trimmed);
  if (!match) return null;
  const owner = match[1];
  const repo = match[2];
  const numRaw = match[3];
  if (!owner || !repo || !numRaw) return null;
  const number = Number(numRaw);
  if (!Number.isInteger(number) || number <= 0) return null;
  return {
    owner,
    repo,
    fullRepo: `${owner}/${repo}`,
    number,
  };
}

export function parseGitHubRepoName(
  raw: string,
): { owner: string; repo: string; fullRepo: string } | null {
  const cleaned = raw
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '');
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(cleaned);
  if (!match) return null;
  const owner = match[1];
  const repo = match[2];
  if (!owner || !repo) return null;
  return { owner, repo, fullRepo: `${owner}/${repo}` };
}

export function matchesGitHubRepoPattern(
  fullRepo: string,
  patterns: readonly string[],
): boolean {
  if (patterns.length === 0) return true;
  const normalized = fullRepo.trim().toLowerCase();
  const [owner] = normalized.split('/');
  for (const rawPattern of patterns) {
    const pattern = rawPattern.trim().toLowerCase();
    if (!pattern) continue;
    if (pattern === normalized) return true;
    if (pattern.endsWith('/*') && owner && pattern.slice(0, -2) === owner) {
      return true;
    }
  }
  return false;
}

export function isSelfBotReply(body: string): boolean {
  return body.includes(GITHUB_BOT_REPLY_MARKER);
}

function escapeRegExp(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function hasWakeWord(text: string, wakeWord: string): boolean {
  const word = wakeWord.trim();
  if (!word || !text) return false;
  const re = new RegExp(`(?:^|\\s)${escapeRegExp(word)}(?=$|\\s|[:：,，.!?])`, 'iu');
  return re.test(text);
}

export function stripWakeWord(text: string, wakeWord: string): string {
  const word = wakeWord.trim();
  if (!word) return text.trim();
  const re = new RegExp(`(?:^|\\s)${escapeRegExp(word)}(?=$|\\s|[:：,，.!?])`, 'giu');
  return text
    .replace(re, ' ')
    .replace(/[^\S\n]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

export function stripGitHubMention(text: string, selfLogin?: string): string {
  let result = text;
  if (selfLogin) {
    const re = new RegExp(`(?:^|\\s)@${escapeRegExp(selfLogin)}(?=$|\\s|[:：,，.!?])`, 'giu');
    result = result.replace(re, ' ');
  }
  return result
    .replace(/[^\S\n]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function renderBlockAsGfm(block: ChatContentBlock): string {
  switch (block.type) {
    case 'markdown':
      return withoutDesktopMediaUrls(block.text).trim();
    case 'approval':
      return [
        `> ⚠️ **需要你的授权：${block.title}**`,
        withoutDesktopMediaUrls(block.body).trim(),
        block.tool ? `涉及工具：\`${block.tool}\`` : '',
        '> 请前往 Buddy 桌面端「对话」点击允许或拒绝。',
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

export function buildGitHubOutboundMessages(
  blocks?: readonly ChatContentBlock[],
  fallbackText?: string,
  attachments?: readonly { name?: string; path: string }[],
): string[] {
  const renderedBlocks = (blocks ?? [])
    .map((block) => renderBlockAsGfm(block))
    .filter((text) => text.length > 0);

  let combined =
    renderedBlocks.length > 0
      ? renderedBlocks.join('\n\n')
      : withoutDesktopMediaUrls((fallbackText ?? '').trim()).trim();

  if (attachments && attachments.length > 0) {
    const attachmentNames = attachments
      .map((item) => `\`${item.name || path.basename(item.path)}\``)
      .join('、');
    const attachmentNote = `> 📎 桌面工作区已生成附件：${attachmentNames}（请在 OPC 桌面端查看或下载）。`;
    combined = combined ? `${combined}\n\n${attachmentNote}` : attachmentNote;
  }

  if (!combined) return [];

  const maxBodyChars = GITHUB_MAX_COMMENT_CHARS - GITHUB_BOT_REPLY_MARKER.length - 4;
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < combined.length) {
    if (combined.length - cursor <= maxBodyChars) {
      chunks.push(`${combined.slice(cursor).trim()}\n\n${GITHUB_BOT_REPLY_MARKER}`);
      break;
    }
    let splitAt = combined.lastIndexOf('\n\n', cursor + maxBodyChars);
    if (splitAt <= cursor + maxBodyChars / 2) {
      splitAt = combined.lastIndexOf('\n', cursor + maxBodyChars);
    }
    if (splitAt <= cursor + maxBodyChars / 2) {
      splitAt = cursor + maxBodyChars;
    }
    const piece = combined.slice(cursor, splitAt).trim();
    if (piece) {
      chunks.push(`${piece}\n\n${GITHUB_BOT_REPLY_MARKER}`);
    }
    cursor = splitAt;
  }

  return chunks;
}
