import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type {
  AgentCandidate,
  EmployeePackageRecord,
  ExportPackageInput,
  Interview,
  InterviewDecision,
  InterviewStatus,
} from '@opc/shared/domain';
import type { CompanyDatabase } from '../data/companyDatabase';
import type { OrgService } from '../org/orgService';

export const PACKAGE_FORMAT = 'opc-agent-package@1';
export const PACKAGE_VERSION = '1.0';

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

/** What a trial run produced. Injected by bootstrap; without it, interviews cannot run. */
export interface TrialRunResult {
  text: string;
  tokens: number;
  costUsd: number;
}

/**
 * The talent market: imported agent packages waiting to be hired, plus the trial runs
 * and the exported packages that surround that decision.
 *
 * Internal people without a position are listed by `OrgService.unplaced`, not here —
 * this side is only about candidates that are not employees yet.
 */
export class MarketService {
  /**
   * Injected by bootstrap. Absent (probe, no provider configured) means an interview
   * fails with a readable message instead of pretending to have run.
   */
  runTrial?: (input: { candidate: AgentCandidate; prompt: string }) => Promise<TrialRunResult>;

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
    input: { departmentId: string; reportsToEmployeeId?: string; isHead?: boolean; jobId?: string },
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
        jobId: input.jobId,
        skills: candidate.skills,
        persona: candidate.persona,
      });
      employeeId = hired.id;
      this.remove(candidateId);
    })();
    return { employeeId };
  };

  // ── 试跑面试 ────────────────────────────────────────────────────────────

  private readInterview = (id: string): Interview | undefined => {
    const row = this.db.prepare('SELECT * FROM interview WHERE id = ?').get(id) as InterviewRow | undefined;
    return row ? toInterview(row) : undefined;
  };

  /** Trial runs, newest first; filtered by candidate when one is given. */
  interviews = (candidateId?: string): Interview[] => {
    const rows = (
      candidateId
        ? this.db
            .prepare('SELECT * FROM interview WHERE candidate_id = ? ORDER BY created_at DESC')
            .all(candidateId)
        : this.db.prepare('SELECT * FROM interview ORDER BY created_at DESC').all()
    ) as InterviewRow[];
    return rows.map(toInterview);
  };

  /**
   * Creates a trial run for a candidate.
   *
   * The candidate's own charter and skills go into the prompt, so the trial measures
   * *this* candidate rather than the model: a persona that says "only deliver
   * reproducible code" should show up in what comes back.
   */
  createInterview = (candidateId: string, taskPrompt: string): Interview => {
    const candidate = this.list().find((item) => item.id === candidateId);
    if (!candidate) throw new Error('候选人不存在');
    const prompt = taskPrompt.trim();
    if (!prompt) throw new Error('试跑任务不能为空');

    const now = Date.now();
    const id = `intv-${crypto.randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO interview
           (id, candidate_id, candidate_name, candidate_role, task_prompt, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(id, candidateId, candidate.name, candidate.role, prompt, now);

    return this.readInterview(id)!;
  };

  /**
   * Runs a trial and records the outcome.
   *
   * Failure is a recorded state, not a thrown error: "这个候选人试跑挂了" is exactly the
   * information the boss needs, and a failed row must not disappear from the list.
   */
  runInterview = async (interviewId: string): Promise<Interview> => {
    const interview = this.readInterview(interviewId);
    if (!interview) throw new Error('面试记录不存在');
    if (interview.status === 'done') throw new Error('这次试跑已经跑完了');
    if (interview.status === 'running') throw new Error('这次试跑正在运行');
    if (!this.runTrial) throw new Error('没有可用的模型，无法试跑');
    const candidate = interview.candidateId
      ? this.list().find((item) => item.id === interview.candidateId)
      : undefined;
    if (!candidate) throw new Error('候选人已不在市场里');

    const startedAt = Date.now();
    this.db
      .prepare("UPDATE interview SET status = 'running', error = NULL WHERE id = ?")
      .run(interviewId);

    try {
      const outcome = await this.runTrial({ candidate, prompt: interview.taskPrompt });
      this.db
        .prepare(
          `UPDATE interview
              SET status = 'done', result = ?, tokens_used = ?, cost_usd = ?,
                  duration_ms = ?, finished_at = ?
            WHERE id = ?`,
        )
        .run(outcome.text, outcome.tokens, outcome.costUsd, Date.now() - startedAt, Date.now(), interviewId);
    } catch (error) {
      this.db
        .prepare(
          `UPDATE interview
              SET status = 'failed', error = ?, duration_ms = ?, finished_at = ?
            WHERE id = ?`,
        )
        .run(error instanceof Error ? error.message : String(error), Date.now() - startedAt, Date.now(), interviewId);
    }

    return this.readInterview(interviewId)!;
  };

  /**
   * Records the boss's decision.
   *
   * `hire` runs the same `hire` path the market card uses, so a candidate who passed a
   * trial is not hired through a second, subtly different code path. `reject` keeps the
   * candidate in the market: "not this role" is not the same as "remove from the pool".
   */
  decideInterview = (input: {
    interviewId: string;
    decision: InterviewDecision;
    departmentId?: string;
    reportsToEmployeeId?: string;
    jobId?: string;
  }): { interview: Interview; employeeId?: string } => {
    const interview = this.readInterview(input.interviewId);
    if (!interview) throw new Error('面试记录不存在');
    if (interview.status !== 'done') throw new Error('试跑还没跑完，先跑完再决定');
    if (interview.decision) throw new Error('这次试跑已经决定过了');

    if (input.decision === 'reject') {
      this.db.prepare("UPDATE interview SET decision = 'reject' WHERE id = ?").run(input.interviewId);
      return { interview: this.readInterview(input.interviewId)! };
    }

    if (!interview.candidateId) throw new Error('候选人已不在市场里，无法录用');
    if (!input.departmentId) throw new Error('录用需要指定部门');

    let employeeId = '';
    this.db.transaction(() => {
      const hired = this.hire(interview.candidateId!, {
        departmentId: input.departmentId!,
        reportsToEmployeeId: input.reportsToEmployeeId,
        jobId: input.jobId,
      });
      employeeId = hired.employeeId;
      this.db
        .prepare("UPDATE interview SET decision = 'hire' WHERE id = ?")
        .run(input.interviewId);
    })();

    return { interview: this.readInterview(input.interviewId)!, employeeId };
  };

  // ── 员工包 ──────────────────────────────────────────────────────────────

  /** Recorded exports, newest first. */
  packages = (): EmployeePackageRecord[] => {
    const rows = this.db
      .prepare('SELECT * FROM employee_package ORDER BY created_at DESC')
      .all() as {
      id: string;
      kind: EmployeePackageRecord['kind'];
      name: string;
      version: string;
      description: string;
      file_path: string;
      file_hash: string;
      file_size: number;
      manifest: string;
      license: string;
      created_at: number;
    }[];

    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      name: row.name,
      version: row.version,
      description: row.description,
      filePath: row.file_path,
      fileHash: row.file_hash,
      fileSize: row.file_size,
      members: (JSON.parse(row.manifest || '{}') as { members?: EmployeePackageRecord['members'] }).members ?? [],
      license: row.license,
      createdAt: row.created_at,
    }));
  };

  /**
   * Writes an employee package to disk and records the receipt.
   *
   * The manifest is the same `opc-agent-package@1` envelope `importJson` reads, so an
   * exported person can be imported back on another machine through the existing
   * "导入本地 Agent 包" path. The hash is taken over the exact bytes written.
   */
  exportPackage = async (input: ExportPackageInput): Promise<EmployeePackageRecord> => {
    const everyone = this.org.everyone();
    const selected = input.employeeIds?.length
      ? everyone.filter((member) => input.employeeIds!.includes(member.id))
      : everyone.filter((member) => member.status === 'active');
    if (selected.length === 0) throw new Error('没有可导出的员工');

    const name = input.name.trim();
    if (!name) throw new Error('包名不能为空');

    const departments = this.org.list();
    const members = selected.map((member) => ({
      name: member.name,
      role: member.role,
      level: member.level,
      department: departments.find((node) => node.id === member.departmentId)?.name ?? '',
    }));

    const manifest = {
      format: PACKAGE_FORMAT,
      version: PACKAGE_VERSION,
      kind: input.kind,
      name,
      description: (input.description ?? '').trim(),
      license: (input.license ?? '').trim(),
      exportedAt: new Date().toISOString(),
      // The importable half: exactly what `parseAgentPackage` expects.
      agents: selected.map((member) => ({
        name: member.name,
        role: member.role,
        level: member.level,
        model: member.model,
        skills: member.skills,
        persona: member.persona,
        // Not read by the importer; kept so a package stays self-describing.
        department: departments.find((node) => node.id === member.departmentId)?.name ?? '',
        title: member.title,
      })),
      members,
    };
    const body = `${JSON.stringify(manifest, null, 2)}\n`;

    await mkdir(dirname(input.filePath), { recursive: true });
    await writeFile(input.filePath, body, 'utf8');

    const id = `pkg-${crypto.randomUUID()}`;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO employee_package
           (id, kind, name, version, description, file_path, file_hash, file_size, manifest, license, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.kind,
        name,
        PACKAGE_VERSION,
        (input.description ?? '').trim(),
        input.filePath,
        crypto.createHash('sha256').update(body).digest('hex'),
        Buffer.byteLength(body, 'utf8'),
        JSON.stringify({ members }),
        (input.license ?? '').trim(),
        now,
      );

    return this.packages().find((entry) => entry.id === id)!;
  };

  /** True when the file on disk still matches the hash recorded at export time. */
  verifyPackage = async (packageId: string): Promise<{ ok: boolean; reason?: string }> => {
    const record = this.packages().find((entry) => entry.id === packageId);
    if (!record) throw new Error('导出记录不存在');
    let raw: string;
    try {
      raw = await readFile(record.filePath, 'utf8');
    } catch {
      return { ok: false, reason: '文件已不存在' };
    }
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    return hash === record.fileHash ? { ok: true } : { ok: false, reason: '文件内容已改变' };
  };
}

interface InterviewRow {
  id: string;
  candidate_id: string | null;
  candidate_name: string;
  candidate_role: string;
  task_prompt: string;
  status: InterviewStatus;
  decision: InterviewDecision | null;
  result: string;
  error: string | null;
  tokens_used: number;
  cost_usd: number;
  duration_ms: number | null;
  created_at: number;
  finished_at: number | null;
}

function toInterview(row: InterviewRow): Interview {
  return {
    id: row.id,
    ...(row.candidate_id ? { candidateId: row.candidate_id } : {}),
    candidateName: row.candidate_name,
    candidateRole: row.candidate_role,
    taskPrompt: row.task_prompt,
    status: row.status,
    ...(row.decision ? { decision: row.decision } : {}),
    result: row.result,
    ...(row.error ? { error: row.error } : {}),
    tokensUsed: row.tokens_used,
    costUsd: row.cost_usd,
    ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
    createdAt: row.created_at,
    ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
  };
}
