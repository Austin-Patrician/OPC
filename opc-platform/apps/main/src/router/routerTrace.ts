import {
  defineExtension,
  hook,
  ToolTask,
  type Extension,
  type HookApi,
  type ToolExecutionResult,
  type ToolHookCall,
} from '@earendil-works/pi-durable';
import type {
  ObservatoryRouterEvent,
  RouterObservatoryPhase,
  RouterTraceEntry,
  RouterTraceKind,
} from '@opc/shared/domain';

const DEFAULT_MAX_ENTRIES = 150;
const SUMMARY_MAX_CHARS = 160;
const DETAIL_MAX_CHARS = 1200;

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function extractResultText(result: ToolExecutionResult): string {
  if (!Array.isArray(result.output)) return '';
  return result.output
    .flatMap((block) => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
    .join('\n')
    .trim();
}

/**
 * Extracts an associated `threadId` from Router tool arguments or JSON result payload.
 */
export function extractThreadId(
  args: Record<string, unknown> | undefined,
  resultText: string,
): string | undefined {
  if (args) {
    for (const key of ['thread_id', 'threadId']) {
      const value = args[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
  }
  if (!resultText) return undefined;
  try {
    const parsed = JSON.parse(resultText) as Record<string, unknown>;
    for (const key of ['threadId', 'thread_id']) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
  } catch {
    // Non-JSON output falls through to regex extraction.
  }
  const match = resultText.match(/\b(thr_[A-Za-z0-9_-]+)\b/);
  return match?.[1];
}

/** Builds a concise one-line summary for a Router tool invocation. */
export function summarizeRouterTool(
  name: string,
  args: Record<string, unknown> | undefined,
  result: ToolExecutionResult,
): { summary: string; detail?: string; threadId?: string } {
  const preferredKeys = [
    'thread_id',
    'threadId',
    'title',
    'goal',
    'instruction',
    'query',
    'mode',
    'id',
    'topic',
    'city',
  ];
  let argsSummary = '';
  if (args) {
    const parts: string[] = [];
    for (const key of preferredKeys) {
      const value = args[key];
      if (typeof value === 'string' && value.trim()) {
        parts.push(`${key}=${clip(oneLine(value), 48)}`);
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        parts.push(`${key}=${String(value)}`);
      }
      if (parts.length >= 3) break;
    }
    if (parts.length === 0) {
      for (const key of Object.keys(args).slice(0, 3)) {
        const value = args[key];
        const raw = typeof value === 'string' ? value : JSON.stringify(value ?? '');
        if (raw) parts.push(`${key}=${clip(oneLine(raw), 40)}`);
      }
    }
    argsSummary = clip(parts.join(' '), SUMMARY_MAX_CHARS);
  }

  const resultText = extractResultText(result);
  const threadId = extractThreadId(args, resultText);

  let outcomeSnippet = '';
  if (result.isError === true) {
    outcomeSnippet = resultText ? `失败: ${clip(oneLine(resultText), 90)}` : '调用失败';
  } else if (resultText) {
    outcomeSnippet = clip(oneLine(resultText), 80);
  }

  const summary = argsSummary
    ? outcomeSnippet
      ? clip(`${argsSummary} → ${outcomeSnippet}`, SUMMARY_MAX_CHARS)
      : argsSummary
    : outcomeSnippet || name;

  const detailSections: string[] = [];
  if (args && Object.keys(args).length > 0) {
    try {
      detailSections.push(`Args:\n${JSON.stringify(args, null, 2)}`);
    } catch {
      // Ignore unserializable objects.
    }
  }
  if (resultText) {
    detailSections.push(`Result:\n${resultText}`);
  }
  const detail = detailSections.length > 0 ? clip(detailSections.join('\n\n'), DETAIL_MAX_CHARS) : undefined;

  return {
    summary,
    ...(detail ? { detail } : {}),
    ...(threadId ? { threadId } : {}),
  };
}

/**
 * Bounded in-memory trace buffer for Router internal decisions and lifecycle telemetry.
 * Never persists to SQLite and never enters Router context.
 */
export class RouterTraceCollector {
  private readonly entries: RouterTraceEntry[] = [];
  private readonly listeners = new Set<(event: ObservatoryRouterEvent) => void>();
  private seq = 0;
  private phase: RouterObservatoryPhase = 'idle';
  private activeTool: string | undefined;
  private lastError: string | null = null;

  constructor(private readonly maxEntries: number = DEFAULT_MAX_ENTRIES) {}

  record(input: {
    kind: RouterTraceKind;
    name: string;
    summary: string;
    detail?: string;
    ok?: boolean | null;
    ms?: number;
    threadId?: string;
  }): RouterTraceEntry {
    this.seq += 1;
    const entry: RouterTraceEntry = {
      id: `rt_${this.seq}`,
      seq: this.seq,
      at: Date.now(),
      kind: input.kind,
      name: input.name,
      summary: clip(oneLine(input.summary), SUMMARY_MAX_CHARS),
      ...(input.detail ? { detail: clip(input.detail, DETAIL_MAX_CHARS) } : {}),
      ok: input.ok ?? null,
      ...(typeof input.ms === 'number' ? { ms: input.ms } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
    this.emit({
      type: 'trace',
      entry,
      phase: this.phase,
      ...(this.activeTool ? { activeTool: this.activeTool } : {}),
    });
    return entry;
  }

  setPhase(
    phase: RouterObservatoryPhase,
    options?: { activeTool?: string; error?: string | null },
  ): void {
    this.phase = phase;
    this.activeTool = phase === 'tool' ? options?.activeTool : undefined;
    if (options && 'error' in options) {
      this.lastError = options.error ?? null;
    } else if (phase !== 'error' && phase !== 'idle') {
      this.lastError = null;
    }
  }

  getPhaseState(): {
    phase: RouterObservatoryPhase;
    activeTool?: string;
    lastError: string | null;
  } {
    return {
      phase: this.phase,
      ...(this.activeTool ? { activeTool: this.activeTool } : {}),
      lastError: this.lastError,
    };
  }

  list(limit?: number): RouterTraceEntry[] {
    if (typeof limit === 'number' && limit > 0 && limit < this.entries.length) {
      return this.entries.slice(-limit);
    }
    return [...this.entries];
  }

  subscribe(listener: (event: ObservatoryRouterEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: ObservatoryRouterEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Never break Router control plane because of a telemetry listener.
      }
    }
  }
}

/**
 * Installs ToolTask hooks on the Router harness to capture every Router internal tool call.
 */
export function createRouterTraceExtension(
  collector: RouterTraceCollector,
  isBusy?: () => boolean,
): Extension {
  const started = new Map<string, number>();

  return defineExtension({
    name: 'opc.router.trace',
    hooks: [
      hook(ToolTask, {
        beforeTool: (call: ToolHookCall, api: HookApi) => {
          started.set(`${String(api.conversationId)}:${call.id}`, Date.now());
          collector.setPhase('tool', { activeTool: call.name });
          return undefined;
        },
        afterTool: (
          call: ToolHookCall,
          result: ToolExecutionResult,
          api: HookApi,
        ) => {
          const key = `${String(api.conversationId)}:${call.id}`;
          const startedAt = started.get(key);
          started.delete(key);
          const ms = startedAt === undefined ? undefined : Date.now() - startedAt;
          const nextPhase: RouterObservatoryPhase = isBusy?.() ? 'thinking' : 'idle';
          collector.setPhase(nextPhase);
          const { summary, detail, threadId } = summarizeRouterTool(
            call.name,
            call.arguments as Record<string, unknown> | undefined,
            result,
          );
          collector.record({
            kind: 'tool',
            name: call.name,
            summary,
            ...(detail ? { detail } : {}),
            ok: result.isError !== true,
            ...(typeof ms === 'number' ? { ms } : {}),
            ...(threadId ? { threadId } : {}),
          });
          return undefined;
        },
      }),
    ],
  });
}
