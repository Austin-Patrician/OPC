import crypto from 'node:crypto';
import type { CompanyDatabase } from '../data/companyDatabase';

export interface ConsolidationRun {
  id: string;
  employeeId: string;
  conversationIds: string[];
  episodeCount: number;
  memoriesCreated: number;
  memoriesMerged: number;
  memoriesArchived: number;
  tokensUsed: number;
  status: 'running' | 'done' | 'failed' | 'skipped';
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

/**
 * The audit trail of consolidation (design §4.8 `consolidation_run`).
 *
 * Rows are opened before summarising and closed afterwards, so a crash leaves a
 * visible `running` row instead of a silent gap. `skipped` exists because "no model
 * configured" is a legitimate outcome we want to count, not an error to hide.
 */
export class ConsolidationRunStore {
  constructor(private readonly db: CompanyDatabase) {}

  start = (input: { employeeId: string; conversationIds: string[]; episodeCount: number }): string => {
    const id = `run-${crypto.randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO consolidation_run
           (id, employee_id, source_conversation_ids, episode_count, status, started_at)
         VALUES (?, ?, ?, ?, 'running', ?)`,
      )
      .run(id, input.employeeId, JSON.stringify(input.conversationIds), input.episodeCount, Date.now());
    return id;
  };

  finish = (
    id: string,
    result: {
      status: 'done' | 'failed' | 'skipped';
      created?: number;
      merged?: number;
      archived?: number;
      tokensUsed?: number;
      error?: string;
    },
  ): void => {
    this.db
      .prepare(
        `UPDATE consolidation_run
            SET status = ?, memories_created = ?, memories_merged = ?, memories_archived = ?,
                tokens_used = ?, error = ?, finished_at = ?
          WHERE id = ?`,
      )
      .run(
        result.status,
        result.created ?? 0,
        result.merged ?? 0,
        result.archived ?? 0,
        result.tokensUsed ?? 0,
        result.error ?? null,
        Date.now(),
        id,
      );
  };

  list = (limit = 20, employeeId?: string): ConsolidationRun[] => {
    const rows = this.db
      .prepare(
        `SELECT * FROM consolidation_run ${employeeId ? 'WHERE employee_id = ?' : ''}
          ORDER BY started_at DESC LIMIT ?`,
      )
      .all(...(employeeId ? [employeeId, limit] : [limit])) as {
      id: string;
      employee_id: string;
      source_conversation_ids: string;
      episode_count: number;
      memories_created: number;
      memories_merged: number;
      memories_archived: number;
      tokens_used: number;
      status: ConsolidationRun['status'];
      error: string | null;
      started_at: number;
      finished_at: number | null;
    }[];

    return rows.map((row) => ({
      id: row.id,
      employeeId: row.employee_id,
      conversationIds: JSON.parse(row.source_conversation_ids || '[]') as string[],
      episodeCount: row.episode_count,
      memoriesCreated: row.memories_created,
      memoriesMerged: row.memories_merged,
      memoriesArchived: row.memories_archived,
      tokensUsed: row.tokens_used,
      status: row.status,
      error: row.error,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    }));
  };
}
