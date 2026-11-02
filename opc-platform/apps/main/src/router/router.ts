import type { AttentionLevel, TriggerEvent, WorkReport, WorkThread } from '@opc/shared/domain';
import type { ThreadRepository } from '../data/threadRepository';

/**
 * The Router: a headless scheduling loop, **not** a chat window.
 *
 * This is the load-bearing decision of v2 (docs/v2/00-audit.md §6, S2). If the
 * router were implemented as a conversation, the product would end up as one more
 * chat app with the same single-session blocking problem it was meant to solve.
 * Here it is a loop with a queue: events in, threads out, reports queued by how
 * much of the boss's attention they are allowed to take.
 *
 * One tick does exactly four things, in this order:
 *
 *   1. **Program-layer filter** — cheap predicates drop most noise. A dropped
 *      event never reaches a model, which is the whole point of the two levels.
 *   2. **Semantic judgement** — the surviving batch is judged in *one* call, not
 *      one per event: the batch shares the prefill, so a burst costs less per
 *      decision than a trickle (Super-agent §事件驱动, batching).
 *   3. **Thread** — an accepted event opens a line of work, or joins one.
 *   4. **Dispatch + report** — the work goes to an executor; whatever comes back
 *      becomes a report whose level decides whether the boss is interrupted.
 *
 * Nothing here calls a model itself. `judge` and `dispatch` are injected, so a
 * test can run the whole path with fakes, and B3 can wire the real services.
 */

/** What the program layer says about a single event, before any model is involved. */
export type PrefilterVerdict = 'keep' | 'drop';

/** What the semantic layer says about a batch of surviving events. */
export interface JudgeVerdict {
  eventId: string;
  accept: boolean;
  /** Opens a new thread with this title; ignored when joining an existing one. */
  title?: string;
  /** Attaches to an existing line of work instead of opening a new one. */
  threadId?: string;
}

export interface DispatchInput {
  thread: WorkThread;
  event: TriggerEvent;
}

/**
 * What an executor may report back.
 *
 * `delivered` is the quiet path — it is recorded but does not interrupt.
 * `needs-decision` and `failed` both spend the thread's attention quota, because
 * both leave the boss with something only they can settle.
 */
export type DispatchOutcome =
  | { status: 'delivered'; summary: string }
  | { status: 'needs-decision'; question: string }
  | { status: 'failed'; reason: string };

export interface RouterDeps {
  threads: ThreadRepository;
  /** Program layer. Defaults to keeping everything, so a wiring mistake is loud. */
  prefilter?: (event: TriggerEvent) => PrefilterVerdict;
  /** Semantic layer. Absent = accept everything the program layer kept. */
  judge?: (events: readonly TriggerEvent[]) => Promise<JudgeVerdict[]>;
  /** Executor. Absent = the router can triage but cannot finish anything. */
  dispatch?: (input: DispatchInput) => Promise<DispatchOutcome>;
  /** How many pending events one tick will look at. */
  batchSize?: number;
}

export interface TickReport {
  /** Events the program layer dropped without spending a token. */
  dropped: number;
  /** Events the semantic layer rejected. */
  rejected: number;
  /** Threads opened by this tick. */
  opened: WorkThread[];
  /** Reports queued by this tick, with the level that was chosen. */
  reported: WorkReport[];
  /** Events that threw. They stay pending so the next tick retries them. */
  failed: number;
}

const DEFAULT_BATCH = 20;

export class Router {
  private readonly batchSize: number;

  constructor(private readonly deps: RouterDeps) {
    this.batchSize = deps.batchSize ?? DEFAULT_BATCH;
  }

  /**
   * One pass. Safe to call on a timer; safe to call twice in a row.
   *
   * An event that throws anywhere in the path is left `pending` on purpose: the
   * alternative is losing work silently, and the queue is the only record that it
   * ever arrived.
   */
  tick = async (): Promise<TickReport> => {
    const report: TickReport = { dropped: 0, rejected: 0, opened: [], reported: [], failed: 0 };

    const pending = this.deps.threads.listPendingEvents(this.batchSize);
    if (pending.length === 0) return report;

    // ① Program layer: no model, no cost, no thread.
    const kept: TriggerEvent[] = [];
    for (const event of pending) {
      if ((this.deps.prefilter?.(event) ?? 'keep') === 'drop') {
        this.deps.threads.triageEvent(event.id, 'dropped');
        report.dropped += 1;
      } else {
        kept.push(event);
      }
    }
    if (kept.length === 0) return report;

    // ② Semantic layer: one call for the whole batch.
    const verdicts = await this.judgeBatch(kept);
    if (verdicts === null) {
      // The judge is down. Leave the batch pending rather than dropping it:
      // losing work because a model hiccuped is the silent failure P6 forbids.
      report.failed += kept.length;
      return report;
    }
    const byId = new Map(verdicts.map((verdict) => [verdict.eventId, verdict]));

    for (const event of kept) {
      const verdict = byId.get(event.id);
      if (!verdict?.accept) {
        this.deps.threads.triageEvent(event.id, 'dropped');
        report.rejected += 1;
        continue;
      }

      try {
        const { thread, opened } = this.openOrJoin(event, verdict);
        if (opened) report.opened.push(thread);
        this.deps.threads.triageEvent(event.id, 'accepted', thread.id);

        if (!this.deps.dispatch) continue;
        this.deps.threads.setState(thread.id, 'running');

        let outcome: DispatchOutcome;
        try {
          outcome = await this.deps.dispatch({ thread, event });
        } catch (error) {
          // An executor crash is a failed thread with a visible reason, not a
          // silent retry: retrying a run that already wrote files is how you get
          // duplicated deliverables and a bill for both.
          outcome = {
            status: 'failed',
            reason: error instanceof Error ? error.message : String(error),
          };
        }
        report.reported.push(this.settle(thread, outcome));
      } catch {
        // A repository throw is a bug, not a decision. The event stays pending.
        report.failed += 1;
      }
    }

    return report;
  };

  /**
   * A judge that throws fails the whole batch: `null`, never an empty list.
   *
   * The distinction matters — an empty list means "the judge looked and said no
   * to everything", which is a decision we can act on. A throw means the judge
   * never ran, and the batch has to be retried, not dropped.
   */
  private async judgeBatch(events: readonly TriggerEvent[]): Promise<JudgeVerdict[] | null> {
    if (!this.deps.judge) return events.map((event) => ({ eventId: event.id, accept: true }));
    try {
      const verdicts = await this.deps.judge(events);
      return verdicts.filter((verdict) => typeof verdict?.eventId === 'string');
    } catch {
      return null;
    }
  }

  private openOrJoin(
    event: TriggerEvent,
    verdict: JudgeVerdict,
  ): { thread: WorkThread; opened: boolean } {
    if (verdict.threadId) {
      const existing = this.deps.threads.getThread(verdict.threadId);
      // A verdict that points at a thread that is gone is a new line of work, not
      // an error: the boss deleted it, the event still arrived.
      if (existing && existing.closedAt === null) {
        this.deps.threads.touch(existing.id);
        return { thread: existing, opened: false };
      }
    }
    const thread = this.deps.threads.createThread({
      title: verdict.title?.trim() || event.kind,
      goal: typeof event.payload.goal === 'string' ? event.payload.goal : '',
    });
    return { thread, opened: true };
  }

  /** Turns an outcome into a thread state plus the report level it earns. */
  private settle(thread: WorkThread, outcome: DispatchOutcome): WorkReport {
    switch (outcome.status) {
      case 'delivered':
        this.deps.threads.setState(thread.id, 'done');
        // Quiet on purpose: finishing is the expected case, and a notification
        // for it is exactly the noise the attention budget exists to prevent.
        return this.deps.threads.addReport({
          threadId: thread.id,
          level: 'silent',
          title: thread.title,
          body: outcome.summary,
        });
      case 'needs-decision':
        this.deps.threads.setState(thread.id, 'waiting');
        return this.deps.threads.addReport({
          threadId: thread.id,
          level: 'decide',
          title: thread.title,
          body: outcome.question,
        });
      case 'failed':
        this.deps.threads.setState(thread.id, 'failed');
        return this.deps.threads.addReport({
          threadId: thread.id,
          level: 'decide',
          title: thread.title,
          body: outcome.reason,
        });
    }
  }
}

/** Convenience for the settings page: what the queue level actually means. */
export const ATTENTION_COPY: Record<AttentionLevel, string> = {
  decide: '需要你拍板',
  notify: '知道一下就行',
  silent: '干完了，只在记录里',
};
