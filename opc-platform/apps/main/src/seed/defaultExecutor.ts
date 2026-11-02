import type { Agent } from '@opc/shared/domain';
import type { OrgService } from '../org/orgService';
import { agentsFromOrg } from './firstCompany';

/**
 * 全新安装时唯一需要的那个人。
 *
 * 产品走到这一步，界面上已经没有招聘、没有部门、没有组织架构了 —— 但派活仍然
 * 需要一个执行体（工具注册表和模型目前从 employee 上取）。所以首次运行时自动
 * 建**一个**，而不是像以前那样塞一个六个人的演示公司。
 *
 * 这不是"造公司"，是"保证有人干活"。等 B4 真正把 `employee` 从运行时里摘掉，
 * 这个文件会变成「实例化一个 worker 模板」，那时候连这一个人都不需要预先存在。
 */
const EXECUTOR = {
  name: '小助手',
  role: '通用执行',
  level: 'P5',
  // 三个模板都要能落在它身上：pickWorker 命中不了别人时也必须有人能干。
  skills: ['TypeScript', 'Node.js', 'Python', '调研', '写作', '分析', '部署', '运维'],
  persona: '只交付能验证的东西；验不了就说明为什么，不要把不确定说成确定。',
} as const;

const WORKSPACE = {
  name: '我的工作台',
  code: 'WS-01',
  description: '一个人 + 一个 AI。活从这里进来，也从这里出去。',
} as const;

export interface EnsureExecutorResult {
  created: boolean;
  employeeId: string | null;
}

/**
 * Idempotent: an installation that already has anyone keeps its roster.
 *
 * Deliberately one person, not a demo team: the boss should not have to delete
 * five strangers to get a working assistant.
 */
export function ensureDefaultExecutor(org: OrgService): EnsureExecutorResult {
  const existing: Agent[] = agentsFromOrg(org);
  if (existing.length > 0) return { created: false, employeeId: existing[0]?.id ?? null };

  const department = org.createDepartment(WORKSPACE);
  const hired = org.hire({
    name: EXECUTOR.name,
    role: EXECUTOR.role,
    level: EXECUTOR.level,
    skills: [...EXECUTOR.skills],
    persona: EXECUTOR.persona,
    departmentId: department.id,
    isHead: true,
  });
  org.ensureDistinctColors();
  return { created: true, employeeId: hired.id };
}
