import React from 'react';
import { Check, TrendingUp } from 'lucide-react';
import { AgentEmployee, CandidateAgent, Department } from '../../types/im';
import { StepHeader } from './onboardingShared';

export const parseDailyCost = (text: string) => Number.parseFloat(text.replace(/[^\d.]/g, '')) || 0;

interface StepTeamProps {
  agents: AgentEmployee[];
  departments: Department[];
  candidates: CandidateAgent[];
  /** candidateId -> target department for the current selection. */
  selection: Record<string, string>;
  onSelectionChange: (next: Record<string, string>) => void;
  /** candidateId -> department, for candidates already hired during this onboarding. */
  hired: Record<string, string>;
}

export const StepTeam: React.FC<StepTeamProps> = ({
  agents,
  departments,
  candidates,
  selection,
  onSelectionChange,
  hired,
}) => {
  const deptName = (id: string) => departments.find((d) => d.id === id)?.name ?? '未分配部门';
  const validDept = (id: string) => (departments.some((d) => d.id === id) ? id : departments[0]?.id ?? id);

  const toggle = (cand: CandidateAgent) => {
    if (hired[cand.id]) return;
    const next = { ...selection };
    if (next[cand.id]) delete next[cand.id];
    else next[cand.id] = validDept(cand.recommendedDeptId);
    onSelectionChange(next);
  };

  const pending = candidates.filter((c) => selection[c.id] && !hired[c.id]);
  const dailyCost = pending.reduce((sum, c) => sum + parseDailyCost(c.tokenCostPerDay), 0);

  // Quick presets: one per department that has recommended candidates.
  const presets = departments
    .map((d) => ({ dept: d, members: candidates.filter((c) => c.recommendedDeptId === d.id && !hired[c.id]) }))
    .filter((p) => p.members.length > 0);

  const applyPreset = (members: CandidateAgent[]) => {
    const next = { ...selection };
    members.forEach((c) => {
      if (!hired[c.id]) next[c.id] = validDept(c.recommendedDeptId);
    });
    onSelectionChange(next);
  };

  return (
    <>
      <StepHeader
        eyebrow="组建团队"
        title="从人才市场聘用首批 Agent"
        description={`公司已有 ${agents.length} 名 Agent 员工、${departments.length} 个部门。挑选新成员加入，他们入职后会自动加入部门群并读取 brief.md。`}
        aside={
          <div className="text-right">
            <div className="flex justify-end -space-x-2 h-8">
              {pending.slice(0, 4).map((c) => (
                <img key={c.id} src={c.avatarUrl} alt="" className="w-8 h-8 rounded-full object-cover ring-2 ring-white onb-pop" />
              ))}
              {!pending.length && (
                <span className="w-8 h-8 rounded-full border border-dashed border-[#C7C7CC]" />
              )}
            </div>
            <div className="mt-1.5 text-[12px] text-[#6E6E73]">
              已选 <span className="font-semibold text-[#1C1C1E] tabular-nums">{pending.length}</span> 名 · 预计{' '}
              <span className="font-semibold text-[#1C1C1E] tabular-nums">¥{dailyCost.toFixed(1)}</span> / 天
            </div>
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-[12px] text-[#8E8E93] mr-1">快速组队</span>
        {presets.map(({ dept, members }) => (
          <button
            key={dept.id}
            type="button"
            onClick={() => applyPreset(members)}
            className="h-7 pl-2 pr-2.5 rounded-full border border-[#E5E5E7] bg-white hover:border-[#C7C7CC] flex items-center gap-1.5 text-[12px] text-[#3A3A3C] cursor-pointer transition-colors"
          >
            <span className="w-2 h-2 rounded-full" style={{ background: dept.color }} />
            {dept.name}
            <span className="text-[#AEAEB2] tabular-nums">{members.length}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={() => applyPreset(candidates)}
          className="h-7 px-2.5 rounded-full bg-[#0B0C10] text-white text-[12px] cursor-pointer hover:bg-[#2C2C2E] transition-colors"
        >
          全部聘用
        </button>
        {pending.length > 0 && (
          <button
            type="button"
            onClick={() => onSelectionChange(Object.fromEntries(Object.entries(selection).filter(([id]) => hired[id])))}
            className="h-7 px-2 text-[12px] text-[#8E8E93] hover:text-[#1C1C1E] cursor-pointer"
          >
            清空
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        {candidates.map((cand) => {
          const hiredDept = hired[cand.id];
          const selected = !!selection[cand.id] || !!hiredDept;
          const [shortName, title] = cand.name.split('·');
          return (
            <div
              key={cand.id}
              role="button"
              tabIndex={hiredDept ? -1 : 0}
              aria-pressed={selected}
              aria-disabled={!!hiredDept}
              onClick={() => toggle(cand)}
              onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
                  e.preventDefault();
                  e.stopPropagation();
                  toggle(cand);
                }
              }}
              className={`relative rounded-2xl border bg-white p-4 transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0099FF]/40 ${
                hiredDept
                  ? 'border-[#BFE6C8] cursor-default'
                  : selected
                    ? 'border-[#0099FF] shadow-[0_0_0_3px_rgba(0,153,255,0.14),0_10px_28px_-14px_rgba(0,119,204,0.5)] cursor-pointer'
                    : 'border-[#E5E5E7] hover:border-[#C7C7CC] hover:-translate-y-px hover:shadow-[0_8px_24px_-14px_rgba(0,0,0,0.3)] cursor-pointer'
              }`}
            >
              <span
                className={`absolute top-3.5 right-3.5 w-5 h-5 rounded-full flex items-center justify-center transition-all ${
                  hiredDept ? 'bg-[#34C759]' : selected ? 'bg-[#0099FF]' : 'border-[1.5px] border-[#D1D1D6]'
                }`}
              >
                {selected && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
              </span>

              <div className="flex gap-3 pr-7">
                <img src={cand.avatarUrl} alt="" draggable={false} className="w-[52px] h-[52px] rounded-xl object-cover shrink-0" />
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[14px] font-bold text-[#1C1C1E]">{shortName}</span>
                    <span className="h-[18px] px-1.5 rounded bg-[#F2F2F5] text-[10.5px] font-semibold text-[#6E6E73] flex items-center">
                      {cand.level}
                    </span>
                  </div>
                  {title && <div className="text-[11.5px] text-[#0077CC] truncate">{title}</div>}
                  <div className="mt-0.5 text-[11.5px] text-[#6E6E73] truncate">{cand.role}</div>
                </div>
              </div>

              <div className="mt-3 flex items-center justify-between gap-2">
                <span className="h-6 px-2 rounded-md bg-[#E9F8EC] text-[#1E8E35] text-[11.5px] font-medium flex items-center gap-1">
                  <TrendingUp className="w-3 h-3" />
                  {cand.highlightMetric}
                </span>
                <span className="text-[11.5px] text-[#8E8E93] tabular-nums">{cand.tokenCostPerDay}</span>
              </div>

              <div className="mt-2.5 flex flex-wrap gap-1">
                {cand.skills.slice(0, 3).map((s) => (
                  <span key={s} className="h-5 px-1.5 rounded bg-[#F5F5F7] text-[10.5px] text-[#545458] flex items-center">
                    {s}
                  </span>
                ))}
              </div>

              <div className="mt-3 pt-3 border-t border-[#F0F0F2] flex items-center gap-2">
                {hiredDept ? (
                  <span className="text-[11.5px] font-medium text-[#1E8E35]">已入职 · {deptName(hiredDept)}</span>
                ) : (
                  <>
                    <span className="text-[11px] text-[#8E8E93] shrink-0">入职部门</span>
                    <select
                      aria-label={`${shortName} 的入职部门`}
                      value={selection[cand.id] ?? validDept(cand.recommendedDeptId)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                      onChange={(e) => onSelectionChange({ ...selection, [cand.id]: e.target.value })}
                      className="flex-1 min-w-0 h-7 rounded-md border border-[#E5E5E7] bg-[#FAFAFB] px-2 text-[11.5px] text-[#1C1C1E] outline-none focus:border-[#0099FF] cursor-pointer"
                    >
                      {departments.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
};
