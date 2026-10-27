import type { AcceptanceTemplate, CreateTaskInput } from '@opc/shared/domain';
import type { CompanyDatabase } from '../data/companyDatabase';
import type { OrgService } from '../org/orgService';
import type { ProjectService } from '../org/projectService';
import type { WorkService } from '../work/workService';

/**
 * 公司模板：把一个真实团队一次性建好（部门 / 员工 / 汇报线 / 项目 / 待办）。
 *
 * 它**不是** fixture：每个动作都走与 UI 相同的服务（`org.hire`、`projects.assign`、
 * `work.createTask`），所以建出来的就是老板自己点出来的那些行 —— 只是可以重复执行、
 * 可以用来重建一个公司。
 *
 * 幂等：同名部门、同部门同名员工、同编号项目、同标题任务都会跳过；
 * 二次执行只报告 "已存在"，不会产生重复的人。
 */
export const COMPANY_SETUP_FORMAT = 'opc-company-setup@1';

export interface CompanySetupEmployee {
  name: string;
  role: string;
  level?: string;
  /** 岗位标题（不填则用 role）。 */
  title?: string;
  department: string;
  /** 汇报对象姓名；部门负责人留空。 */
  reportsTo?: string;
  skills?: string[];
  /** 人格 / 工作规范，会进 system prompt，≤300 token。 */
  persona: string;
  /** 留给市场导入；这里一般留空，继承全局默认模型。 */
  model?: string;
}

export interface CompanySetupTask {
  title: string;
  brief: string;
  deliverableSpec: string;
  assignee: string;
  project?: string;
  estTokens?: number;
  priority?: 'P0' | 'P1' | 'P2' | 'P3';
  labels?: string[];
  dueInDays?: number;
  acceptanceTemplate?: AcceptanceTemplate;
}

export interface CompanySetupSpec {
  format?: string;
  company?: { name?: string; industry?: string };
  departments: { name: string; code?: string; description?: string; head?: string }[];
  employees: CompanySetupEmployee[];
  projects?: {
    name: string;
    code?: string;
    description?: string;
    department?: string;
    members?: { employee: string; role?: string }[];
  }[];
  tasks?: CompanySetupTask[];
}

export interface CompanySetupReport {
  company: string;
  departments: { name: string; created: boolean; head?: string }[];
  employees: { name: string; created: boolean; employeeId?: string; reportsTo?: string; isHead: boolean }[];
  projects: { name: string; created: boolean; members: number }[];
  tasks: { title: string; created: boolean; assignee: string; taskId?: string; error?: string }[];
  warnings: string[];
}

export interface CompanySetupDeps {
  db: CompanyDatabase;
  org: OrgService;
  projects: ProjectService;
  work: WorkService;
}

export function parseCompanySetup(raw: string): CompanySetupSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`公司模板不是合法 JSON：${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('公司模板必须是 JSON 对象');
  const spec = parsed as CompanySetupSpec;
  if (spec.format && spec.format !== COMPANY_SETUP_FORMAT) {
    throw new Error(`不支持的公司模板格式：${spec.format}（需要 ${COMPANY_SETUP_FORMAT}）`);
  }
  if (!Array.isArray(spec.departments) || spec.departments.length === 0) {
    throw new Error('公司模板至少要有一个部门');
  }
  if (!Array.isArray(spec.employees) || spec.employees.length === 0) {
    throw new Error('公司模板至少要有一名员工');
  }
  for (const employee of spec.employees) {
    if (!employee.name?.trim() || !employee.role?.trim() || !employee.persona?.trim()) {
      throw new Error(`员工条目缺少 name/role/persona：${JSON.stringify(employee)}`);
    }
    if (!spec.departments.some((department) => department.name === employee.department)) {
      throw new Error(`${employee.name} 的部门「${employee.department}」不在 departments 里`);
    }
  }
  return spec;
}

/**
 * Applies the template. Returns what happened per entity so the caller can print a
 * report instead of claiming success blindly.
 */
export function applyCompanySetup(deps: CompanySetupDeps, spec: CompanySetupSpec): CompanySetupReport {
  const report: CompanySetupReport = {
    company: spec.company?.name?.trim() || '我的公司',
    departments: [],
    employees: [],
    projects: [],
    tasks: [],
    warnings: [],
  };

  const now = Date.now();
  deps.db
    .prepare(
      `UPDATE company SET name = ?, industry = COALESCE(?, industry), updated_at = ? WHERE id = 'company-local'`,
    )
    .run(report.company, spec.company?.industry ?? null, now);

  // ── 部门 ────────────────────────────────────────────────────────────────
  const departmentIdByName = new Map<string, string>();
  for (const department of spec.departments) {
    const existing = deps.org.list().find((node) => node.name.trim() === department.name.trim());
    if (existing) {
      departmentIdByName.set(department.name, existing.id);
      report.departments.push({ name: department.name, created: false, ...(department.head ? { head: department.head } : {}) });
      continue;
    }
    const created = deps.org.createDepartment({
      name: department.name,
      ...(department.code ? { code: department.code } : {}),
      ...(department.description ? { description: department.description } : {}),
    });
    departmentIdByName.set(department.name, created.id);
    report.departments.push({ name: department.name, created: true, ...(department.head ? { head: department.head } : {}) });
  }

  // ── 员工（先招负责人，再招需要汇报给他的人）────────────────────────────
  const headByDepartment = new Map(
    spec.departments.flatMap((department) =>
      department.head ? [[department.name, department.head] as const] : [],
    ),
  );
  const existingNames = new Set(
    deps.org.list().flatMap((node) => node.members.map((member) => `${node.name}:${member.name}`)),
  );
  const employeeIdByName = new Map<string, string>();
  for (const node of deps.org.list()) {
    for (const member of node.members) employeeIdByName.set(member.name, member.id);
  }

  const pending = [...spec.employees];
  let guard = pending.length + 1;
  while (pending.length > 0 && guard > 0) {
    guard -= 1;
    const next: CompanySetupEmployee[] = [];
    for (const employee of pending) {
      const managerId = employee.reportsTo ? employeeIdByName.get(employee.reportsTo) : undefined;
      // A report can only be hired once its manager exists.
      if (employee.reportsTo && !managerId) {
        next.push(employee);
        continue;
      }

      const isHead = headByDepartment.get(employee.department) === employee.name;
      const key = `${employee.department}:${employee.name}`;
      if (existingNames.has(key)) {
        report.employees.push({ name: employee.name, created: false, reportsTo: employee.reportsTo ?? '', isHead });
        continue;
      }

      const hired = deps.org.hire({
        name: employee.name,
        role: employee.role,
        ...(employee.level ? { level: employee.level } : {}),
        ...(employee.title ? { title: employee.title } : {}),
        ...(employee.model ? { model: employee.model } : {}),
        ...(employee.skills ? { skills: employee.skills } : {}),
        persona: employee.persona,
        departmentId: departmentIdByName.get(employee.department)!,
        ...(managerId ? { reportsToEmployeeId: managerId } : {}),
        isHead,
      });
      employeeIdByName.set(employee.name, hired.id);
      existingNames.add(key);
      report.employees.push({
        name: employee.name,
        created: true,
        employeeId: hired.id,
        reportsTo: employee.reportsTo ?? '',
        isHead,
      });
    }
    if (next.length === pending.length) {
      for (const employee of next) {
        report.warnings.push(`${employee.name} 的汇报对象「${employee.reportsTo}」找不到，已跳过`);
      }
      break;
    }
    pending.length = 0;
    pending.push(...next);
  }

  // ── 项目与任职 ──────────────────────────────────────────────────────────
  const projectIdByName = new Map<string, string>();
  for (const project of spec.projects ?? []) {
    const existing = deps.projects
      .list({ includeArchived: true })
      .find((item) => (project.code ? item.code === project.code.toUpperCase() : item.name === project.name));
    const projectId = existing
      ? existing.id
      : deps.projects.create({
          name: project.name,
          ...(project.code ? { code: project.code } : {}),
          ...(project.description ? { description: project.description } : {}),
          ...(project.department ? { departmentId: departmentIdByName.get(project.department) ?? '' } : {}),
        }).id;
    projectIdByName.set(project.name, projectId);

    let members = 0;
    for (const member of project.members ?? []) {
      const employeeId = employeeIdByName.get(member.employee);
      if (!employeeId) {
        report.warnings.push(`项目「${project.name}」的成员「${member.employee}」不存在，已跳过`);
        continue;
      }
      deps.projects.assign(projectId, employeeId, member.role ?? '');
      members += 1;
    }
    report.projects.push({ name: project.name, created: !existing, members });
  }

  // ── 待办 ────────────────────────────────────────────────────────────────
  const existingTitles = new Set(deps.work.listAllTasks().map((task) => task.title));
  for (const task of spec.tasks ?? []) {
    if (existingTitles.has(task.title)) {
      report.tasks.push({ title: task.title, created: false, assignee: task.assignee });
      continue;
    }
    const assigneeId = employeeIdByName.get(task.assignee);
    if (!assigneeId) {
      report.tasks.push({ title: task.title, created: false, assignee: task.assignee, error: '员工不存在' });
      continue;
    }

    const input: CreateTaskInput = {
      title: task.title,
      brief: task.brief,
      deliverableSpec: task.deliverableSpec,
      assigneeId,
      ...(task.project && projectIdByName.get(task.project)
        ? { projectGroupId: projectIdByName.get(task.project)! }
        : {}),
      estTokens: task.estTokens ?? 6_000,
      acceptanceCommand: ['node', '{checks}/verify.mjs'],
      acceptanceTemplate: task.acceptanceTemplate ?? 'node-test',
    };

    const created = deps.work.createTask(input);
    if (!created.ok) {
      report.tasks.push({
        title: task.title,
        created: false,
        assignee: task.assignee,
        error: `${created.error.code}: ${created.error.message}`,
      });
      continue;
    }

    if (task.priority || task.labels || task.dueInDays !== undefined) {
      deps.work.setIssueMeta(created.task.id, {
        ...(task.priority ? { priority: task.priority } : {}),
        ...(task.labels ? { labels: task.labels } : {}),
        ...(task.dueInDays !== undefined ? { dueAt: now + task.dueInDays * 24 * 60 * 60 * 1000 } : {}),
      });
    }
    existingTitles.add(task.title);
    report.tasks.push({ title: task.title, created: true, assignee: task.assignee, taskId: created.task.id });
  }

  return report;
}
