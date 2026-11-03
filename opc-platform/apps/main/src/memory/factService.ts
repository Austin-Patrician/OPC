import crypto from 'node:crypto';
import type { CompanyDatabase } from '../data/companyDatabase';

/**
 * 事实的作用域只剩两层。
 *
 * 它曾经是 `org | department | project | thread`——一个组织、它的部门、它的项目。
 * 产品现在是**一个助手的个人工作台**：只有"这个工作台都算数的事"（`global`）和
 * "这条工作线自己定的事"（`thread`）。中间那两层从来没有对应的表。
 */
export type FactScopeType = 'global' | 'thread';

export interface Fact {
  id: string;
  scopeType: FactScopeType;
  scopeId: string;
  subject: string;
  predicate: string;
  object: string;
  statement: string;
  confidence: number;
  validFrom: number;
  sourceType: string | null;
  sourceId: string | null;
}

export interface WriteFactInput {
  scopeType: FactScopeType;
  scopeId?: string;
  subject: string;
  predicate?: string;
  object: string;
  statement?: string;
  sourceType?: 'manual' | 'import' | 'task' | 'conversation';
  sourceId?: string;
  confidence?: number;
}

const COMPANY_ID = 'company-local';

/**
 * 这个工作台里都算数的事（"交付必须带 README"）与单条工作线自己的规定。
 *
 * 设计里的两条规则在这里强制，而不是靠调用方自觉：
 * - **同一 (scope, subject, predicate) 只有一个当前值**：写新值时用 `valid_until`
 *   关掉旧的，历史留着，查询保持简单；
 * - 作用域是显式的，所以一条工作线的规定不会漏到另一条线（记忆表带 scope 列也是
 *   同一个原因）。
 */
export class FactService {
  constructor(private readonly db: CompanyDatabase) {}

  /** Closes any current fact with the same key, then inserts the new one. */
  write = (input: WriteFactInput): Fact => {
    const now = Date.now();
    const predicate = (input.predicate ?? 'is').trim() || 'is';
    const scopeId = input.scopeType === 'global' ? COMPANY_ID : (input.scopeId ?? '').trim();
    if (input.scopeType !== 'global' && !scopeId) throw new Error('工作线内的事实需要一个 scopeId');
    const statement = (input.statement ?? `${input.subject} ${predicate} ${input.object}`).trim();
    const id = `fact-${crypto.randomUUID()}`;

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE fact SET valid_until = ?, updated_at = ?
            WHERE company_id = ? AND scope_type = ? AND scope_id = ? AND subject = ? AND predicate = ?
              AND valid_until IS NULL AND is_archived = 0`,
        )
        .run(now, now, COMPANY_ID, input.scopeType, scopeId, input.subject.trim(), predicate);

      this.db
        .prepare(
          `INSERT INTO fact
             (id, company_id, scope_type, scope_id, subject, predicate, object, statement,
              source_type, source_id, valid_from, confidence, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          COMPANY_ID,
          input.scopeType,
          scopeId,
          input.subject.trim(),
          predicate,
          input.object.trim(),
          statement,
          input.sourceType ?? 'manual',
          input.sourceId ?? null,
          now,
          input.confidence ?? 1,
          now,
          now,
        );
    });
    tx();

    return {
      id,
      scopeType: input.scopeType,
      scopeId,
      subject: input.subject.trim(),
      predicate,
      object: input.object.trim(),
      statement,
      confidence: input.confidence ?? 1,
      validFrom: now,
      sourceType: input.sourceType ?? 'manual',
      sourceId: input.sourceId ?? null,
    };
  };

  /** Current facts for the scopes this agent may see, most specific last. */
  current = (scopes: { type: FactScopeType; id?: string }[], limit = 20): Fact[] => {
    const rows = this.db
      .prepare(
        `SELECT id, scope_type, scope_id, subject, predicate, object, statement, confidence,
                valid_from, source_type, source_id
           FROM fact
          WHERE company_id = ? AND valid_until IS NULL AND is_archived = 0
          ORDER BY valid_from DESC
          LIMIT 200`,
      )
      .all(COMPANY_ID) as {
      id: string;
      scope_type: FactScopeType;
      scope_id: string;
      subject: string;
      predicate: string;
      object: string;
      statement: string;
      confidence: number;
      valid_from: number;
      source_type: string | null;
      source_id: string | null;
    }[];

    const allowed = new Set(scopes.map((scope) => `${scope.type}:${scope.type === 'global' ? COMPANY_ID : scope.id ?? ''}`));
    return rows
      .filter((row) => allowed.has(`${row.scope_type}:${row.scope_id}`))
      // 工作线的规定排在后面：越具体越后，冲突时后面的赢。
      .sort((a, b) => (a.scope_type === 'global' ? 1 : 0) - (b.scope_type === 'global' ? 1 : 0))
      .slice(0, limit)
      .map((row) => ({
        id: row.id,
        scopeType: row.scope_type,
        scopeId: row.scope_id,
        subject: row.subject,
        predicate: row.predicate,
        object: row.object,
        statement: row.statement,
        confidence: row.confidence,
        validFrom: row.valid_from,
        sourceType: row.source_type,
        sourceId: row.source_id,
      }));
  };

  /** Everything, including superseded rows — the audit view. */
  history = (subject?: string): Fact[] => {
    const rows = this.db
      .prepare(
        `SELECT id, scope_type, scope_id, subject, predicate, object, statement, confidence,
                valid_from, source_type, source_id
           FROM fact WHERE company_id = ? ${subject ? 'AND subject = ?' : ''}
          ORDER BY valid_from DESC LIMIT 200`,
      )
      .all(...(subject ? [COMPANY_ID, subject] : [COMPANY_ID])) as {
      id: string;
      scope_type: FactScopeType;
      scope_id: string;
      subject: string;
      predicate: string;
      object: string;
      statement: string;
      confidence: number;
      valid_from: number;
      source_type: string | null;
      source_id: string | null;
    }[];

    return rows.map((row) => ({
      id: row.id,
      scopeType: row.scope_type,
      scopeId: row.scope_id,
      subject: row.subject,
      predicate: row.predicate,
      object: row.object,
      statement: row.statement,
      confidence: row.confidence,
      validFrom: row.valid_from,
      sourceType: row.source_type,
      sourceId: row.source_id,
    }));
  };
}
