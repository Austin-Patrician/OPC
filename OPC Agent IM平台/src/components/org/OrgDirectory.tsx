import React from 'react';
import { Building2, Plus } from 'lucide-react';
import { AgentEmployee, Department } from '../../types/im';
import { STATUS_META, STATUS_ORDER, formatCost, sumCost, sumTasks } from './orgShared';

interface OrgDirectoryProps {
  departments: Department[];
  agents: AgentEmployee[];
  scopeDeptId: string | null;
  onScope: (deptId: string | null) => void;
  onCreateDept: () => void;
}

export const OrgDirectory: React.FC<OrgDirectoryProps> = ({
  departments,
  agents,
  scopeDeptId,
  onScope,
  onCreateDept,
}) => {
  const headcount = (deptId: string) => agents.filter((a) => a.departmentId === deptId).length;
  const itemClass = (active: boolean) =>
    `w-full h-8 px-2 rounded-md flex items-center gap-2 text-[12.5px] transition-colors cursor-pointer ${
      active
        ? 'bg-[#E4E4E8] text-[#1C1C1E] font-medium'
        : 'text-[#3A3A3C] hover:bg-black/[0.04]'
    }`;

  return (
    <aside className="hidden xl:flex w-[232px] shrink-0 flex-col min-h-0 bg-[#F9F9FA] border-r border-[#E6E6E8]">
      <div className="h-11 px-4 flex items-center justify-between shrink-0">
        <span className="text-[12px] font-semibold text-[#6E6E73]">组织目录</span>
        <button
          onClick={onCreateDept}
          title="新增部门"
          className="w-6 h-6 rounded-md flex items-center justify-center text-[#7A7A7E] hover:bg-black/[0.05] hover:text-[#1C1C1E] cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto px-2 pb-3">
        <button onClick={() => onScope(null)} className={itemClass(scopeDeptId === null)}>
          <span className="w-5 h-5 rounded-md bg-[#0099FF] text-white flex items-center justify-center shrink-0">
            <Building2 className="w-3 h-3" />
          </span>
          <span className="flex-1 text-left truncate">OPC 一人公司</span>
          <span className="text-[11px] font-mono text-[#8E8E93]">{agents.length}</span>
        </button>

        <div className="ml-[17px] mt-0.5 pl-1.5 border-l border-[#E1E1E6] space-y-px">
          {departments.map((dept) => (
            <button
              key={dept.id}
              onClick={() => onScope(dept.id)}
              className={itemClass(scopeDeptId === dept.id)}
              title={dept.description}
            >
              <span
                className="w-2 h-2 rounded-[3px] shrink-0"
                style={{ background: dept.color }}
              />
              <span className="flex-1 text-left truncate">{dept.name}</span>
              <span className="text-[11px] font-mono text-[#8E8E93]">{headcount(dept.id)}</span>
            </button>
          ))}
        </div>
      </nav>

      {/* Headcount overview */}
      <div className="p-3 border-t border-[#E6E6E8] shrink-0">
        <div className="rounded-xl bg-white border border-[#E8E8EC] p-3">
          <div className="flex items-center justify-between text-[11px] text-[#8E8E93]">
            <span className="font-semibold">编制概览</span>
            <span className="font-mono">{departments.length} 个部门</span>
          </div>
          <div className="mt-2 flex items-baseline gap-1">
            <span className="text-[22px] font-bold font-mono text-[#1C1C1E] leading-none">
              {agents.length}
            </span>
            <span className="text-[11.5px] text-[#6E6E73]">名数字员工在岗</span>
          </div>

          <div className="mt-2.5 h-1.5 rounded-full overflow-hidden flex gap-px bg-[#F0F0F2]">
            {departments.map((dept) => {
              const count = headcount(dept.id);
              return count ? (
                <span
                  key={dept.id}
                  title={`${dept.name} · ${count} 名`}
                  style={{ flex: `${count} 1 0%`, background: dept.color }}
                />
              ) : null;
            })}
          </div>

          <div className="mt-3 space-y-1.5">
            {STATUS_ORDER.map((status) => (
              <div key={status} className="flex items-center justify-between text-[11.5px]">
                <span className="flex items-center gap-1.5 text-[#6E6E73]">
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ background: STATUS_META[status].color }}
                  />
                  {STATUS_META[status].label}
                </span>
                <span className="font-mono text-[#1C1C1E]">
                  {agents.filter((a) => a.status === status).length}
                </span>
              </div>
            ))}
          </div>

          <div className="mt-3 pt-2.5 border-t border-[#F0F0F2] grid grid-cols-2 gap-2">
            <div>
              <div className="text-[10.5px] text-[#8E8E93]">算力日薪</div>
              <div className="text-[13px] font-semibold font-mono text-[#10B981]">
                {formatCost(sumCost(agents))}
              </div>
            </div>
            <div>
              <div className="text-[10.5px] text-[#8E8E93]">累计交付</div>
              <div className="text-[13px] font-semibold font-mono text-[#1C1C1E]">
                {sumTasks(agents)}
                <span className="text-[10.5px] font-normal text-[#8E8E93] ml-0.5">单</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
};
