import React from 'react';
import { Cpu, MessageSquare, UserPlus, Users } from 'lucide-react';
import { AgentEmployee, Department } from '../../types/im';
import { AvatarIcon } from '../AvatarIcon';
import {
  EmptyState,
  LeadMark,
  LevelTag,
  Metric,
  OrgSelection,
  StatusPill,
  activateOnKey,
  formatCost,
  formatHiredAt,
  getDeptLead,
  parseCost,
  sortMembers,
} from './orgShared';

interface OrgBadgeViewProps {
  departments: Department[];
  agents: AgentEmployee[];
  allAgents: AgentEmployee[];
  selection: OrgSelection | null;
  onSelect: (selection: OrgSelection) => void;
  onStartDm: (agentId: string) => void;
  onOpenDeptGroup: (deptId: string) => void;
  onHireIntoDept: (deptId: string) => void;
  onResetFilters: () => void;
}

export const OrgBadgeView: React.FC<OrgBadgeViewProps> = ({
  departments,
  agents,
  allAgents,
  selection,
  onSelect,
  onStartDm,
  onOpenDeptGroup,
  onHireIntoDept,
  onResetFilters,
}) => {
  const sections = departments
    .map((dept) => {
      const lead = getDeptLead(dept, allAgents);
      return {
        dept,
        lead,
        headcount: allAgents.filter((a) => a.departmentId === dept.id).length,
        members: sortMembers(
          agents.filter((a) => a.departmentId === dept.id),
          lead?.id
        ),
      };
    })
    // Keep brand-new empty departments visible so they can be staffed.
    .filter((s) => s.members.length > 0 || s.headcount === 0);

  if (sections.length === 0) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto">
        <EmptyState onReset={onResetFilters} />
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-7">
      {sections.map(({ dept, lead, headcount, members }) => (
        <section key={dept.id}>
          <header className="flex items-center gap-2 mb-3">
            <span className="w-1 h-4 rounded-full" style={{ background: dept.color }} />
            <button
              onClick={() => onSelect({ kind: 'dept', id: dept.id })}
              className="text-[13.5px] font-bold text-[#1C1C1E] hover:text-[#0077CC] cursor-pointer"
            >
              {dept.name}
            </button>
            <span className="text-[10.5px] font-mono text-[#8E8E93]">{dept.code}</span>
            <span className="text-[11.5px] text-[#8E8E93]">· {headcount} 名</span>
            <span className="flex-1 h-px bg-[#E2E2E6] ml-2" />
            <button
              onClick={() => onOpenDeptGroup(dept.id)}
              className="h-7 px-2.5 rounded-md text-[11.5px] font-medium text-[#0077CC] bg-[#0099FF]/10 hover:bg-[#0099FF]/20 flex items-center gap-1 cursor-pointer"
            >
              <Users className="w-3.5 h-3.5" />
              部门群
            </button>
          </header>

          <div className="grid gap-3.5 grid-cols-[repeat(auto-fill,minmax(216px,1fr))]">
            {members.map((ag) => {
              const selected = selection?.kind === 'agent' && selection.id === ag.id;
              return (
                <div
                  key={ag.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect({ kind: 'agent', id: ag.id })}
                  onKeyDown={activateOnKey(() => onSelect({ kind: 'agent', id: ag.id }))}
                  className={`group relative rounded-2xl bg-white border overflow-hidden cursor-pointer transition-all outline-none focus-visible:ring-2 focus-visible:ring-[#0099FF]/40 ${
                    selected
                      ? 'border-[#0099FF] shadow-[0_0_0_3px_rgba(0,153,255,0.14)]'
                      : 'border-[#E4E4E8] hover:-translate-y-0.5 hover:shadow-[0_12px_28px_-14px_rgba(0,0,0,0.3)]'
                  }`}
                >
                  {/* Badge header band with lanyard slot */}
                  <div
                    className="relative h-[68px]"
                    style={{
                      background: `linear-gradient(135deg, ${dept.color}30 0%, ${dept.color}0D 100%)`,
                    }}
                  >
                    <span className="absolute top-2 left-1/2 -translate-x-1/2 w-10 h-[5px] rounded-full bg-white/90 shadow-[inset_0_1px_1px_rgba(0,0,0,0.15)]" />
                    <span
                      className="absolute top-2.5 left-3 text-[9.5px] font-mono font-semibold tracking-[0.08em]"
                      style={{ color: dept.color }}
                    >
                      {dept.code}
                    </span>
                    <span className="absolute top-2 right-2.5">
                      <StatusPill status={ag.status} compact />
                    </span>
                  </div>

                  <div className="px-4 pb-4 -mt-8 flex flex-col items-center text-center">
                    <span className="inline-flex rounded-full ring-4 ring-white bg-white">
                      <AvatarIcon
                        type={ag.avatarType}
                        avatarUrl={ag.avatarUrl}
                        name={ag.name}
                        size="xl"
                      />
                    </span>
                    <div className="mt-2 flex items-center justify-center gap-1 max-w-full min-w-0">
                      <span className="text-[14px] font-bold text-[#1C1C1E] truncate">
                        {ag.name}
                      </span>
                      <LevelTag level={ag.level} />
                      {ag.id === lead?.id && <LeadMark />}
                    </div>
                    <div className="mt-0.5 text-[11.5px] text-[#6E6E73] truncate max-w-full">
                      {ag.role}
                    </div>

                    <div className="mt-3 w-full grid grid-cols-3 rounded-lg bg-[#F6F6F8] py-2">
                      <Metric value={ag.completedTasks} label="交付单" />
                      <Metric
                        value={formatCost(parseCost(ag.tokenCostPerDay))}
                        label="日薪"
                        className="border-x border-[#E8E8EC]"
                      />
                      <Metric value={formatHiredAt(ag.hiredAt)} label="入职" />
                    </div>

                    <div className="mt-2.5 w-full flex items-center justify-center gap-1 text-[11px] text-[#6E6E73] min-w-0">
                      <Cpu className="w-3 h-3 text-[#0099FF] shrink-0" />
                      <span className="truncate">{ag.model}</span>
                    </div>

                    <div className="mt-2 h-[42px] flex flex-wrap content-start justify-center gap-1 overflow-hidden">
                      {ag.skills.slice(0, 3).map((skill) => (
                        <span
                          key={skill}
                          className="text-[10.5px] px-1.5 py-0.5 rounded bg-[#F2F2F5] text-[#555558] max-w-full truncate"
                        >
                          {skill}
                        </span>
                      ))}
                    </div>

                    <div className="mt-3 w-full grid grid-cols-[1fr_auto] gap-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onStartDm(ag.id);
                        }}
                        className="h-8 rounded-lg bg-[#0099FF] hover:bg-[#0086E0] text-white text-[12px] font-medium flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                      >
                        <MessageSquare className="w-3.5 h-3.5" />
                        开对话
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenDeptGroup(dept.id);
                        }}
                        title="进入部门群"
                        className="h-8 w-8 rounded-lg bg-[#F2F2F5] hover:bg-[#E8E8EC] text-[#555558] flex items-center justify-center transition-colors cursor-pointer"
                      >
                        <Users className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}

            {headcount === 0 && (
              <button
                onClick={() => onHireIntoDept(dept.id)}
                className="min-h-[200px] rounded-2xl border border-dashed border-[#C7C7CC] hover:border-[#0099FF] text-[12px] text-[#8E8E93] hover:text-[#0077CC] flex flex-col items-center justify-center gap-2 transition-colors cursor-pointer"
              >
                <UserPlus className="w-5 h-5" />
                部门暂无成员，去增聘
              </button>
            )}
          </div>
        </section>
      ))}
    </div>
  );
};
