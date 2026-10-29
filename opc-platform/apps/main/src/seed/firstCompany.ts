import type { Agent, DepartmentNode, HireInput } from '@opc/shared/domain';
import type { OrgService } from '../org/orgService';

/**
 * The company a fresh install actually starts with: two departments and a handful
 * of real employees, created through the same `hire` path the UI uses. No fixtures,
 * no fake conversations — delete the database and you get exactly this; everything
 * else (tasks, chats, artefacts) is created by using the product.
 *
 * Models are left empty on purpose: they inherit whatever provider the boss
 * configures, because a made-up model id would be a lie the runtime cannot honour.
 */
const STAFF = [
  {
    department: { name: '产品部', code: 'PD-01', description: '把老板的想法变成可验收的交付物。' },
    head: {
      name: '林岚',
      role: '产品负责人',
      level: 'P7',
      skills: ['需求拆解', '验收标准', '原型'],
      persona: '你要把模糊需求拆成可验收的条目，每条都要能被脚本判定。',
    },
    members: [
      {
        name: '周叙',
        role: '产品经理',
        level: 'P5',
        skills: ['用户故事', '竞品分析'],
        persona: '先写清交付物形态，再动手做；不确定就写下假设。',
      },
      {
        name: '陶然',
        role: '内容与文案',
        level: 'P4',
        skills: ['文案', '排版'],
        persona: '文字要短、要具体，不说空话。',
      },
    ],
  },
  {
    department: { name: '工程部', code: 'EN-01', description: '把交付物做成能跑起来的东西。' },
    head: {
      name: '沈聿',
      role: '技术负责人',
      level: 'P7',
      skills: ['Node.js', '架构', '评审'],
      persona: '只交付可运行、可复现的代码，并给出验证方式。',
    },
    members: [
      {
        name: '李雷',
        role: '全栈工程师',
        level: 'P5',
        skills: ['Node.js', 'SQLite', '前端'],
        persona: '用最小的依赖实现，交付前先自己跑一遍。',
      },
      {
        name: '韩梅梅',
        role: '测试工程师',
        level: 'P4',
        skills: ['测试用例', '自动化'],
        persona: '为每个交付写一条能失败的检查，再让它通过。',
      },
    ],
  },
];

/** Idempotent: does nothing once the company has departments. */
export function ensureFirstCompany(org: OrgService): {
  created: boolean;
  departments: number;
  employees: number;
} {
  const existing = org.list();
  if (existing.length > 0) {
    return {
      created: false,
      departments: existing.length,
      employees: existing.flatMap((department) => department.members).length,
    };
  }

  // 岗位是公司级职务：同名的只建一次，部门只负责给自己设编制。
  const jobIds = new Map<string, string>();
  const jobFor = (role: string, level: string, skills: string[], persona: string): string => {
    const existing = jobIds.get(role);
    if (existing) return existing;
    const job = org.createJob({ title: role, level, skills, description: persona });
    jobIds.set(role, job.id);
    return job.id;
  };

  for (const unit of STAFF) {
    const department = org.createDepartment(unit.department);
    const headJob = jobFor(unit.head.role, unit.head.level, unit.head.skills, unit.head.persona);
    org.setJobSeat({ jobId: headJob, departmentId: department.id, headcount: 1 });
    const head = org.hire({
      name: unit.head.name,
      role: unit.head.role,
      level: unit.head.level,
      departmentId: department.id,
      jobId: headJob,
      isHead: true,
      skills: unit.head.skills,
      persona: unit.head.persona,
    } satisfies HireInput);

    for (const member of unit.members) {
      const jobId = jobFor(member.role, member.level, member.skills, member.persona);
      org.setJobSeat({ jobId, departmentId: department.id, headcount: 1 });
      org.hire({
        name: member.name,
        role: member.role,
        level: member.level,
        departmentId: department.id,
        reportsToEmployeeId: head.id,
        jobId,
        skills: member.skills,
        persona: member.persona,
      } satisfies HireInput);
    }
  }

  const departments = org.list();
  org.ensureDistinctColors();
  return {
    created: true,
    departments: departments.length,
    employees: departments.flatMap((department) => department.members).length,
  };
}

/** Chat/pi need `Agent` rows; they come from the org table, not from fixtures. */
export function agentsFromDepartments(departments: DepartmentNode[]): Agent[] {
  return departments.flatMap((department) =>
    department.members.map((member) => ({
      id: member.id,
      name: member.name,
      role: member.role,
      level: member.level,
      departmentId: department.id,
      model: member.model,
      // `position` is the authority: a member row exists only while seated, and
      // `status` there is the employment state, not the agent's runtime state.
      status: 'online' as const,
      skills: member.skills,
      briefMd: member.persona,
    })),
  );
}

export function agentsFromOrg(org: OrgService): Agent[] {
  return agentsFromDepartments(org.list());
}

export function chatDepartmentsFromDepartments(departments: DepartmentNode[]) {
  return departments.map((department) => ({
    id: department.id,
    name: department.name,
    code: department.code,
    color: department.color,
    description: department.description,
    leadAgentId: department.headEmployeeId ?? '',
    groupConversationId: '',
  }));
}

export function chatDepartmentsFromOrg(org: OrgService) {
  return chatDepartmentsFromDepartments(org.list());
}
