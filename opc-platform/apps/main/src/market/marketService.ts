import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { AgentCandidate } from '@opc/shared/domain';
import type { CompanyDatabase } from '../data/companyDatabase';
import type { OrgService } from '../org/orgService';

export const PACKAGE_FORMAT = 'opc-agent-package@1';

interface RawAgent {
  name?: unknown;
  role?: unknown;
  level?: unknown;
  model?: unknown;
  skills?: unknown;
  persona?: unknown;
}

const asText = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value.trim() : fallback;

const asSkills = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean) : [];

/**
 * Package parsing is strict about the envelope and lenient about the fields: an
 * agent needs a name and a role, everything else has a sane default. A package
 * with zero valid agents is an error rather than a silent no-op.
 */
export function parseAgentPackage(raw: string): { name: string; agents: RawAgent[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('不是合法的 JSON 文件');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('Agent 包必须是 JSON 对象');

  const record = parsed as Record<string, unknown>;
  const format = asText(record.format);
  if (format && format !== PACKAGE_FORMAT) {
    throw new Error(`不支持的包格式：${format}（需要 ${PACKAGE_FORMAT}）`);
  }

  const list = Array.isArray(record.agents) ? record.agents : [record];
  const agents = list.filter((item): item is RawAgent => typeof item === 'object' && item !== null);
  const valid = agents.filter((item) => asText(item.name) && asText(item.role));
  if (valid.length === 0) throw new Error('包里没有可用的 Agent（每个都需要 name 和 role）');

  return { name: asText(record.name, PACKAGE_FORMAT), agents: valid };
}

/**
 * The talent market: imported agent packages waiting to be hired. Internal
 * people without a position are listed by `OrgService.unplaced`, not here —
 * this side is only about candidates that are not employees yet.
 */
export class MarketService {
  constructor(
    private readonly db: CompanyDatabase,
    private readonly org: OrgService,
  ) {}

  list = (): AgentCandidate[] => {
    const rows = this.db
      .prepare('SELECT * FROM agent_candidate ORDER BY created_at DESC')
      .all() as {
      id: string;
      name: string;
      role: string;
      level: string;
      model: string;
      skills: string;
      persona: string;
      source: string;
      created_at: number;
    }[];

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      role: row.role,
      level: row.level,
      model: row.model,
      skills: JSON.parse(row.skills || '[]') as string[],
      persona: row.persona,
      source: row.source,
      createdAt: row.created_at,
    }));
  };

  /** Imports from JSON text; `source` shows where it came from in the UI. */
  importJson = (raw: string, source: string): AgentCandidate[] => {
    const { agents } = parseAgentPackage(raw);
    const now = Date.now();
    const insert = this.db.prepare(
      `INSERT INTO agent_candidate (id, name, role, level, model, skills, persona, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const ids: string[] = [];
    this.db.transaction(() => {
      for (const agent of agents) {
        const id = `cand-${crypto.randomUUID()}`;
        ids.push(id);
        insert.run(
          id,
          asText(agent.name),
          asText(agent.role),
          asText(agent.level, 'P5'),
          asText(agent.model),
          JSON.stringify(asSkills(agent.skills)),
          asText(agent.persona),
          source,
          now,
        );
      }
    })();

    return this.list().filter((candidate) => ids.includes(candidate.id));
  };

  importFile = async (path: string): Promise<AgentCandidate[]> => {
    const raw = await readFile(path, 'utf8');
    return this.importJson(raw, basename(path));
  };

  remove = (candidateId: string): void => {
    this.db.prepare('DELETE FROM agent_candidate WHERE id = ?').run(candidateId);
  };

  /** Hires a candidate into a department; the candidate leaves the market. */
  hire = (
    candidateId: string,
    input: { departmentId: string; reportsToEmployeeId?: string; isHead?: boolean },
  ): { employeeId: string } => {
    const candidate = this.list().find((item) => item.id === candidateId);
    if (!candidate) throw new Error('候选人不存在（可能已被聘用）');

    let employeeId = '';
    this.db.transaction(() => {
      const hired = this.org.hire({
        name: candidate.name,
        role: candidate.role,
        level: candidate.level,
        model: candidate.model,
        departmentId: input.departmentId,
        reportsToEmployeeId: input.reportsToEmployeeId,
        isHead: input.isHead,
        skills: candidate.skills,
        persona: candidate.persona,
      });
      employeeId = hired.id;
      this.remove(candidateId);
    })();
    return { employeeId };
  };
}
