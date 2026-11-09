import type { MemoryKind, MemoryService } from './memoryService';
import type { MemoryVolatility } from './memoryScore';
import { USER_MEMORY_OWNER } from './owners';
import type { MemorySignal, SignalStore } from './signals';

/**
 * 后置抽取：把"用户的抱怨"变成"可执行的偏好"。
 *
 * 它在主路径之外（LangMem 说的 background path），原因有三个，每个都不是洁癖：
 *
 * 1. **不占用户的等待**。用户点「重做」之后要立刻看到活儿重新跑起来，不能等一次模型调用。
 * 2. **可以跨多条一起看**。一次三条返工理由放在一起，模型能看出"他其实一直在嫌同一件事"，
 *    而逐条抽会得到三条近义记忆（P2 的 subject 也只能合并主题相近的那部分）。
 * 3. **允许失败**。抽取炸了不该影响任何已有的事——信号还在表里，下一轮再来。
 *
 * 这一层**不判断值不值得记**交给模型，但**判断"这条是不是已经记过了"交给 P2 的确定性
 * 去重**。顺序不能反：让模型去判重，它会把"没有重复"和"看起来像"混为一谈。
 */

/** 抽取出来的一条。字段和 `remember` 对齐，不多也不少。 */
export interface ExtractedMemory {
  kind: MemoryKind;
  /** 主题键；同一个主题上新的会取代旧的（P2）。 */
  subject: string | null;
  content: string;
  volatility: MemoryVolatility;
  /** 这条讲的是这个人，还是这条线。默认 person。 */
  scope: 'person' | 'thread';
}

export type MemoryExtractor = (signals: readonly MemorySignal[]) => Promise<ExtractedMemory[]>;

export interface ExtractionRunResult {
  /** 这一轮看了几条信号。 */
  picked: number;
  /** 落成记忆的条数。 */
  written: number;
  /** 没跑成的原因（没配模型、抽取失败）。信号保持未处理，下一轮重来。 */
  skipped?: string;
}

const KINDS: readonly MemoryKind[] = [
  'preference',
  'constraint',
  'fact',
  'person',
  'term',
  'format',
  'workflow',
  'experience',
  'summary',
];
const VOLATILITIES: readonly MemoryVolatility[] = ['stable', 'slow', 'session'];

/** 太短的一条不值得成为记忆（"好的"、"明白了"）。 */
const MIN_CONTENT = 6;

export interface MemoryExtractionDeps {
  signals: SignalStore;
  memory: MemoryService;
  /** 没有模型时整天不跑——但**不消耗信号**，配好模型之后它们还在。 */
  extract?: MemoryExtractor;
  /** 一批最多看几条。太多会让单条判断变糙，太少摊不薄调用成本。 */
  batchSize?: number;
  /** Optional secondary projection. The callback runs after the legacy memory row is durable. */
  onWritten?: (input: { candidate: ExtractedMemory; memoryId: string; signals: readonly MemorySignal[] }) => void | Promise<void>;
}

export function createMemoryExtraction(deps: MemoryExtractionDeps) {
  const batchSize = deps.batchSize ?? 10;

  return {
    run: async (): Promise<ExtractionRunResult> => {
      const pending = deps.signals.pending(batchSize);
      if (pending.length === 0) return { picked: 0, written: 0 };
      if (!deps.extract) {
        return { picked: pending.length, written: 0, skipped: '没有可用的模型，信号留着下次再抽' };
      }

      let candidates: ExtractedMemory[];
      try {
        candidates = await deps.extract(pending);
      } catch (error) {
        // 失败不标记：下一轮重来。宁可多抽一遍，不可漏掉一次。
        return {
          picked: pending.length,
          written: 0,
          skipped: error instanceof Error ? error.message : String(error),
        };
      }

      let written = 0;
      for (const candidate of candidates) {
        const content = candidate.content.trim();
        if (content.length < MIN_CONTENT) continue;
        // 归属：这条讲的是这个人，还是这条线。线级的记忆挂在线上，换人接手还在（P0）。
        const scopeOwner = candidate.scope === 'thread' ? threadOwnerOf(pending, candidate) : null;
        try {
          const memoryId = await deps.memory.remember({
            ownerId: scopeOwner?.ownerId ?? USER_MEMORY_OWNER,
            kind: normalizeKind(candidate.kind),
            content,
            scope: scopeOwner ? { type: 'thread', id: scopeOwner.ownerId } : { type: 'personal' },
            // 指针：一条记忆必须能追回它是从哪句话里来的（`07-memory.md` §8）。
            sourceType: 'task',
            ...(pending[0] ? { sourceId: pending[0].id } : {}),
            volatility: normalizeVolatility(candidate.volatility),
            ...(candidate.subject ? { subject: candidate.subject } : {}),
          });
          await deps.onWritten?.({ candidate, memoryId, signals: pending });
          written += 1;
        } catch (error) {
          // 某一条写不进去（例如常驻层满了）不该连累整批。
          console.warn('[memory] 抽取出来的一条没能落库', error);
        }
      }

      deps.signals.markProcessed(pending.map((signal) => signal.id));
      return { picked: pending.length, written };
    },
  };
}

/**
 * 线级候选该挂在哪条线上。
 *
 * 取这批信号里**最近**那条的 threadId：返工理由是跟着线走的，而一批里的信号通通常来自
 * 同一条线（用户连着改两版）。没有 threadId 的退回到"这个人"。
 */
function threadOwnerOf(
  pending: readonly MemorySignal[],
  _candidate: ExtractedMemory,
): { ownerId: string } | null {
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    const threadId = pending[index]?.threadId;
    if (threadId) return { ownerId: threadId };
  }
  return null;
}

function normalizeKind(kind: string): MemoryKind {
  return KINDS.includes(kind as MemoryKind) ? (kind as MemoryKind) : 'preference';
}

function normalizeVolatility(volatility: string): MemoryVolatility {
  return VOLATILITIES.includes(volatility as MemoryVolatility)
    ? (volatility as MemoryVolatility)
    : 'slow';
}
