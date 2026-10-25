import React, { useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Cpu, MessageSquare } from 'lucide-react';
import { AgentEmployee, Department } from '../../types/im';
import {
  AgentAvatar,
  EmptyState,
  LeadMark,
  LevelTag,
  OrgSelection,
  STATUS_ORDER,
  StatusPill,
  formatCost,
  getDeptLead,
  hiredSortKey,
  levelRank,
  parseCost,
  sumCost,
  sumTasks,
} from './orgShared';

type SortKey = 'name' | 'level' | 'dept' | 'status' | 'cost' | 'tasks' | 'hired';
type SortDir = 'asc' | 'desc';

const COLUMNS: { key: SortKey | null; label: string; width?: string; align?: 'right' }[] = [
  { key: 'name', label: '员工' },
  { key: 'level', label: '职级', width: 'w-[76px]' },
  { key: 'dept', label: '所属部门', width: 'w-[196px]' },
  { key: 'status', label: '状态', width: 'w-[108px]' },
  { key: null, label: '底层模型', width: 'w-[220px]' },
  { key: 'cost', label: '算力日薪', width: 'w-[96px]', align: 'right' },
  { key: 'tasks', label: '已交付', width: 'w-[84px]', align: 'right' },
  { key: 'hired', label: '入职时间', width: 'w-[108px]' },
  { key: null, label: '操作', width: 'w-[92px]', align: 'right' },
];

// Numeric-style columns read best largest-first on the first click.
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  name: 'asc',
  level: 'desc',
  dept: 'asc',
  status: 'asc',
  cost: 'desc',
  tasks: 'desc',
  hired: 'desc',
};

interface OrgRosterViewProps {
  departments: Department[];
  agents: AgentEmployee[];
  allAgents: AgentEmployee[];
  selection: OrgSelection | null;
  onSelect: (selection: OrgSelection) => void;
  onStartDm: (agentId: string) => void;
  onResetFilters: () => void;
}

export const OrgRosterView: React.FC<OrgRosterViewProps> = ({
  departments,
  agents,
  allAgents,
  selection,
  onSelect,
  onStartDm,
  onResetFilters,
}) => {
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'dept', dir: 'asc' });

  const deptById = new Map(departments.map((d) => [d.id, d]));
  const deptIndex = new Map(departments.map((d, i) => [d.id, i]));
  const leadIds = new Set(
    departments.map((d) => getDeptLead(d, allAgents)?.id).filter(Boolean) as string[]
  );

  const compare = (a: AgentEmployee, b: AgentEmployee): number => {
    switch (sort.key) {
      case 'name':
        return a.name.localeCompare(b.name, 'zh-CN');
      case 'level':
        return levelRank(a.level) - levelRank(b.level);
      case 'status':
        return STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
      case 'cost':
        return parseCost(a.tokenCostPerDay) - parseCost(b.tokenCostPerDay);
      case 'tasks':
        return a.completedTasks - b.completedTasks;
      case 'hired':
        return hiredSortKey(a.hiredAt).localeCompare(hiredSortKey(b.hiredAt));
      case 'dept':
      default:
        return (
          (deptIndex.get(a.departmentId) ?? 999) - (deptIndex.get(b.departmentId) ?? 999) ||
          Number(leadIds.has(b.id)) - Number(leadIds.has(a.id)) ||
          levelRank(b.level) - levelRank(a.level)
        );
    }
  };

  const rows = [...agents].sort((a, b) => (sort.dir === 'asc' ? 1 : -1) * compare(a, b));

  const toggleSort = (key: SortKey) =>
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: DEFAULT_DIR[key] }
    );

  if (rows.length === 0) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto">
        <EmptyState onReset={onResetFilters} />
      </div>
    );
  }

  const cell = 'px-4 h-[58px] border-b border-[#F0F0F2] align-middle';

  return (
    <div className="flex-1 min-h-0 overflow-auto px-6 py-5">
      <div className="min-w-[1120px] rounded-xl bg-white border border-[#E5E5E7] overflow-clip">
        <table className="w-full table-fixed border-separate border-spacing-0 text-[12.5px]">
          <thead>
            <tr>
              {COLUMNS.map((col) => {
                const active = col.key !== null && sort.key === col.key;
                const SortIcon = !active ? ArrowUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown;
                return (
                  <th
                    key={col.label}
                    className={`sticky top-0 z-10 bg-[#F8F8FA] border-b border-[#E9E9EC] px-4 h-9 text-[11.5px] font-medium text-[#8E8E93] ${
                      col.width ?? ''
                    } ${col.align === 'right' ? 'text-right' : 'text-left'}`}
                  >
                    {col.key ? (
                      <button
                        onClick={() => toggleSort(col.key as SortKey)}
                        className={`inline-flex items-center gap-1 hover:text-[#1C1C1E] cursor-pointer ${
                          active ? 'text-[#1C1C1E]' : ''
                        }`}
                      >
                        {col.label}
                        <SortIcon
                          className={`w-3 h-3 ${active ? 'text-[#0099FF]' : 'text-[#C7C7CC]'}`}
                        />
                      </button>
                    ) : (
                      col.label
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((ag) => {
              const dept = deptById.get(ag.departmentId);
              const selected = selection?.kind === 'agent' && selection.id === ag.id;
              return (
                <tr
                  key={ag.id}
                  onClick={() => onSelect({ kind: 'agent', id: ag.id })}
                  className={`cursor-pointer transition-colors ${
                    selected ? 'bg-[#EEF6FF]' : 'hover:bg-[#F8F8FA]'
                  }`}
                >
                  <td className={cell}>
                    <div className="flex items-center gap-2.5 min-w-0">
                      <AgentAvatar agent={ag} size="sm" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1 min-w-0">
                          <span className="font-semibold text-[#1C1C1E] truncate">{ag.name}</span>
                          {leadIds.has(ag.id) && <LeadMark />}
                        </div>
                        <div className="text-[11px] text-[#8E8E93] truncate">{ag.role}</div>
                      </div>
                    </div>
                  </td>
                  <td className={cell}>
                    <LevelTag level={ag.level} />
                  </td>
                  <td className={cell}>
                    <div className="flex items-center gap-1.5 min-w-0 text-[#1C1C1E]">
                      <span
                        className="w-2 h-2 rounded-[3px] shrink-0"
                        style={{ background: dept?.color ?? '#C7C7CC' }}
                      />
                      <span className="truncate">{dept?.name ?? '未分配'}</span>
                    </div>
                  </td>
                  <td className={cell}>
                    <StatusPill status={ag.status} />
                  </td>
                  <td className={cell}>
                    <div className="flex items-center gap-1 min-w-0 text-[#555558]">
                      <Cpu className="w-3 h-3 text-[#0099FF] shrink-0" />
                      <span className="truncate">{ag.model}</span>
                    </div>
                  </td>
                  <td className={`${cell} text-right font-mono text-[#10B981]`}>
                    {formatCost(parseCost(ag.tokenCostPerDay))}
                  </td>
                  <td className={`${cell} text-right font-mono text-[#1C1C1E]`}>
                    {ag.completedTasks}
                  </td>
                  <td className={`${cell} font-mono text-[#6E6E73]`}>{ag.hiredAt}</td>
                  <td className={`${cell} text-right`}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onStartDm(ag.id);
                      }}
                      className="h-7 px-2.5 rounded-md text-[11.5px] font-medium text-[#0077CC] bg-[#0099FF]/10 hover:bg-[#0099FF]/20 inline-flex items-center gap-1 cursor-pointer"
                    >
                      <MessageSquare className="w-3 h-3" />
                      对话
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="px-4 h-10 flex items-center justify-between bg-[#FAFAFB] text-[11.5px] text-[#8E8E93]">
          <span>
            共 <strong className="text-[#1C1C1E] font-semibold">{rows.length}</strong> 名 Agent 员工
          </span>
          <span>
            日薪合计{' '}
            <strong className="font-mono text-[#10B981] font-semibold">
              {formatCost(sumCost(rows))}
            </strong>
            <span className="mx-2 text-[#D1D1D6]">|</span>
            累计交付{' '}
            <strong className="font-mono text-[#1C1C1E] font-semibold">{sumTasks(rows)}</strong> 单
          </span>
        </div>
      </div>
    </div>
  );
};
