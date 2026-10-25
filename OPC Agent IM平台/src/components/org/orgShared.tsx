import React from 'react';
import { Crown, ScanSearch } from 'lucide-react';
import { AgentEmployee, AgentStatus, Department } from '../../types/im';
import { AvatarIcon } from '../AvatarIcon';

export type OrgViewMode = 'tree' | 'board' | 'badge' | 'roster';
export type StatusFilter = 'all' | AgentStatus;
export interface OrgSelection {
  kind: 'agent' | 'dept';
  id: string;
}

export const STATUS_META: Record<
  AgentStatus,
  { label: string; color: string; bg: string; text: string }
> = {
  working: { label: '执行中', color: '#0099FF', bg: '#E8F3FF', text: '#0066CC' },
  online: { label: '在线待命', color: '#27C93F', bg: '#E9F8EC', text: '#1E8E35' },
  idle: { label: '空闲', color: '#AEAEB2', bg: '#F2F2F5', text: '#6E6E73' },
};

export const STATUS_ORDER: AgentStatus[] = ['working', 'online', 'idle'];

export const parseCost = (cost: string) => parseFloat(cost.replace(/[^\d.]/g, '')) || 0;
export const sumCost = (list: AgentEmployee[]) =>
  list.reduce((acc, a) => acc + parseCost(a.tokenCostPerDay), 0);
export const formatCost = (value: number) => `¥${value.toFixed(1)}`;
export const sumTasks = (list: AgentEmployee[]) =>
  list.reduce((acc, a) => acc + a.completedTasks, 0);

// Management levels (M*) always rank above individual-contributor levels (P*).
export const levelRank = (level: string) => {
  const n = parseInt(level.replace(/\D/g, ''), 10) || 0;
  return level.trim().toUpperCase().startsWith('M') ? 100 + n : n;
};
export const isManagerLevel = (level: string) => level.trim().toUpperCase().startsWith('M');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const formatHiredAt = (hiredAt: string) =>
  ISO_DATE.test(hiredAt) ? hiredAt.slice(5) : hiredAt.replace('入职', '');
// Non-date values such as "刚刚入职" sort as the most recent hire.
export const hiredSortKey = (hiredAt: string) => (ISO_DATE.test(hiredAt) ? hiredAt : '9999-99-99');

/** A lead only counts while that agent still belongs to the department. */
export const getDeptLead = (dept: Department, agents: AgentEmployee[]) =>
  agents.find((a) => a.id === dept.leadAgentId && a.departmentId === dept.id);

export const sortMembers = (members: AgentEmployee[], leadId?: string) =>
  [...members].sort((a, b) => {
    if (a.id === leadId) return -1;
    if (b.id === leadId) return 1;
    return levelRank(b.level) - levelRank(a.level) || b.completedTasks - a.completedTasks;
  });

/** Keyboard activation for non-button elements that contain nested buttons. */
export const activateOnKey = (fn: () => void) => (e: React.KeyboardEvent) => {
  if (e.target !== e.currentTarget) return;
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fn();
  }
};

export const LevelTag: React.FC<{ level: string }> = ({ level }) => (
  <span
    className={`shrink-0 text-[10px] leading-4 font-mono font-semibold px-1.5 rounded ${
      isManagerLevel(level) ? 'bg-[#FFF4E5] text-[#B76E00]' : 'bg-[#E8F3FF] text-[#0066CC]'
    }`}
  >
    {level}
  </span>
);

export const LeadMark: React.FC = () => (
  <span title="部门负责人" className="inline-flex shrink-0">
    <Crown className="w-3 h-3 text-[#F5A623]" />
  </span>
);

export const StatusPill: React.FC<{ status: AgentStatus; compact?: boolean }> = ({
  status,
  compact = false,
}) => {
  const meta = STATUS_META[status];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-medium shrink-0 whitespace-nowrap ${
        compact ? 'text-[10px] px-1.5 h-[18px]' : 'text-[11px] px-2 h-5'
      }`}
      style={{ background: meta.bg, color: meta.text }}
    >
      <span className="relative flex w-1.5 h-1.5">
        {status === 'working' && (
          <span
            className="absolute inset-0 rounded-full animate-ping opacity-60"
            style={{ background: meta.color }}
          />
        )}
        <span className="relative w-1.5 h-1.5 rounded-full" style={{ background: meta.color }} />
      </span>
      {meta.label}
    </span>
  );
};

const DOT_SIZE = {
  xs: 'w-2 h-2',
  sm: 'w-2.5 h-2.5',
  md: 'w-3 h-3',
  lg: 'w-3 h-3',
  xl: 'w-3.5 h-3.5',
} as const;

export const AgentAvatar: React.FC<{ agent: AgentEmployee; size?: keyof typeof DOT_SIZE }> = ({
  agent,
  size = 'sm',
}) => (
  <span className="relative inline-flex shrink-0">
    <AvatarIcon type={agent.avatarType} avatarUrl={agent.avatarUrl} name={agent.name} size={size} />
    <span
      className={`absolute bottom-0 right-0 rounded-full ring-2 ring-white ${DOT_SIZE[size]}`}
      style={{ background: STATUS_META[agent.status].color }}
      title={STATUS_META[agent.status].label}
    />
  </span>
);

export const Metric: React.FC<{ value: React.ReactNode; label: string; className?: string }> = ({
  value,
  label,
  className = '',
}) => (
  <div className={`min-w-0 text-center ${className}`}>
    <div className="text-[12.5px] font-semibold font-mono text-[#1C1C1E] truncate leading-tight">
      {value}
    </div>
    <div className="text-[10px] text-[#8E8E93] mt-0.5">{label}</div>
  </div>
);

export const EmptyState: React.FC<{ onReset?: () => void }> = ({ onReset }) => (
  <div className="flex flex-col items-center justify-center text-center py-20">
    <span className="w-12 h-12 rounded-2xl bg-white border border-[#E5E5E7] flex items-center justify-center text-[#AEAEB2]">
      <ScanSearch className="w-5 h-5" />
    </span>
    <div className="mt-3 text-[13.5px] font-semibold text-[#1C1C1E]">没有符合条件的 Agent 员工</div>
    <div className="mt-1 text-[12px] text-[#8E8E93]">试试调整搜索关键词、状态筛选或组织范围</div>
    {onReset && (
      <button
        onClick={onReset}
        className="mt-3 px-3 h-7 rounded-md bg-white border border-[#DCDCE0] hover:bg-[#F2F2F5] text-[12px] text-[#1C1C1E] cursor-pointer"
      >
        清除筛选
      </button>
    )}
  </div>
);
