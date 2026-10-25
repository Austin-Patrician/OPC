import React, { useState } from 'react';
import {
  ArrowRightLeft,
  Building2,
  ChevronRight,
  Cpu,
  FileCode2,
  MessageSquare,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { AgentEmployee, Department } from '../../types/im';
import { AvatarIcon } from '../AvatarIcon';
import {
  AgentAvatar,
  LeadMark,
  LevelTag,
  OrgSelection,
  StatusPill,
  formatCost,
  getDeptLead,
  parseCost,
  sortMembers,
  sumCost,
  sumTasks,
} from './orgShared';

interface OrgDetailPanelProps {
  selection: OrgSelection;
  departments: Department[];
  agents: AgentEmployee[];
  canDismiss: boolean;
  onClose: () => void;
  onSelect: (selection: OrgSelection) => void;
  onStartDm: (agentId: string) => void;
  onOpenDeptGroup: (deptId: string) => void;
  onHireIntoDept: (deptId: string) => void;
  onTransfer: (agentId: string, deptId: string) => void;
  onDismiss: (agentId: string) => void;
}

const Section: React.FC<{ title: string; icon?: React.ReactNode; children: React.ReactNode }> = ({
  title,
  icon,
  children,
}) => (
  <section className="px-5 py-4 border-t border-[#F0F0F2]">
    <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[#8E8E93] mb-2.5">
      {icon}
      {title}
    </div>
    {children}
  </section>
);

const StatTile: React.FC<{ label: string; value: React.ReactNode; accent?: string }> = ({
  label,
  value,
  accent = '#1C1C1E',
}) => (
  <div className="rounded-lg bg-[#F6F6F8] px-2.5 py-2 min-w-0">
    <div className="text-[10.5px] text-[#8E8E93]">{label}</div>
    <div className="mt-0.5 text-[13.5px] font-semibold font-mono truncate" style={{ color: accent }}>
      {value}
    </div>
  </div>
);

const primaryBtn =
  'h-8 rounded-lg bg-[#0099FF] hover:bg-[#0086E0] text-white text-[12px] font-medium flex items-center justify-center gap-1.5 transition-colors cursor-pointer';
const secondaryBtn =
  'h-8 rounded-lg bg-[#F2F2F5] hover:bg-[#E8E8EC] text-[#1C1C1E] text-[12px] font-medium flex items-center justify-center gap-1.5 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default';

const MemberRow: React.FC<{ agent: AgentEmployee; isLead: boolean; onClick: () => void }> = ({
  agent,
  isLead,
  onClick,
}) => (
  <button
    onClick={onClick}
    className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-[#F6F6F8] text-left cursor-pointer"
  >
    <AgentAvatar agent={agent} size="xs" />
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-1 min-w-0">
        <span className="text-[12.5px] font-medium text-[#1C1C1E] truncate">{agent.name}</span>
        <LevelTag level={agent.level} />
        {isLead && <LeadMark />}
      </div>
      <div className="text-[11px] text-[#8E8E93] truncate">{agent.role}</div>
    </div>
    <ChevronRight className="w-3.5 h-3.5 text-[#C7C7CC] shrink-0" />
  </button>
);

const AgentProfile: React.FC<
  Omit<OrgDetailPanelProps, 'selection' | 'onClose' | 'onHireIntoDept'> & { agent: AgentEmployee }
> = ({
  agent,
  departments,
  agents,
  canDismiss,
  onSelect,
  onStartDm,
  onOpenDeptGroup,
  onTransfer,
  onDismiss,
}) => {
  const [confirming, setConfirming] = useState(false);
  const dept = departments.find((d) => d.id === agent.departmentId);
  const lead = dept ? getDeptLead(dept, agents) : undefined;
  const isLead = lead?.id === agent.id;
  const color = dept?.color ?? '#0099FF';

  const chain: {
    key: string;
    avatar: React.ReactNode;
    name: string;
    role: string;
    onClick?: () => void;
    current?: boolean;
  }[] = [
    {
      key: 'ceo',
      avatar: <AvatarIcon type="founder-girl" size="xs" />,
      name: '丶殇泪',
      role: 'CEO · 一人公司创始人',
    },
    ...(lead && !isLead
      ? [
          {
            key: lead.id,
            avatar: <AgentAvatar agent={lead} size="xs" />,
            name: lead.name,
            role: `${dept?.name ?? ''} · 负责人`,
            onClick: () => onSelect({ kind: 'agent', id: lead.id }),
          },
        ]
      : []),
    {
      key: agent.id,
      avatar: <AgentAvatar agent={agent} size="xs" />,
      name: agent.name,
      role: isLead ? `${dept?.name ?? ''} · 负责人` : agent.role,
      current: true,
    },
  ];

  return (
    <>
      <div
        className="h-[72px]"
        style={{ background: `linear-gradient(135deg, ${color}33 0%, ${color}0A 100%)` }}
      />
      <div className="px-5 -mt-9 pb-4">
        <span className="inline-flex rounded-full ring-4 ring-white bg-white">
          <AvatarIcon type={agent.avatarType} avatarUrl={agent.avatarUrl} name={agent.name} size="xl" />
        </span>
        <div className="mt-2.5 flex items-center gap-1.5 min-w-0">
          <h3 className="text-[16px] font-bold text-[#1C1C1E] truncate">{agent.name}</h3>
          <LevelTag level={agent.level} />
          {isLead && <LeadMark />}
        </div>
        <p className="mt-0.5 text-[12px] text-[#6E6E73] leading-relaxed">{agent.role}</p>
        <div className="mt-2.5 flex items-center gap-1.5 flex-wrap">
          <StatusPill status={agent.status} />
          {dept && (
            <button
              onClick={() => onSelect({ kind: 'dept', id: dept.id })}
              className="inline-flex items-center h-5 px-2 rounded-full text-[11px] font-medium hover:opacity-80 cursor-pointer"
              style={{ background: `${color}1A`, color }}
            >
              {dept.name}
            </button>
          )}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button onClick={() => onStartDm(agent.id)} className={primaryBtn}>
            <MessageSquare className="w-3.5 h-3.5" />
            发起对话
          </button>
          <button
            onClick={() => dept && onOpenDeptGroup(dept.id)}
            disabled={!dept}
            className={secondaryBtn}
          >
            <Users className="w-3.5 h-3.5" />
            部门群
          </button>
        </div>
      </div>

      <Section title="汇报关系">
        <ol>
          {chain.map((node, i) => (
            <li key={node.key} className="relative flex items-center gap-2.5 pb-3 last:pb-0">
              {i < chain.length - 1 && (
                <span className="absolute left-[11.5px] top-6 bottom-0 w-px bg-[#DADBE0]" />
              )}
              {node.avatar}
              <div className="min-w-0 flex-1">
                {node.onClick ? (
                  <button
                    onClick={node.onClick}
                    className="block max-w-full text-[12.5px] font-medium text-[#1C1C1E] hover:text-[#0077CC] truncate cursor-pointer"
                  >
                    {node.name}
                  </button>
                ) : (
                  <div className="text-[12.5px] font-medium text-[#1C1C1E] truncate">
                    {node.name}
                  </div>
                )}
                <div className="text-[11px] text-[#8E8E93] truncate">{node.role}</div>
              </div>
              {node.current && (
                <span className="text-[10px] px-1.5 leading-4 rounded bg-[#F2F2F5] text-[#6E6E73] shrink-0">
                  当前
                </span>
              )}
            </li>
          ))}
        </ol>
      </Section>

      <Section title="履职数据">
        {/* Wider last column keeps a full YYYY-MM-DD hire date untruncated */}
        <div className="grid grid-cols-[1fr_1fr_1.25fr] gap-2">
          <StatTile label="累计交付" value={`${agent.completedTasks} 单`} />
          <StatTile
            label="算力日薪"
            value={formatCost(parseCost(agent.tokenCostPerDay))}
            accent="#10B981"
          />
          <StatTile label="入职" value={agent.hiredAt} />
        </div>
      </Section>

      <Section title="底层模型与工具链">
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#F6F6F8] text-[12px] text-[#1C1C1E]">
          <Cpu className="w-3.5 h-3.5 text-[#0099FF] shrink-0" />
          <span className="truncate">{agent.model}</span>
        </div>
      </Section>

      <Section title={`技能栈 · ${agent.skills.length}`}>
        <div className="flex flex-wrap gap-1.5">
          {agent.skills.map((skill) => (
            <span
              key={skill}
              className="text-[11px] px-2 py-0.5 rounded-md bg-[#F2F2F5] text-[#3A3A3C]"
            >
              {skill}
            </span>
          ))}
        </div>
      </Section>

      <Section title="brief.md 记忆规范" icon={<FileCode2 className="w-3 h-3 text-[#0099FF]" />}>
        <pre className="text-[11px] font-mono leading-relaxed text-[#4A4A4E] whitespace-pre-wrap bg-[#F8F8FA] border border-[#EFEFF2] rounded-lg p-3 max-h-48 overflow-y-auto select-text">
          {agent.briefMd}
        </pre>
      </Section>

      <Section title="人事操作">
        <label className="flex items-center gap-3 text-[12px]">
          <span className="text-[#6E6E73] shrink-0 flex items-center gap-1">
            <ArrowRightLeft className="w-3.5 h-3.5" />
            调岗至
          </span>
          <select
            value={agent.departmentId}
            onChange={(e) => onTransfer(agent.id, e.target.value)}
            className="flex-1 min-w-0 h-8 px-2 rounded-lg bg-[#F2F2F5] text-[12px] text-[#1C1C1E] outline-none cursor-pointer focus:ring-1 focus:ring-[#0099FF]"
          >
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>

        {canDismiss &&
          (confirming ? (
            <div className="mt-3 rounded-lg border border-[#FFD6D6] bg-[#FFF5F5] p-3">
              <div className="text-[12px] text-[#C62828] leading-relaxed">
                确认解雇「{agent.name}」？该员工将从组织架构中移除。
              </div>
              <div className="mt-2.5 flex justify-end gap-2">
                <button
                  onClick={() => setConfirming(false)}
                  className="h-7 px-3 rounded-md text-[12px] text-[#6E6E73] hover:bg-black/5 cursor-pointer"
                >
                  取消
                </button>
                <button
                  onClick={() => onDismiss(agent.id)}
                  className="h-7 px-3 rounded-md bg-[#E5484D] hover:bg-[#D93D42] text-white text-[12px] font-medium cursor-pointer"
                >
                  确认解雇
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setConfirming(true)}
              className="mt-3 w-full h-8 rounded-lg border border-[#F2D4D4] text-[12px] text-[#E5484D] hover:bg-[#FFF5F5] flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              解雇该 Agent 员工
            </button>
          ))}
      </Section>
    </>
  );
};

const DeptProfile: React.FC<{
  dept: Department;
  agents: AgentEmployee[];
  onSelect: (selection: OrgSelection) => void;
  onOpenDeptGroup: (deptId: string) => void;
  onHireIntoDept: (deptId: string) => void;
}> = ({ dept, agents, onSelect, onOpenDeptGroup, onHireIntoDept }) => {
  const lead = getDeptLead(dept, agents);
  const members = sortMembers(
    agents.filter((a) => a.departmentId === dept.id),
    lead?.id
  );

  return (
    <>
      <div className="px-5 pt-5 pb-4">
        <div className="flex items-start gap-3">
          <span
            className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: `${dept.color}1A`, color: dept.color }}
          >
            <Building2 className="w-5 h-5" />
          </span>
          <div className="min-w-0">
            <h3 className="text-[15.5px] font-bold text-[#1C1C1E] leading-snug">{dept.name}</h3>
            <div className="mt-0.5 text-[11px] font-mono text-[#8E8E93]">{dept.code}</div>
          </div>
        </div>
        <p className="mt-3 text-[12px] leading-relaxed text-[#555558]">{dept.description}</p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button onClick={() => onOpenDeptGroup(dept.id)} className={primaryBtn}>
            <Users className="w-3.5 h-3.5" />
            进入部门群
          </button>
          <button onClick={() => onHireIntoDept(dept.id)} className={secondaryBtn}>
            <UserPlus className="w-3.5 h-3.5" />
            增聘员工
          </button>
        </div>
      </div>

      <Section title="部门指标">
        <div className="grid grid-cols-2 gap-2">
          <StatTile label="在岗成员" value={`${members.length} 名`} />
          <StatTile
            label="执行中"
            value={members.filter((a) => a.status === 'working').length}
            accent="#0099FF"
          />
          <StatTile label="算力日薪" value={formatCost(sumCost(members))} accent="#10B981" />
          <StatTile label="累计交付" value={`${sumTasks(members)} 单`} />
        </div>
      </Section>

      <Section title="负责人">
        {lead ? (
          <div className="-mx-2">
            <MemberRow
              agent={lead}
              isLead
              onClick={() => onSelect({ kind: 'agent', id: lead.id })}
            />
          </div>
        ) : (
          <div className="text-[12px] text-[#AEAEB2]">暂未任命负责人</div>
        )}
      </Section>

      <Section title={`部门成员 · ${members.length}`}>
        {members.length ? (
          <div className="-mx-2 space-y-px">
            {members.map((m) => (
              <MemberRow
                key={m.id}
                agent={m}
                isLead={m.id === lead?.id}
                onClick={() => onSelect({ kind: 'agent', id: m.id })}
              />
            ))}
          </div>
        ) : (
          <div className="text-[12px] text-[#AEAEB2]">暂无成员</div>
        )}
      </Section>
    </>
  );
};

export const OrgDetailPanel: React.FC<OrgDetailPanelProps> = (props) => {
  const { selection, departments, agents, onClose } = props;
  const agent =
    selection.kind === 'agent' ? agents.find((a) => a.id === selection.id) : undefined;
  const dept =
    selection.kind === 'dept' ? departments.find((d) => d.id === selection.id) : undefined;
  if (!agent && !dept) return null;

  return (
    <aside className="absolute inset-y-0 right-0 z-20 w-[336px] shadow-[-16px_0_36px_-20px_rgba(0,0,0,0.35)] xl:static xl:shadow-none shrink-0 bg-white border-l border-[#E5E5E7] flex flex-col min-h-0">
      <header className="h-11 px-4 flex items-center justify-between border-b border-[#EFEFF1] shrink-0">
        <span className="text-[12.5px] font-semibold text-[#1C1C1E]">
          {agent ? '员工档案' : '部门档案'}
        </span>
        <button
          onClick={onClose}
          title="关闭 (Esc)"
          className="w-7 h-7 rounded-md flex items-center justify-center text-[#8E8E93] hover:bg-[#F2F2F5] hover:text-[#1C1C1E] cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {agent ? (
          <AgentProfile key={agent.id} {...props} agent={agent} />
        ) : (
          dept && (
            <DeptProfile
              dept={dept}
              agents={agents}
              onSelect={props.onSelect}
              onOpenDeptGroup={props.onOpenDeptGroup}
              onHireIntoDept={props.onHireIntoDept}
            />
          )
        )}
      </div>
    </aside>
  );
};
