import fs from 'node:fs';
import path from 'node:path';
import type { MemoryDocCategory, MemorySearchHit } from '@opc/shared/ipc';
import type { MarkdownMemoryStore } from './markdownMemoryStore';
import { extractH1Title } from './markdownMemoryStore';

interface IndexedChunk {
  id: string;
  relPath: string;
  category: MemoryDocCategory;
  docTitle: string;
  sectionTitle: string;
  body: string;
  updatedAt: number;
  tokens: string[];
  tf: Map<string, number>;
  headingTokens: Set<string>;
}

interface CachedFileEntry {
  mtimeMs: number;
  size: number;
  chunks: IndexedChunk[];
}

/**
 * Pure in-memory BM25 + CJK 2-gram + heading-boost index over `<userData>/memory/*.md`.
 * Zero SQLite dependencies; checks file `mtimeMs` on every read so external edits in
 * VS Code / Obsidian take effect immediately.
 */
export class MemorySearchIndex {
  private readonly cache = new Map<string, CachedFileEntry>();

  constructor(private readonly store: MarkdownMemoryStore) {}

  refresh(): void {
    this.store.ensureInitialized();
    const docs = this.store.listDocs();
    const activePaths = new Set<string>();
    const rootDir = this.store.getRootDir();

    for (const doc of docs) {
      activePaths.add(doc.relPath);
      const fullPath = path.resolve(rootDir, doc.relPath);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        this.cache.delete(doc.relPath);
        continue;
      }
      const cached = this.cache.get(doc.relPath);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        continue;
      }
      const content = fs.readFileSync(fullPath, 'utf8');
      const chunks = parseMarkdownChunks(
        doc.relPath,
        doc.category,
        content,
        stat.mtimeMs,
      );
      this.cache.set(doc.relPath, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        chunks,
      });
    }

    for (const key of this.cache.keys()) {
      if (!activePaths.has(key)) {
        this.cache.delete(key);
      }
    }
  }

  search(
    query: string,
    options: { categories?: readonly MemoryDocCategory[]; limit?: number; minScore?: number } = {},
  ): MemorySearchHit[] {
    this.refresh();
    const cleanQuery = query.trim();
    if (!cleanQuery) return [];

    const limit = options.limit ?? 8;
    const minScore = options.minScore ?? 0.3;
    const allowed = options.categories ? new Set(options.categories) : null;

    const allChunks: IndexedChunk[] = [];
    for (const entry of this.cache.values()) {
      for (const chunk of entry.chunks) {
        if (!allowed || allowed.has(chunk.category)) {
          allChunks.push(chunk);
        }
      }
    }
    if (allChunks.length === 0) return [];

    const queryTokens = tokenizeForSearch(cleanQuery);
    if (queryTokens.length === 0) return [];

    const avgLen =
      allChunks.reduce((sum, chunk) => sum + chunk.tokens.length, 0) / Math.max(allChunks.length, 1);

    const df = new Map<string, number>();
    const uniqueQueryTokens = [...new Set(queryTokens)];
    for (const qt of uniqueQueryTokens) {
      let count = 0;
      for (const chunk of allChunks) {
        if (chunk.tf.has(qt) || chunk.headingTokens.has(qt)) count += 1;
      }
      df.set(qt, count);
    }

    const n = allChunks.length;
    const k1 = 1.5;
    const b = 0.75;
    const queryLower = cleanQuery.toLowerCase();
    const scored: MemorySearchHit[] = [];

    for (const chunk of allChunks) {
      let score = 0;
      const docLen = Math.max(chunk.tokens.length, 1);

      for (const qt of uniqueQueryTokens) {
        const docFreq = df.get(qt) ?? 0;
        if (docFreq === 0) continue;
        // Floor IDF at 0.45 so small personal corpora (n = 1..5 chunks) still surface keyword hits.
        const idf = Math.max(0.45, Math.log(1 + (n - docFreq + 0.5) / (docFreq + 0.5)));
        const freq = chunk.tf.get(qt) ?? 0;
        if (freq > 0) {
          const tfNorm = (freq * (k1 + 1)) / (freq + k1 * (1 - b + (b * docLen) / Math.max(avgLen, 1)));
          score += idf * tfNorm;
        }
        if (chunk.headingTokens.has(qt)) {
          score += idf * 1.35;
        }
      }

      if (queryLower.length >= 2) {
        if (chunk.sectionTitle.toLowerCase().includes(queryLower) || chunk.docTitle.toLowerCase().includes(queryLower)) {
          score += 2.5;
        } else if (chunk.body.toLowerCase().includes(queryLower)) {
          score += 1.5;
        }
      }

      if (score < minScore) continue;
      scored.push({
        id: chunk.id,
        relPath: chunk.relPath,
        category: chunk.category,
        docTitle: chunk.docTitle,
        sectionTitle: chunk.sectionTitle,
        snippet: compactSnippet(chunk.body),
        score: Number(score.toFixed(3)),
        updatedAt: chunk.updatedAt,
      });
    }

    scored.sort((a, bHit) => bHit.score - a.score || bHit.updatedAt - a.updatedAt);
    return scored.slice(0, limit);
  }

  matchPlaybook(query: string, limit = 4): MemorySearchHit[] {
    return this.search(query, {
      categories: ['playbook'],
      limit,
      minScore: 0.45,
    });
  }

  recallForRouter(query: string): {
    playbook: MemorySearchHit[];
    snippets: MemorySearchHit[];
  } {
    const playbook = this.matchPlaybook(query, 2);
    const snippets = this.search(query, {
      categories: ['topic', 'daily', 'user'],
      limit: 3,
      minScore: 0.45,
    });
    return { playbook, snippets };
  }

  recallForWorker(query: string): {
    playbook: MemorySearchHit[];
    topics: MemorySearchHit[];
  } {
    const playbook = this.matchPlaybook(query, 4);
    const topics = this.search(query, {
      categories: ['topic'],
      limit: 3,
      minScore: 0.45,
    });
    return { playbook, topics };
  }

  readByRef(rawRef: string): string | null {
    this.store.ensureInitialized();
    const trimmed = rawRef.trim();
    const withoutPrefix = trimmed.startsWith('memory:') ? trimmed.slice('memory:'.length) : trimmed;
    const hashIdx = withoutPrefix.indexOf('#');
    const relPath = hashIdx >= 0 ? withoutPrefix.slice(0, hashIdx) : withoutPrefix;
    const anchor = hashIdx >= 0 ? withoutPrefix.slice(hashIdx + 1).trim() : '';

    let detail: ReturnType<MarkdownMemoryStore['readDoc']>;
    try {
      detail = this.store.readDoc(relPath);
    } catch {
      return null;
    }

    if (!anchor) return detail.content;

    if (detail.relPath === 'RULES.md' && /^\d+$/.test(anchor)) {
      const idx = Number(anchor) - 1;
      const rules = this.store.listRules();
      if (idx >= 0 && idx < rules.length) {
        return `RULES.md#${anchor}: ${rules[idx]}`;
      }
    }

    this.refresh();
    const cached = this.cache.get(detail.relPath);
    if (cached) {
      const found = cached.chunks.find(
        (c) => c.sectionTitle.toLowerCase() === anchor.toLowerCase() || c.sectionTitle.includes(anchor),
      );
      if (found) return `## ${found.sectionTitle}\n${found.body}`;
    }

    return detail.content;
  }
}

// ── Chunking & Hybrid Chinese/English Tokenization ─────────────────────────

function parseMarkdownChunks(
  relPath: string,
  category: MemoryDocCategory,
  markdown: string,
  updatedAt: number,
): IndexedChunk[] {
  const docTitle = extractH1Title(markdown) ?? path.basename(relPath, '.md');
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const rawSections: { title: string; lines: string[] }[] = [];
  let current: { title: string; lines: string[] } = { title: docTitle, lines: [] };

  for (const line of lines) {
    const h2 = /^##\s+(.+)$/.exec(line.trim());
    if (h2) {
      if (current.lines.length > 0) rawSections.push(current);
      current = { title: h2[1]!.trim(), lines: [] };
      continue;
    }
    if (line.trim().startsWith('# ')) continue;
    current.lines.push(line);
  }
  if (current.lines.length > 0) rawSections.push(current);

  const chunks: IndexedChunk[] = [];
  for (const section of rawSections) {
    const cleanedBody = section.lines
      .filter((line) => !line.trim().startsWith('<!--'))
      .join('\n')
      .trim();
    if (!cleanedBody) continue;

    const tokens = tokenizeForSearch(cleanedBody);
    const tf = new Map<string, number>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }
    const headingTokens = new Set(tokenizeForSearch(`${docTitle} ${section.title}`));
    const id =
      section.title === docTitle
        ? `memory:${relPath}`
        : `memory:${relPath}#${section.title}`;

    chunks.push({
      id,
      relPath,
      category,
      docTitle,
      sectionTitle: section.title,
      body: cleanedBody,
      updatedAt,
      tokens,
      tf,
      headingTokens,
    });
  }
  return chunks;
}

export function tokenizeForSearch(raw: string): string[] {
  const tokens: string[] = [];
  const lower = raw.toLowerCase();

  // Latin / numeric / code / path tokens
  for (const match of lower.matchAll(/[a-z0-9_./-]{2,}/g)) {
    const word = match[0].replace(/^[./_-]+|[./_-]+$/g, '');
    if (word.length >= 2) tokens.push(word);
  }

  // CJK contiguous sequences -> 2-grams (or 1-char if length === 1) + 3-grams
  for (const match of lower.matchAll(/[\u4e00-\u9fa5]+/g)) {
    const seq = match[0];
    if (seq.length === 1) {
      tokens.push(seq);
      continue;
    }
    for (let i = 0; i < seq.length - 1; i += 1) {
      tokens.push(seq.slice(i, i + 2));
    }
    if (seq.length >= 3) {
      for (let i = 0; i < seq.length - 2; i += 1) {
        tokens.push(seq.slice(i, i + 3));
      }
    }
  }

  return tokens;
}

function compactSnippet(body: string, maxChars = 280): string {
  const collapsed = body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' / ');
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, maxChars - 1)}…`;
}
