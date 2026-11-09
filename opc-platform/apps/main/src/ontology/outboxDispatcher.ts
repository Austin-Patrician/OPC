import type { ContextGraphStore, OntologyOutboxEvent } from './types';

export type OntologyOutboxHandler = (event: OntologyOutboxEvent) => void | Promise<void>;

/** Durable, single-flight outbox delivery with bounded exponential retry. */
export class OntologyOutboxDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly handlers = new Set<OntologyOutboxHandler>();

  constructor(private readonly graph: ContextGraphStore) {}

  subscribe(handler: OntologyOutboxHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  start(intervalMs = 2_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), intervalMs);
    this.timer.unref?.();
    void this.flush();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async flush(limit = 100): Promise<{ delivered: number; failed: number }> {
    if (this.running || this.handlers.size === 0) return { delivered: 0, failed: 0 };
    this.running = true;
    let delivered = 0;
    let failed = 0;
    try {
      for (const event of this.graph.pendingOutbox(limit)) {
        try {
          for (const handler of this.handlers) await handler(event);
          if (this.graph.markOutboxDelivered(event.id)) delivered += 1;
        } catch (error) {
          failed += 1;
          const attempts = Math.min(10, event.attempts + 1);
          const delay = Math.min(5 * 60_000, 500 * 2 ** attempts);
          this.graph.markOutboxFailed(event.id, error instanceof Error ? error.message : String(error), Date.now() + delay);
        }
      }
    } finally {
      this.running = false;
    }
    return { delivered, failed };
  }
}
