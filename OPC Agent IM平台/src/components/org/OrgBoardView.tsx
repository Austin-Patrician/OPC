import React, { useEffect, useRef, useState } from 'react';
import { Cpu, MessageSquare, Move, Plus, Users } from 'lucide-react';
import { AgentEmployee, Department } from '../../types/im';
import {
  AgentAvatar,
  LeadMark,
  LevelTag,
  OrgSelection,
  StatusPill,
  activateOnKey,
  formatCost,
  getDeptLead,
  sortMembers,
  sumCost,
} from './orgShared';

interface OrgBoardViewProps {
  /** Always every department, so out-of-scope columns stay available as drop targets. */
  departments: Department[];
  agents: AgentEmployee[];
  allAgents: AgentEmployee[];
  scopeDeptId: string | null;
  selection: OrgSelection | null;
  onSelect: (selection: OrgSelection) => void;
  onStartDm: (agentId: string) => void;
  onOpenDeptGroup: (deptId: string) => void;
  onHireIntoDept: (deptId: string) => void;
  onTransfer: (agentId: string, deptId: string) => void;
}

export const OrgBoardView: React.FC<OrgBoardViewProps> = ({
  departments,
  agents,
  allAgents,
  scopeDeptId,
  selection,
  onSelect,
  onStartDm,
  onOpenDeptGroup,
  onHireIntoDept,
  onTransfer,
}) => {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overDeptId, setOverDeptId] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const draggingAgent = draggingId ? allAgents.find((a) => a.id === draggingId) : undefined;
  const scopeDept = departments.find((d) => d.id === scopeDeptId);

  // Bring the scoped column into view when the directory scope changes.
  useEffect(() => {
    if (!scopeDeptId) return;
    const scroller = scrollerRef.current;
    const column = scroller?.querySelector<HTMLElement>(`[data-dept-col="${scopeDeptId}"]`);
    if (!scroller || !column) return;
    scroller.scrollTo({
      left: column.offsetLeft - (scroller.clientWidth - column.offsetWidth) / 2,
      behavior: 'smooth',
    });
  }, [scopeDeptId]);

  const endDrag = () => {
    setDraggingId(null);
    setOverDeptId(null);
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-5 pt-3 flex items-center gap-1.5 text-[11.5px] text-[#8E8E93] shrink-0">
        <Move className="w-3.5 h-3.5" />
        <span className="truncate">
          {scopeDept
            ? `正在聚焦「${scopeDept.name}」，其余部门列保留为调岗目标`
            : '拖拽员工卡片到其他部门列，即可完成调岗'}
        </span>
      </div>

      <div ref={scrollerRef} className="flex-1 min-h-0 overflow-x-auto flex gap-3 px-5 pt-2.5 pb-5">
        {departments.map((dept) => {
          const lead = getDeptLead(dept, allAgents);
          const deptAll = allAgents.filter((a) => a.departmentId === dept.id);
          const outOfScope = !!scopeDeptId && dept.id !== scopeDeptId;
          const members = outOfScope
            ? []
            : sortMembers(
                agents.filter((a) => a.departmentId === dept.id),
                lead?.id
              );
          const canDrop = !!draggingAgent && draggingAgent.departmentId !== dept.id;
          const isOver = canDrop && overDeptId === dept.id;

          return (
            <section
              key={dept.id}
              data-dept-col={dept.id}
              onDragOver={(e) => {
                if (!canDrop) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (overDeptId !== dept.id) setOverDeptId(dept.id);
              }}
              onDragLeave={(e) => {
                if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                setOverDeptId((prev) => (prev === dept.id ? null : prev));
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (draggingAgent && canDrop) onTransfer(draggingAgent.id, dept.id);
                endDrag();
              }}
              className={`${outOfScope ? 'w-[220px]' : 'w-[280px]'} shrink-0 flex flex-col min-h-0 rounded-xl border transition-colors ${
                isOver
                  ? 'bg-[#E8F3FF] border-[#0099FF] border-dashed'
                  : canDrop
                    ? 'bg-[#EAEAEE] border-[#B9D6F2] border-dashed'
                    : outOfScope
                      ? 'bg-[#EFEFF2] border-transparent opacity-70'
                      : 'bg-[#EAEAEE] border-transparent'
              }`}
            >
              <header className="px-3 pt-3 pb-2.5 shrink-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className="w-2.5 h-2.5 rounded-[3px] shrink-0"
                    style={{ background: dept.color }}
                  />
                  <button
                    onClick={() => onSelect({ kind: 'dept', id: dept.id })}
                    className="text-[13px] font-semibold text-[#1C1C1E] truncate hover:text-[#0077CC] cursor-pointer"
                    title="查看部门档案"
                  >
                    {dept.name}
                  </button>
                  <span className="text-[11px] font-mono text-[#6E6E73] bg-white/80 px-1.5 rounded shrink-0">
                    {deptAll.length}
                  </span>
                  <span className="flex-1" />
                  <button
                    onClick={() => onOpenDeptGroup(dept.id)}
                    title="进入部门群"
                    className="w-6 h-6 rounded-md flex items-center justify-center text-[#6E6E73] hover:bg-white hover:text-[#0077CC] shrink-0 cursor-pointer"
                  >
                    <Users className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="mt-1 pl-[18px] flex items-center gap-1.5 text-[11px] text-[#8E8E93] min-w-0">
                  <span className="truncate">
                    {lead ? `负责人 ${lead.name}` : '负责人待任命'}
                  </span>
                  <span className="shrink-0">·</span>
                  <span className="font-mono text-[#10B981] shrink-0">
                    {formatCost(sumCost(deptAll))}/天
                  </span>
                </div>
              </header>

              <div className="flex-1 min-h-0 overflow-y-auto px-2 space-y-2">
                {isOver && (
                  <div className="h-[60px] rounded-[10px] border-2 border-dashed border-[#0099FF]/50 bg-white/70 flex items-center justify-center text-[11.5px] text-[#0077CC]">
                    松开即调岗至「{dept.name}」
                  </div>
                )}

                {members.map((ag) => {
                  const selected = selection?.kind === 'agent' && selection.id === ag.id;
                  return (
                    <div
                      key={ag.id}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', ag.id);
                        e.dataTransfer.effectAllowed = 'move';
                        setDraggingId(ag.id);
                      }}
                      onDragEnd={endDrag}
                      role="button"
                      tabIndex={0}
                      onClick={() => onSelect({ kind: 'agent', id: ag.id })}
                      onKeyDown={activateOnKey(() => onSelect({ kind: 'agent', id: ag.id }))}
                      className={`group bg-white rounded-[10px] border p-3 cursor-grab active:cursor-grabbing transition-all outline-none focus-visible:ring-2 focus-visible:ring-[#0099FF]/40 ${
                        draggingId === ag.id ? 'opacity-40' : ''
                      } ${
                        selected
                          ? 'border-[#0099FF] shadow-[0_0_0_3px_rgba(0,153,255,0.12)]'
                          : 'border-[#E4E4E8] hover:border-[#D0D0D6] hover:shadow-[0_4px_12px_-6px_rgba(0,0,0,0.18)]'
                      }`}
                    >
                      <div className="flex items-start gap-2.5">
                        <AgentAvatar agent={ag} size="sm" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1 min-w-0">
                            <span className="text-[12.5px] font-semibold text-[#1C1C1E] truncate">
                              {ag.name}
                            </span>
                            <LevelTag level={ag.level} />
                            {ag.id === lead?.id && <LeadMark />}
                          </div>
                          <div className="text-[11px] text-[#8E8E93] truncate mt-0.5">
                            {ag.role}
                          </div>
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onStartDm(ag.id);
                          }}
                          title="发起 1v1 对话"
                          className="w-6 h-6 -mr-1 rounded-md flex items-center justify-center text-[#0099FF] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-[#E8F3FF] shrink-0 cursor-pointer"
                        >
                          <MessageSquare className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      <div className="mt-2.5 flex items-center gap-1 text-[11px] text-[#6E6E73] min-w-0">
                        <Cpu className="w-3 h-3 text-[#0099FF] shrink-0" />
                        <span className="truncate">{ag.model}</span>
                      </div>

                      <div className="mt-2.5 pt-2.5 border-t border-[#F0F0F2] flex items-center justify-between gap-2">
                        <StatusPill status={ag.status} compact />
                        <span className="text-[11px] text-[#8E8E93] truncate">
                          <span className="font-mono text-[#10B981]">
                            {ag.tokenCostPerDay.replace(/\s/g, '')}
                          </span>
                          {' · '}
                          {ag.completedTasks} 单
                        </span>
                      </div>
                    </div>
                  );
                })}

                {outOfScope && !isOver && (
                  <div className="py-8 px-3 text-center text-[11.5px] leading-relaxed text-[#AEAEB2]">
                    不在当前查看范围
                    <br />
                    可将卡片拖入此列调岗
                  </div>
                )}

                {!outOfScope && members.length === 0 && !isOver && (
                  <div className="py-8 text-center text-[11.5px] text-[#AEAEB2]">
                    {deptAll.length ? '无匹配成员' : '暂无成员，可拖入或增聘'}
                  </div>
                )}
              </div>

              <div className="p-2 shrink-0">
                <button
                  onClick={() => onHireIntoDept(dept.id)}
                  className="w-full h-8 rounded-lg text-[12px] text-[#6E6E73] hover:bg-white/80 hover:text-[#0077CC] flex items-center justify-center gap-1 transition-colors cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  增聘 Agent 员工
                </button>
              </div>
            </section>
          );
        })}
        {/* Keeps right-side breathing room inside the horizontal scroller */}
        <div className="w-2 shrink-0" />
      </div>
    </div>
  );
};
