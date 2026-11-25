import type { RouterTraceEntry, TaskTrace } from '@opc/shared/domain';

const EXPLORATORY_TOOLS = new Set([
  'read',
  'read_file',
  'find',
  'glob',
  'ls',
  'list_dir',
  'grep',
  'search',
  'browser_snapshot',
  'browser_read',
  'browser_scroll',
  'browser_tabs',
  'browser_wait',
  'recall',
  'list_lines',
]);

function normalizeToolName(name: string): string {
  return name.replace(/（嵌套）$/, '').trim().toLowerCase();
}

export function isExploratoryTrace(entry: TaskTrace): boolean {
  if (entry.ok === false || entry.kind === 'error') return false;
  return EXPLORATORY_TOOLS.has(normalizeToolName(entry.name));
}

export type WorkerTraceDisplayItem =
  | {
      kind: 'gap';
      id: string;
      count: number;
    }
  | {
      kind: 'settlement';
      id: string;
      entry: TaskTrace;
    }
  | {
      kind: 'step';
      id: string;
      entry: TaskTrace;
    }
  | {
      kind: 'burst';
      id: string;
      items: TaskTrace[];
      totalMs: number;
      representative: TaskTrace;
      sampleDigest: string;
    };

/**
 * Collapses consecutive read-only/exploratory Worker steps into compact bursts
 * so real mutations, shell runs, errors, and live steps stand out clearly.
 */
export function groupWorkerTrace(
  trace: readonly TaskTrace[],
  options: { keyOnly: boolean; running: boolean },
): WorkerTraceDisplayItem[] {
  const result: WorkerTraceDisplayItem[] = [];
  let buffer: TaskTrace[] = [];

  const flushBuffer = () => {
    if (buffer.length === 0) return;
    if (buffer.length === 1) {
      const single = buffer[0]!;
      result.push({ kind: 'step', id: single.id, entry: single });
      buffer = [];
      return;
    }
    const items = buffer;
    buffer = [];
    const totalMs = items.reduce((sum, item) => sum + (item.ms ?? 0), 0);
    const representative = items[0]!;
    const firstDigest = representative.argsDigest || representative.name;
    result.push({
      kind: 'burst',
      id: `burst_${representative.id}`,
      items,
      totalMs,
      representative,
      sampleDigest: firstDigest,
    });
  };

  for (let i = 0; i < trace.length; i += 1) {
    const entry = trace[i]!;
    const prev = i > 0 ? trace[i - 1] : undefined;
    const gap = prev ? entry.seq - prev.seq - 1 : 0;
    const isLastLive = options.running && i === trace.length - 1;
    const exploratory = isExploratoryTrace(entry);

    if (gap > 0) {
      flushBuffer();
      result.push({
        kind: 'gap',
        id: `gap_${prev?.id ?? 'start'}_${entry.id}`,
        count: gap,
      });
    }

    if (entry.kind === 'usage') {
      flushBuffer();
      if (!options.keyOnly) {
        result.push({
          kind: 'settlement',
          id: entry.id,
          entry,
        });
      }
      continue;
    }

    if (options.keyOnly && exploratory && !isLastLive) {
      continue;
    }

    if (exploratory && !isLastLive) {
      buffer.push(entry);
      continue;
    }

    flushBuffer();
    result.push({ kind: 'step', id: entry.id, entry });
  }

  flushBuffer();
  return result;
}

export interface RouterTurnGroup {
  id: string;
  startedAt: number;
  kind: 'turn' | 'lifecycle';
  inputSummary: string;
  outcomeSummary: string;
  toolCount: number;
  totalMs?: number;
  ok: boolean | null;
  entries: RouterTraceEntry[];
  linkedThreadIds: string[];
}

function finalizeTurn(
  turn: RouterTurnGroup,
  closingEntry?: RouterTraceEntry,
): RouterTurnGroup {
  if (closingEntry) {
    turn.entries.push(closingEntry);
    turn.outcomeSummary = closingEntry.summary;
    turn.ok = closingEntry.ok;
    if (typeof closingEntry.ms === 'number') {
      turn.totalMs = closingEntry.ms;
    }
  }
  const seenThreads = new Set<string>();
  const linked: string[] = [];
  let toolCount = 0;
  let toolMsSum = 0;
  for (const item of turn.entries) {
    if (item.kind === 'tool') toolCount += 1;
    if (typeof item.ms === 'number') toolMsSum += item.ms;
    if (item.threadId && !seenThreads.has(item.threadId)) {
      seenThreads.add(item.threadId);
      linked.push(item.threadId);
    }
  }
  turn.toolCount = toolCount;
  turn.linkedThreadIds = linked;
  if (turn.totalMs === undefined && toolMsSum > 0) {
    turn.totalMs = toolMsSum;
  }
  return turn;
}

/**
 * Groups flat Router trace events into chronological decision turns and returns them
 * newest-first so only the latest turn needs to be expanded by default.
 */
export function groupRouterTraceByTurn(
  trace: readonly RouterTraceEntry[],
): RouterTurnGroup[] {
  const groups: RouterTurnGroup[] = [];
  let current: RouterTurnGroup | null = null;

  const flushCurrent = (closingEntry?: RouterTraceEntry) => {
    if (!current) return;
    groups.push(finalizeTurn(current, closingEntry));
    current = null;
  };

  for (const entry of trace) {
    if (entry.kind === 'event_batch') {
      flushCurrent();
      current = {
        id: `turn_${entry.id}`,
        startedAt: entry.at,
        kind: 'turn',
        inputSummary: entry.summary,
        outcomeSummary: '',
        toolCount: 0,
        ok: null,
        entries: [entry],
        linkedThreadIds: [],
      };
      continue;
    }

    if (entry.kind === 'turn') {
      if (current) {
        flushCurrent(entry);
      } else {
        groups.push(
          finalizeTurn({
            id: `turn_${entry.id}`,
            startedAt: entry.at,
            kind: 'turn',
            inputSummary: entry.name,
            outcomeSummary: entry.summary,
            toolCount: 0,
            ok: entry.ok,
            entries: [entry],
            linkedThreadIds: [],
          }),
        );
      }
      continue;
    }

    if (entry.kind === 'lifecycle') {
      flushCurrent();
      groups.push(
        finalizeTurn({
          id: `turn_${entry.id}`,
          startedAt: entry.at,
          kind: 'lifecycle',
          inputSummary: entry.summary,
          outcomeSummary: entry.summary,
          toolCount: 0,
          ...(typeof entry.ms === 'number' ? { totalMs: entry.ms } : {}),
          ok: entry.ok,
          entries: [entry],
          linkedThreadIds: entry.threadId ? [entry.threadId] : [],
        }),
      );
      continue;
    }

    // Tool call inside an open turn, or orphan tool call before a deliver marker.
    if (!current) {
      current = {
        id: `turn_${entry.id}`,
        startedAt: entry.at,
        kind: 'turn',
        inputSummary: entry.name,
        outcomeSummary: entry.summary,
        toolCount: 0,
        ok: entry.ok,
        entries: [entry],
        linkedThreadIds: [],
      };
    } else {
      current.entries.push(entry);
    }
  }

  flushCurrent();
  return groups.reverse();
}
