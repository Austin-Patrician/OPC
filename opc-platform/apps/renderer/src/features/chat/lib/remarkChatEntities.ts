import { tokenizeProseEntities } from '@/shared/lib/chatEntities';

interface MdastNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdastNode[];
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
  };
}

const SKIP_PARENTS = new Set([
  'link',
  'linkReference',
  'code',
  'inlineCode',
  'html',
  'image',
  'imageReference',
  'definition',
]);

export type MarkdownCalloutKind = 'note' | 'tip' | 'important' | 'warning' | 'caution';

const CALLOUT_TAG_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\s*\n?|\s+)?/i;

function encodeFileHref(rawPath: string): string {
  return `opc-file://local?path=${encodeURIComponent(rawPath)}`;
}

export function decodeFileHref(href?: string): string | null {
  if (!href || !href.startsWith('opc-file://local?')) return null;
  try {
    const parsed = new URL(href);
    const decoded = parsed.searchParams.get('path');
    return decoded ? decoded : null;
  } catch {
    return null;
  }
}

/** Transforms Markdown URLs while allowing safe `opc-file://`, `file://`, and `mailto:` hrefs. */
export function transformMarkdownUrl(url: string, key?: string): string {
  const trimmed = url.trim();
  if (/^(?:https?:|mailto:|file:|opc-file:)/i.test(trimmed)) {
    return key === 'href' || /^https?:/i.test(trimmed) ? trimmed : '';
  }
  // Allow relative fragment/anchor links; block unsafe scriptable protocols.
  if (trimmed.startsWith('#') || trimmed.startsWith('/')) return trimmed;
  return '';
}

function transformBlockquoteCallout(node: MdastNode): void {
  if (node.type !== 'blockquote' || !node.children?.length) return;
  const firstParagraph = node.children[0];
  if (!firstParagraph || firstParagraph.type !== 'paragraph' || !firstParagraph.children?.length) {
    return;
  }
  const firstChild = firstParagraph.children[0];
  if (!firstChild || firstChild.type !== 'text' || typeof firstChild.value !== 'string') {
    return;
  }

  const match = CALLOUT_TAG_RE.exec(firstChild.value);
  if (!match?.[1]) return;

  const kind = match[1].toLowerCase() as MarkdownCalloutKind;
  const rest = firstChild.value.slice(match[0].length);
  if (rest) {
    firstChild.value = rest;
  } else {
    firstParagraph.children.shift();
    // If `[!NOTE]` stood alone followed by `<br>` / soft break, drop leading break node cleanly.
    const nextNode = firstParagraph.children[0];
    if (nextNode?.type === 'break') {
      firstParagraph.children.shift();
    }
    if (firstParagraph.children.length === 0) {
      node.children.shift();
    }
  }

  node.data = {
    ...node.data,
    hProperties: {
      ...node.data?.hProperties,
      'data-callout': kind,
    },
  };
}

function splitTextNode(node: MdastNode): MdastNode[] | null {
  if (node.type !== 'text' || typeof node.value !== 'string' || !node.value) return null;
  const segments = tokenizeProseEntities(node.value, { enableMentions: false });
  if (segments.length === 0 || (segments.length === 1 && segments[0]?.type === 'text')) {
    return null;
  }

  return segments.map((segment): MdastNode => {
    if (segment.type === 'link') {
      return {
        type: 'link',
        url: segment.href,
        children: [{ type: 'text', value: segment.value }],
      };
    }
    if (segment.type === 'email') {
      return {
        type: 'link',
        url: segment.href,
        children: [{ type: 'text', value: segment.value }],
      };
    }
    if (segment.type === 'file') {
      return {
        type: 'link',
        url: encodeFileHref(segment.file.raw),
        children: [{ type: 'text', value: segment.value }],
      };
    }
    return { type: 'text', value: segment.value };
  });
}

function walkMdast(node: MdastNode): void {
  if (node.type === 'blockquote') {
    transformBlockquoteCallout(node);
  }
  if (!node.children || SKIP_PARENTS.has(node.type)) return;

  const nextChildren: MdastNode[] = [];
  let changed = false;

  for (const child of node.children) {
    if (child.type === 'text') {
      const replacement = splitTextNode(child);
      if (replacement) {
        nextChildren.push(...replacement);
        changed = true;
        continue;
      }
      nextChildren.push(child);
      continue;
    }

    walkMdast(child);
    nextChildren.push(child);
  }

  if (changed) {
    node.children = nextChildren;
  }
}

/**
 * Zero-dependency remark plugin that enriches plain Markdown prose with clickable
 * file paths, bare emails, normalized URLs, and GitHub-style `[!NOTE]` / `[!WARNING]` callouts.
 */
export function remarkChatEntities() {
  return (tree: MdastNode) => {
    walkMdast(tree);
  };
}
