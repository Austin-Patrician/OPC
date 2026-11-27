import {
  defineExtension,
  GenerationTask,
  hook,
  type CompactionPolicy,
  type CompactionSettings as HarnessCompactionSettings,
  type ContextEdit,
  type ContextView,
} from '@earendil-works/pi-durable';
import type { CompactionSettings as DomainCompactionSettings, ProviderConfig } from '@opc/shared/domain';

export const DEFAULT_MAX_INLINE_TOOL_IMAGES = 2;
export const DEFAULT_MAX_TOTAL_IMAGE_BASE64_BYTES = 800 * 1024;
export const WORKER_SOFT_COMPACT_TOKENS = 90_000;
export const PIVOT_COMPACT_TOKENS = 24_000;
export const MIN_COMPACT_HEADROOM = 24_000;

const SINGLE_IMAGE_HARD_MAX_BYTES = 4.5 * 1024 * 1024;
const FIXED_IMAGE_ESTIMATE_TOKENS = 1_600;

export type ContextMessage = ContextView['messages'][number];

interface ToolCallBlockLike {
  type: 'toolCall';
  id: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

interface ImageBlockLike {
  type: 'image';
  data?: string;
  mimeType?: string;
}

interface TextBlockLike {
  type: 'text';
  text: string;
}

type ToolResultMessageLike = Extract<ContextMessage, { role: 'toolResult' }>;

export interface PruneToolImagesOptions {
  /** Maximum number of recent tool-result images kept inline per request. Default 2. */
  maxImages?: number;
  /** Maximum cumulative base64 bytes across retained inline tool images. Default 800 KiB. */
  maxTotalBase64Bytes?: number;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function extractPathHintFromArgs(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  for (const key of ['path', 'file_path', 'filePath', 'filename'] as const) {
    const val = args[key];
    if (typeof val === 'string' && val.trim()) {
      return val.trim();
    }
  }
  return undefined;
}

function buildCallPathMap(messages: readonly ContextMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isObjectRecord(block) || block.type !== 'toolCall') continue;
      const tc = block as unknown as ToolCallBlockLike;
      if (typeof tc.id !== 'string' || !tc.id) continue;
      const hint = extractPathHintFromArgs(isObjectRecord(tc.arguments) ? tc.arguments : undefined);
      if (hint) map.set(tc.id, hint);
    }
  }
  return map;
}

function isImageBlock(block: unknown): block is ImageBlockLike {
  return isObjectRecord(block) && block.type === 'image';
}

function imageBlockBase64Bytes(block: ImageBlockLike): number {
  return typeof block.data === 'string' ? block.data.length : 0;
}

function makeInlineEvictedPlaceholder(pathHint: string | undefined): TextBlockLike {
  return {
    type: 'text',
    text: pathHint
      ? `[历史图片已从上下文卸载（${pathHint}），如需复查请重新 read]`
      : '[历史图片已从上下文卸载，如需复查请重新 read]',
  };
}

function makeCrossTurnEvictedPlaceholder(pathHint: string | undefined): TextBlockLike {
  return {
    type: 'text',
    text: pathHint
      ? `[上一轮任务已查看的图片已卸载（${pathHint}），工作区文件仍保留，如需复查可重新 read]`
      : '[上一轮任务已查看的图片已卸载，工作区文件仍保留，如需复查可重新 read]',
  };
}

/**
 * Replaces older `toolResult` image blocks with lightweight text placeholders before each
 * model request, keeping only the most recent `maxImages` images within `maxTotalBase64Bytes`.
 * Never mutates the input array or `user` message attachments.
 */
export function pruneToolImagesInMessages(
  messages: readonly ContextMessage[],
  options: PruneToolImagesOptions = {},
): readonly ContextMessage[] | undefined {
  const maxImages = Math.max(0, options.maxImages ?? DEFAULT_MAX_INLINE_TOOL_IMAGES);
  const maxTotalBytes = Math.max(0, options.maxTotalBase64Bytes ?? DEFAULT_MAX_TOTAL_IMAGE_BASE64_BYTES);

  const occurrences: Array<{ msgIndex: number; blockIndex: number; bytes: number }> = [];
  for (let msgIndex = 0; msgIndex < messages.length; msgIndex += 1) {
    const message = messages[msgIndex];
    if (!message || message.role !== 'toolResult' || !Array.isArray(message.content)) continue;
    for (let blockIndex = 0; blockIndex < message.content.length; blockIndex += 1) {
      const block = message.content[blockIndex];
      if (!isImageBlock(block)) continue;
      occurrences.push({ msgIndex, blockIndex, bytes: imageBlockBase64Bytes(block) });
    }
  }

  if (occurrences.length === 0) return undefined;

  const keptKeys = new Set<string>();
  let keptCount = 0;
  let keptBytes = 0;
  for (let i = occurrences.length - 1; i >= 0; i -= 1) {
    const item = occurrences[i]!;
    if (keptCount >= maxImages) continue;
    const isNewest = keptCount === 0;
    const fitsBudget = keptBytes + item.bytes <= maxTotalBytes;
    const fitsNewestSingle = isNewest && item.bytes <= SINGLE_IMAGE_HARD_MAX_BYTES;
    if (fitsBudget || fitsNewestSingle) {
      keptKeys.add(`${item.msgIndex}:${item.blockIndex}`);
      keptCount += 1;
      keptBytes += item.bytes;
    }
  }

  if (keptKeys.size === occurrences.length) return undefined;

  const callPathById = buildCallPathMap(messages);
  const evictedByMsg = new Map<number, Set<number>>();
  for (const item of occurrences) {
    const key = `${item.msgIndex}:${item.blockIndex}`;
    if (keptKeys.has(key)) continue;
    let set = evictedByMsg.get(item.msgIndex);
    if (!set) {
      set = new Set<number>();
      evictedByMsg.set(item.msgIndex, set);
    }
    set.add(item.blockIndex);
  }

  return messages.map((message, msgIndex) => {
    const evictedBlocks = evictedByMsg.get(msgIndex);
    if (!evictedBlocks || message.role !== 'toolResult' || !Array.isArray(message.content)) {
      return message;
    }
    const pathHint = callPathById.get(message.toolCallId);
    const nextContent = message.content.map((block, blockIndex) =>
      evictedBlocks.has(blockIndex) ? (makeInlineEvictedPlaceholder(pathHint) as never) : block,
    );
    return { ...message, content: nextContent };
  });
}

/**
 * Installs a `beforeRequest` GenerationTask hook that keeps recent tool images bounded
 * per LLM request while preserving persisted entries verbatim.
 */
export function createWorkerContextHygieneExtension(options: PruneToolImagesOptions = {}) {
  return defineExtension({
    name: 'opc.context-hygiene',
    hooks: [
      hook(GenerationTask, {
        beforeRequest: ({ messages }) => {
          const pruned = pruneToolImagesInMessages(messages, options);
          return pruned ? { messages: pruned } : undefined;
        },
      }),
    ],
  });
}

/**
 * Builds non-destructive `ContextEdit` replacements to evict active tool-result images
 * from earlier turns before starting a warm reuse / pivot turn. Inspects `view.contributions`
 * so already-evicted entries are never emitted a second time.
 */
export function buildCrossTurnImageEvictionEdits(view: ContextView): ContextEdit[] {
  const allMessages = [...view.messages, ...view.contributions.flat()];
  const callPathById = buildCallPathMap(allMessages);
  const edits: ContextEdit[] = [];

  for (let i = 0; i < view.entries.length; i += 1) {
    const entry = view.entries[i];
    const contributed = view.contributions[i];
    if (!entry || !contributed || contributed.length === 0) continue;

    let hasActiveToolImage = false;
    for (const msg of contributed) {
      if (msg.role === 'toolResult' && Array.isArray(msg.content) && msg.content.some(isImageBlock)) {
        hasActiveToolImage = true;
        break;
      }
    }
    if (!hasActiveToolImage) continue;

    const replacedMessages: ContextMessage[] = contributed.map((msg) => {
      if (msg.role !== 'toolResult' || !Array.isArray(msg.content) || !msg.content.some(isImageBlock)) {
        return msg;
      }
      const toolMsg = msg as ToolResultMessageLike;
      const pathHint = callPathById.get(toolMsg.toolCallId);
      const nextContent = toolMsg.content.map((block) =>
        isImageBlock(block) ? (makeCrossTurnEvictedPlaceholder(pathHint) as never) : block,
      );
      return {
        ...toolMsg,
        content: nextContent,
      };
    });

    edits.push({
      target: entry.id,
      action: 'replace',
      messages: replacedMessages,
    });
  }

  return edits;
}

function estimateSingleMessageTokens(message: ContextMessage): number {
  if (message.role === 'user') {
    if (typeof message.content === 'string') {
      return Math.ceil(message.content.length / 3);
    }
    let tokens = 0;
    for (const block of message.content) {
      if (isImageBlock(block)) tokens += FIXED_IMAGE_ESTIMATE_TOKENS;
      else tokens += Math.ceil(JSON.stringify(block).length / 3);
    }
    return tokens;
  }

  if (message.role === 'toolResult') {
    let tokens = 24;
    for (const block of message.content) {
      if (isImageBlock(block)) tokens += FIXED_IMAGE_ESTIMATE_TOKENS;
      else tokens += Math.ceil(JSON.stringify(block).length / 3);
    }
    return tokens;
  }

  if (message.role === 'assistant') {
    let tokens = 24;
    for (const block of message.content) {
      tokens += Math.ceil(JSON.stringify(block).length / 3);
    }
    return tokens;
  }

  try {
    return Math.ceil(JSON.stringify(message).length / 3);
  } catch {
    return 64;
  }
}

function measuredUsageTokens(message: ContextMessage): number {
  if (message.role !== 'assistant' || !message.usage) return 0;
  const usage = message.usage;
  const sum = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.output ?? 0);
  if (sum > 0) return sum;
  return usage.totalTokens ?? 0;
}

/**
 * Estimates total active context tokens in `view`, anchoring on the latest assistant
 * usage report and adding non-image deltas plus a fixed visual token cost per image.
 */
export function estimateActiveContextTokens(view: ContextView): number {
  const { messages } = view;
  let anchorIndex = -1;
  let baseTokens = 0;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const measured = measuredUsageTokens(messages[i]!);
    if (measured > 0) {
      anchorIndex = i;
      baseTokens = measured;
      break;
    }
  }

  let tailTokens = 0;
  for (let i = anchorIndex + 1; i < messages.length; i += 1) {
    tailTokens += estimateSingleMessageTokens(messages[i]!);
  }
  return baseTokens + tailTokens;
}

/**
 * Derives Harness compaction settings with per-model `backgroundTokens` overrides for
 * large-context models (e.g. 1M context windows) so native background compaction starts
 * around `WORKER_SOFT_COMPACT_TOKENS` (~90K) without shrinking summarizer `reserveTokens`.
 */
export function buildWorkerCompactionSettings(
  base: DomainCompactionSettings,
  providers: readonly ProviderConfig[],
): HarnessCompactionSettings {
  if (!base.enabled) {
    return {
      enabled: false,
      reserveTokens: base.reserveTokens,
      keepRecentTokens: base.keepRecentTokens,
      backgroundTokens: base.backgroundTokens,
    };
  }

  const modelOverrides: Record<string, Partial<CompactionPolicy>> = {};
  const targetBackground = Math.max(WORKER_SOFT_COMPACT_TOKENS, base.keepRecentTokens + MIN_COMPACT_HEADROOM);

  if (base.backgroundTokens > 0) {
    for (const provider of providers) {
      for (const model of provider.models) {
        const contextWindow = model.contextWindow ?? 0;
        if (contextWindow <= 0) continue;
        const blocking = contextWindow - base.reserveTokens;
        if (blocking > targetBackground && blocking - base.backgroundTokens > targetBackground) {
          modelOverrides[`${provider.id}/${model.id}`] = {
            backgroundTokens: blocking - targetBackground,
          };
        }
      }
    }
  }

  return {
    enabled: base.enabled,
    reserveTokens: base.reserveTokens,
    keepRecentTokens: base.keepRecentTokens,
    backgroundTokens: base.backgroundTokens,
    ...(Object.keys(modelOverrides).length > 0 ? { modelOverrides } : {}),
  };
}

/**
 * Caps Worker execution-loop thinking effort to `medium` by default so routine
 * multi-turn tool calls do not spend tens of seconds generating deep reasoning chains.
 */
export function capWorkerThinkingLevel(level: string, options: { uncap?: boolean } = {}): string {
  const normalized = level.trim().toLowerCase() || 'medium';
  if (!options.uncap && (normalized === 'high' || normalized === 'xhigh' || normalized === 'max')) {
    return 'medium';
  }
  return normalized;
}
