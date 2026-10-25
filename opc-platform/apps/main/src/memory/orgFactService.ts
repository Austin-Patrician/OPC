import crypto from 'node:crypto';
import type { CompanyDatabase } from '../data/companyDatabase';

export type FactScopeType = 'org' | 'department' | 'project';

export interface OrgFact {
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
 * Company-level knowledge ("Q4 先做留存", "所有交付必须带 README").
 *
 * Two rules from the design are enforced here rather than by callers:
 * - **one current fact per (scope, subject, predicate)**: writing a new value
 *   closes the old one with `valid_until`, so history is kept and queries stay simple;
 * - scope is explicit, so a department fact never leaks into another department
 *   (the same reason employee memories carry scope columns).
 */
export class OrgFactService {
  constructor(private readonly db: CompanyDatabase) {}

  /** Closes any current fact with the same key, then inserts the new one. */
  write = (input: WriteFactInput): OrgFact => {
    const now = Date.now();
    const predicate = (input.predicate ?? 'is').trim() || 'is';
    const scopeId = input.scopeType === 'org' ? COMPANY_ID : (input.scopeId ?? '').trim();
    if (input.scopeType !== 'org' && !scopeId) throw new Error('部门/项目事实需要 scopeId');
    const statement = (input.statement ?? `${input.subject} ${predicate} ${input.object}`).trim();
    const id = `fact-${crypto.randomUUID()}`;

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE org_fact SET valid_until = ?, updated_at = ?
            WHERE company_id = ? AND scope_type = ? AND scope_id = ? AND subject = ? AND predicate = ?
              AND valid_until IS NULL AND is_archived = 0`,
        )
        .run(now, now, COMPANY_ID, input.scopeType, scopeId, input.subject.trim(), predicate);

      this.db
        .prepare(
          `INSERT INTO org_fact
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

  /** Current facts for the scopes an employee may see, most specific last. */
  current = (scopes: { type: FactScopeType; id?: string }[], limit = 20): OrgFact[] => {
    const rows = this.db
      .prepare(
        `SELECT id, scope_type, scope_id, subject, predicate, object, statement, confidence,
                valid_from, source_type, source_id
           FROM org_fact
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

    const allowed = new Set(scopes.map((scope) => `${scope.type}:${scope.type === 'org' ? COMPANY_ID : scope.id ?? ''}`));
    return rows
      .filter((row) => allowed.has(`${row.scope_type}:${row.scope_id}`))
      // org-wide first, then department/project (the more specific context last wins).
      .sort((a, b) => (a.scope_type === 'org' ? 1 : 0) - (b.scope_type === 'org' ? 1 : 0))
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
  history = (subject?: string): OrgFact[] => {
    const rows = this.db
      .prepare(
        `SELECT id, scope_type, scope_id, subject, predicate, object, statement, confidence,
                valid_from, source_type, source_id
           FROM org_fact WHERE company_id = ? ${subject ? 'AND subject = ?' : ''}
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
