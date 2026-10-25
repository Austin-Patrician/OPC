import React, { useEffect, useState } from 'react';
import {
  Award,
  Building2,
  Check,
  ChevronRight,
  FileCode2,
  IdCard,
  List,
  LucideIcon,
  Network,
  Plus,
  Search,
  Sparkles,
  SquareKanban,
  UserPlus,
  X,
  Zap,
} from 'lucide-react';
import { AgentEmployee, CandidateAgent, Department } from '../types/im';
import { AvatarIcon } from './AvatarIcon';
import {
  OrgSelection,
  OrgViewMode,
  STATUS_META,
  STATUS_ORDER,
  StatusFilter,
  sumCost,
} from './org/orgShared';
import { OrgDirectory } from './org/OrgDirectory';
import { OrgTreeView } from './org/OrgTreeView';
import { OrgBoardView } from './org/OrgBoardView';
import { OrgBadgeView } from './org/OrgBadgeView';
import { OrgRosterView } from './org/OrgRosterView';
import { OrgDetailPanel } from './org/OrgDetailPanel';

const VIEW_OPTIONS: { id: OrgViewMode; label: string; hint: string; icon: LucideIcon }[] = [
  { id: 'tree', label: '架构图', hint: '树状汇报线 · 支持缩放、平移与折叠', icon: Network },
  { id: 'board', label: '部门看板', hint: '按部门分列 · 拖拽卡片即可调岗', icon: SquareKanban },
  { id: 'badge', label: '员工工牌', hint: '数字员工工牌墙 · 按部门分组', icon: IdCard },
  { id: 'roster', label: '花名册', hint: '可排序的人员明细表', icon: List },
];

const VIEW_STORAGE_KEY = 'opc-hr-org-view';

const readStoredView = (): OrgViewMode => {
  try {
    const stored = localStorage.getItem(VIEW_STORAGE_KEY);
    return VIEW_OPTIONS.find((o) => o.id === stored)?.id ?? 'tree';
  } catch {
    return 'tree';
  }
};

interface HrOrgViewProps {
  mode: 'org' | 'market';
  onChangeMode: (mode: 'org' | 'market') => void;
  departments: Department[];
  agents: AgentEmployee[];
  candidates: CandidateAgent[];
  onStartDmWithAgent: (agentId: string) => void;
  onOpenDeptGroup: (deptId: string) => void;
  onTransferAgentDept: (agentId: string, newDeptId: string) => void;
  onDismissAgent: (agentId: string) => void;
  onHireCandidate: (candidate: CandidateAgent, targetDeptId: string) => void;
  onCreateCustomAgent: (
    name: string,
    role: string,
    level: string,
    deptId: string,
    model: string,
    skills: string[],
    briefMd: string
  ) => void;
  onCreateDepartment: (name: string, code: string, description: string) => void;
}

export const HrOrgView: React.FC<HrOrgViewProps> = ({
  mode,
  onChangeMode,
  departments,
  agents,
  candidates,
  onStartDmWithAgent,
  onOpenDeptGroup,
  onTransferAgentDept,
  onDismissAgent,
  onHireCandidate,
  onCreateCustomAgent,
  onCreateDepartment,
}) => {
  const [selectedDeptByCand, setSelectedDeptByCand] = useState<Record<string, string>>({});
  const [showCustomAgentModal, setShowCustomAgentModal] = useState(false);
  const [showNewDeptModal, setShowNewDeptModal] = useState(false);

  // Org workspace state
  const [viewMode, setViewMode] = useState<OrgViewMode>(readStoredView);
  const [scopeDeptId, setScopeDeptId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState<OrgSelection | null>(null);
  const [hireTargetDeptId, setHireTargetDeptId] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, viewMode);
    } catch {
      // Persisting the preferred view is optional.
    }
  }, [viewMode]);

  useEffect(() => {
    if (!selection) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelection(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selection]);

  // Custom Agent form state
  const [cName, setCName] = useState('');
  const [cRole, setCRole] = useState('');
  const [cLevel, setCLevel] = useState('P7');
  const [cDeptId, setCDeptId] = useState(departments[0]?.id || 'dept-content');
  const [cModel, setCModel] = useState('Claude 3.7 Sonnet + MCP');
  const [cSkills, setCSkills] = useState('爆款拆解, 口播稿生成, 自动发布');
  const [cBrief, setCBrief] = useState(
    '# brief.md - 岗位执行规范\n1. 严格遵循 1080×1920 纯影像交付标准\n2. 发现3倍均值异常爆款第一时间同步群组'
  );

  // New Department form state
  const [dName, setDName] = useState('');
  const [dCode, setDCode] = useState('NEW-06');
  const [dDesc, setDDesc] = useState('');

  const totalDailyCost = sumCost(agents).toFixed(1);

  // Scope (directory) + search narrow the population; status filter applies on top.
  const scopeDept = departments.find((d) => d.id === scopeDeptId);
  const scopedDepts = scopeDept ? [scopeDept] : departments;
  const normalizedQuery = query.trim().toLowerCase();
  const searchScopedAgents = agents.filter(
    (a) =>
      (!scopeDept || a.departmentId === scopeDept.id) &&
      (!normalizedQuery ||
        [a.name, a.role, a.level, a.model, ...a.skills].some((field) =>
          field.toLowerCase().includes(normalizedQuery)
        ))
  );
  const visibleAgents =
    statusFilter === 'all'
      ? searchScopedAgents
      : searchScopedAgents.filter((a) => a.status === statusFilter);

  const resetFilters = () => {
    setQuery('');
    setStatusFilter('all');
    setScopeDeptId(null);
  };

  const handleHireIntoDept = (deptId: string) => {
    setHireTargetDeptId(deptId);
    setSelectedDeptByCand({});
    onChangeMode('market');
  };

  const hireTargetDept = departments.find((d) => d.id === hireTargetDeptId);
  const viewProps = {
    departments: scopedDepts,
    agents: visibleAgents,
    allAgents: agents,
    selection,
    onSelect: setSelection,
    onStartDm: onStartDmWithAgent,
  };

  return (
    <div className="flex-1 bg-[#F2F2F3] flex flex-col min-w-0 overflow-hidden select-none">
      {/* Top Header */}
      <div className="h-[54px] px-6 border-b border-[#E5E5E7] bg-[#F8F8FA] flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex items-center bg-[#EAEAEF] p-0.5 rounded-lg">
            <button
              onClick={() => onChangeMode('org')}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-[13px] font-medium transition-colors cursor-pointer ${
                mode === 'org'
                  ? 'bg-white text-[#1C1C1E] shadow-2xs'
                  : 'text-[#6E6E73] hover:text-[#1C1C1E]'
              }`}
            >
              <Network className="w-3.5 h-3.5 text-[#0099FF]" />
              <span>OPC 公司 HR 组织架构图 ({agents.length}人)</span>
            </button>
            <button
              onClick={() => {
                setHireTargetDeptId(null);
                onChangeMode('market');
              }}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-[13px] font-medium transition-colors cursor-pointer ${
                mode === 'market'
                  ? 'bg-white text-[#1C1C1E] shadow-2xs'
                  : 'text-[#6E6E73] hover:text-[#1C1C1E]'
              }`}
            >
              <UserPlus className="w-3.5 h-3.5 text-[#FF4D4F]" />
              <span>Agent 人才聘用市场 ({candidates.length}名待聘)</span>
            </button>
          </div>

          {/* Org mode shows these figures in the directory panel instead */}
          {mode === 'market' && (
            <div className="hidden lg:flex items-center gap-4 text-[12px] text-[#6E6E73] ml-2">
              <span>
                部门编制: <strong className="text-[#1C1C1E]">{departments.length} 个一级部门</strong>
              </span>
              <span>
                在岗 Agent: <strong className="text-[#1C1C1E]">{agents.length} 名数字员工</strong>
              </span>
              <span>
                全公司算力日薪总计:{' '}
                <strong className="text-[#10B981]">¥{totalDailyCost} / 天</strong>
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowNewDeptModal(true)}
            className="px-3 py-1.5 rounded-lg bg-white border border-[#DCDCE0] hover:bg-[#F2F2F5] text-[12.5px] font-medium text-[#1C1C1E] flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <Building2 className="w-3.5 h-3.5 text-[#512BD4]" />
            <span>+ 新增部门</span>
          </button>
          <button
            onClick={() => setShowCustomAgentModal(true)}
            className="px-3 py-1.5 rounded-lg bg-[#0099FF] hover:bg-[#0086E0] text-white text-[12.5px] font-medium flex items-center gap-1.5 transition-colors cursor-pointer shadow-xs"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>自定义招募 Agent 员工</span>
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      {mode === 'org' ? (
        <div className="relative flex-1 flex min-h-0">
          <OrgDirectory
            departments={departments}
            agents={agents}
            scopeDeptId={scopeDept?.id ?? null}
            onScope={setScopeDeptId}
            onCreateDept={() => setShowNewDeptModal(true)}
          />

          <div className="flex-1 min-w-0 flex flex-col">
            {/* Org toolbar: view switcher, scope, status filter, search */}
            <div className="h-12 px-4 flex items-center gap-3 bg-white border-b border-[#E5E5E7] shrink-0">
              <div
                role="tablist"
                aria-label="组织架构视图"
                className="flex items-center bg-[#EFEFF2] p-0.5 rounded-lg shrink-0"
              >
                {VIEW_OPTIONS.map(({ id, label, hint, icon: Icon }) => {
                  const active = viewMode === id;
                  return (
                    <button
                      key={id}
                      role="tab"
                      aria-selected={active}
                      title={hint}
                      onClick={() => setViewMode(id)}
                      className={`h-7 px-2.5 rounded-md flex items-center gap-1.5 text-[12.5px] font-medium transition-colors cursor-pointer ${
                        active
                          ? 'bg-white text-[#1C1C1E] shadow-[0_1px_2px_rgba(0,0,0,0.08)]'
                          : 'text-[#6E6E73] hover:text-[#1C1C1E]'
                      }`}
                    >
                      <Icon className={`w-3.5 h-3.5 ${active ? 'text-[#0099FF]' : ''}`} />
                      <span className="hidden md:inline">{label}</span>
                    </button>
                  );
                })}
              </div>

              <span className="h-5 w-px bg-[#E5E5E7] shrink-0" />

              {/* Scope: breadcrumb next to the directory, select when the directory is hidden */}
              <div className="hidden xl:flex items-center gap-1 text-[12px] min-w-0">
                <button
                  onClick={() => setScopeDeptId(null)}
                  className={`shrink-0 cursor-pointer ${
                    scopeDept ? 'text-[#8E8E93] hover:text-[#1C1C1E]' : 'text-[#1C1C1E] font-medium'
                  }`}
                >
                  OPC 一人公司
                </button>
                {scopeDept && (
                  <>
                    <ChevronRight className="w-3 h-3 text-[#C7C7CC] shrink-0" />
                    <span className="flex items-center gap-1.5 text-[#1C1C1E] font-medium min-w-0">
                      <span
                        className="w-2 h-2 rounded-[3px] shrink-0"
                        style={{ background: scopeDept.color }}
                      />
                      <span className="truncate">{scopeDept.name}</span>
                    </span>
                    <button
                      onClick={() => setScopeDeptId(null)}
                      title="查看全公司"
                      className="w-5 h-5 rounded flex items-center justify-center text-[#8E8E93] hover:bg-[#F2F2F5] hover:text-[#1C1C1E] shrink-0 cursor-pointer"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </>
                )}
              </div>
              <select
                value={scopeDept?.id ?? ''}
                onChange={(e) => setScopeDeptId(e.target.value || null)}
                aria-label="组织范围"
                className="xl:hidden h-7 max-w-[180px] px-2 rounded-md bg-[#EFEFF2] text-[12px] text-[#1C1C1E] outline-none cursor-pointer"
              >
                <option value="">OPC 一人公司（全部）</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>

              <div className="flex-1" />

              <div className="hidden lg:flex items-center gap-0.5 bg-[#EFEFF2] p-0.5 rounded-lg shrink-0">
                {(['all', ...STATUS_ORDER] as StatusFilter[]).map((status) => {
                  const active = statusFilter === status;
                  const count =
                    status === 'all'
                      ? searchScopedAgents.length
                      : searchScopedAgents.filter((a) => a.status === status).length;
                  return (
                    <button
                      key={status}
                      onClick={() => setStatusFilter(status)}
                      className={`h-7 px-2 rounded-md flex items-center gap-1.5 text-[12px] transition-colors cursor-pointer ${
                        active
                          ? 'bg-white text-[#1C1C1E] font-medium shadow-[0_1px_2px_rgba(0,0,0,0.08)]'
                          : 'text-[#6E6E73] hover:text-[#1C1C1E]'
                      }`}
                    >
                      {status !== 'all' && (
                        <span
                          className="w-1.5 h-1.5 rounded-full"
                          style={{ background: STATUS_META[status].color }}
                        />
                      )}
                      {status === 'all' ? '全部' : STATUS_META[status].label}
                      <span className="font-mono text-[10.5px] text-[#8E8E93]">{count}</span>
                    </button>
                  );
                })}
              </div>

              <div className="w-[200px] h-[30px] bg-[#EFEFF1] rounded-[6px] px-2.5 flex items-center gap-1.5 shrink-0 focus-within:bg-white focus-within:ring-1 focus-within:ring-[#0099FF]">
                <Search className="w-3.5 h-3.5 text-[#9E9EA3] shrink-0" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索员工 / 岗位 / 技能"
                  className="w-full min-w-0 bg-transparent text-[12.5px] text-[#1C1C1E] placeholder-[#9E9EA3] outline-none"
                />
                {query && (
                  <button
                    onClick={() => setQuery('')}
                    title="清除搜索"
                    className="text-[#9E9EA3] hover:text-[#1C1C1E] shrink-0 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>

            {viewMode === 'tree' && (
              <OrgTreeView {...viewProps} onHireIntoDept={handleHireIntoDept} />
            )}
            {viewMode === 'board' && (
              <OrgBoardView
                {...viewProps}
                departments={departments}
                scopeDeptId={scopeDept?.id ?? null}
                onOpenDeptGroup={onOpenDeptGroup}
                onHireIntoDept={handleHireIntoDept}
                onTransfer={onTransferAgentDept}
              />
            )}
            {viewMode === 'badge' && (
              <OrgBadgeView
                {...viewProps}
                onOpenDeptGroup={onOpenDeptGroup}
                onHireIntoDept={handleHireIntoDept}
                onResetFilters={resetFilters}
              />
            )}
            {viewMode === 'roster' && (
              <OrgRosterView {...viewProps} onResetFilters={resetFilters} />
            )}
          </div>

          {selection && (
            <OrgDetailPanel
              selection={selection}
              departments={departments}
              agents={agents}
              canDismiss={agents.length > 3}
              onClose={() => setSelection(null)}
              onSelect={setSelection}
              onStartDm={onStartDmWithAgent}
              onOpenDeptGroup={onOpenDeptGroup}
              onHireIntoDept={handleHireIntoDept}
              onTransfer={onTransferAgentDept}
              onDismiss={(agentId) => {
                onDismissAgent(agentId);
                setSelection(null);
              }}
            />
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-6">
          {/* Mode 2: Agent Talent Marketplace (聘用新 Agent 员工) */}
          <div className="max-w-[1180px] mx-auto space-y-5">
            {hireTargetDept && (
              <div className="h-10 px-4 flex items-center gap-2.5 rounded-xl bg-white border border-[#E5E5E7] text-[12.5px]">
                <span
                  className="w-2 h-2 rounded-[3px] shrink-0"
                  style={{ background: hireTargetDept.color }}
                />
                <span className="text-[#555558] truncate">
                  正在为「<strong className="text-[#1C1C1E]">{hireTargetDept.name}</strong>
                  」增聘，下方候选人的入职部门已默认设为该部门
                </span>
                <span className="flex-1" />
                <button
                  onClick={() => setHireTargetDeptId(null)}
                  className="shrink-0 text-[12px] text-[#0077CC] hover:underline cursor-pointer"
                >
                  恢复推荐部门
                </button>
                <button
                  onClick={() => onChangeMode('org')}
                  className="shrink-0 text-[12px] text-[#6E6E73] hover:text-[#1C1C1E] cursor-pointer"
                >
                  返回架构
                </button>
              </div>
            )}
            <div className="bg-gradient-to-r from-[#0099FF]/10 via-[#512BD4]/5 to-transparent rounded-2xl p-5 border border-[#0099FF]/20 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-[#0099FF]" />
                  <h2 className="text-[15.5px] font-bold text-[#1C1C1E]">
                    OPC 精英 Agent 人才聘用市场
                  </h2>
                </div>
                <p className="text-[12.5px] text-[#555558] mt-1">
                  点击「聘用入职」后，该 Agent 员工将自动编入对应 HR 部门、自动挂载部门 brief.md 记忆规范，并在 IM 列表向您发送入职报到私信及加入部门群聊。
                </p>
              </div>
              <button
                onClick={() => setShowCustomAgentModal(true)}
                className="shrink-0 px-4 py-2 rounded-xl bg-[#1C1C1E] hover:bg-[#333336] text-white text-[12.5px] font-medium flex items-center gap-1.5 cursor-pointer"
              >
                <Zap className="w-3.5 h-3.5 text-[#FFBD2E]" />
                <span>自定义创建专属 Agent</span>
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {candidates.map((cand) => {
                const alreadyHired = agents.some((a) => a.name === cand.name);
                const targetDeptId =
                  selectedDeptByCand[cand.id] ||
                  hireTargetDept?.id ||
                  cand.recommendedDeptId ||
                  departments[0]?.id;

                return (
                  <div
                    key={cand.id}
                    className="bg-white rounded-2xl p-4 border border-[#E5E5E7] shadow-2xs flex flex-col justify-between space-y-3.5"
                  >
                    <div className="space-y-3">
                      <div className="flex items-start justify-between gap-2.5">
                        <div className="flex items-center gap-3">
                          <AvatarIcon
                            type="custom"
                            avatarUrl={cand.avatarUrl}
                            name={cand.name}
                            size="lg"
                          />
                          <div>
                            <div className="flex items-center gap-1.5">
                              <h3 className="text-[14.5px] font-bold text-[#1C1C1E]">
                                {cand.name}
                              </h3>
                              <span className="text-[10.5px] font-mono px-1.5 py-0.5 rounded bg-[#E8F3FF] text-[#0066CC] font-semibold">
                                {cand.level}
                              </span>
                            </div>
                            <div className="text-[12px] text-[#6E6E73] mt-0.5">{cand.role}</div>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center justify-between text-[11.5px] bg-[#F5F7FA] px-3 py-1.5 rounded-lg">
                        <span className="text-[#0066CC] font-medium flex items-center gap-1">
                          <Award className="w-3.5 h-3.5" />
                          {cand.highlightMetric}
                        </span>
                        <span className="font-mono text-[#10B981] font-semibold">
                          {cand.tokenCostPerDay}
                        </span>
                      </div>

                      <p className="text-[12px] text-[#4A4A4E] leading-relaxed">{cand.bio}</p>

                      <div className="flex flex-wrap gap-1">
                        {cand.skills.map((sk) => (
                          <span
                            key={sk}
                            className="text-[10.5px] px-2 py-0.5 rounded-md bg-[#F2F2F5] text-[#555558]"
                          >
                            {sk}
                          </span>
                        ))}
                      </div>

                      <div className="bg-[#F8F8FA] p-2.5 rounded-lg border border-[#EFEFF2]">
                        <div className="text-[10.5px] font-mono text-[#8E8E93] mb-1 flex items-center gap-1">
                          <FileCode2 className="w-3 h-3 text-[#0099FF]" />
                          自带 brief.md 生产经验
                        </div>
                        <pre className="text-[10.5px] font-mono text-[#4A4A4E] whitespace-pre-wrap line-clamp-3">
                          {cand.briefMd}
                        </pre>
                      </div>
                    </div>

                    <div className="pt-3 border-t border-[#EFEFF1] space-y-2">
                      <div className="flex items-center justify-between text-[11.5px]">
                        <span className="text-[#6E6E73]">入职部门:</span>
                        <select
                          value={targetDeptId}
                          onChange={(e) =>
                            setSelectedDeptByCand((prev) => ({
                              ...prev,
                              [cand.id]: e.target.value,
                            }))
                          }
                          className="bg-[#F2F2F5] text-[#1C1C1E] rounded-md px-2 py-1 text-[11.5px] font-medium outline-none cursor-pointer"
                        >
                          {departments.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name}
                            </option>
                          ))}
                        </select>
                      </div>

                      {alreadyHired ? (
                        <button
                          disabled
                          className="w-full py-2 rounded-xl bg-[#E5E5E7] text-[#8E8E93] text-[12.5px] font-medium flex items-center justify-center gap-1.5"
                        >
                          <Check className="w-4 h-4" />
                          <span>已聘用在岗</span>
                        </button>
                      ) : (
                        <button
                          onClick={() => onHireCandidate(cand, targetDeptId)}
                          className="w-full py-2 rounded-xl bg-[#0099FF] hover:bg-[#0082D9] text-white text-[12.5px] font-medium flex items-center justify-center gap-1.5 transition-colors cursor-pointer shadow-xs"
                        >
                          <UserPlus className="w-4 h-4" />
                          <span>一键聘用入职并开启 IM 对话</span>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Modal: Custom Recruit Agent Employee */}
      {showCustomAgentModal && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-lg shadow-2xl border border-[#E5E5E7] overflow-hidden">
            <div className="px-5 py-4 border-b border-[#EFEFF1] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <UserPlus className="w-4 h-4 text-[#0099FF]" />
                <h3 className="text-[15px] font-bold text-[#1C1C1E]">
                  自定义聘用新 Agent 员工 (编入 HR 架构)
                </h3>
              </div>
              <button
                onClick={() => setShowCustomAgentModal(false)}
                className="text-[12.5px] text-[#8E8E93] hover:text-[#1C1C1E] cursor-pointer"
              >
                关闭
              </button>
            </div>

            <div className="p-5 space-y-3.5 text-[13px]">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11.5px] font-medium text-[#555558] mb-1">
                    Agent 姓名 / 花名
                  </label>
                  <input
                    type="text"
                    value={cName}
                    onChange={(e) => setCName(e.target.value)}
                    placeholder="如：周小满·抖音选题官"
                    className="w-full px-3 py-1.5 rounded-lg border border-[#DCDCE0] focus:border-[#0099FF] outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[11.5px] font-medium text-[#555558] mb-1">
                    职级与岗位头衔
                  </label>
                  <div className="flex gap-1.5">
                    <select
                      value={cLevel}
                      onChange={(e) => setCLevel(e.target.value)}
                      className="px-2 py-1.5 rounded-lg border border-[#DCDCE0] bg-[#F8F8FA]"
                    >
                      <option value="P6">P6</option>
                      <option value="P7">P7</option>
                      <option value="P8">P8</option>
                      <option value="M2">M2</option>
                    </select>
                    <input
                      type="text"
                      value={cRole}
                      onChange={(e) => setCRole(e.target.value)}
                      placeholder="如：爆款脚本拆解专家"
                      className="flex-1 px-3 py-1.5 rounded-lg border border-[#DCDCE0] focus:border-[#0099FF] outline-none"
                    />
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11.5px] font-medium text-[#555558] mb-1">
                    分配至 HR 部门
                  </label>
                  <select
                    value={cDeptId}
                    onChange={(e) => setCDeptId(e.target.value)}
                    className="w-full px-3 py-1.5 rounded-lg border border-[#DCDCE0] bg-white outline-none"
                  >
                    {departments.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[11.5px] font-medium text-[#555558] mb-1">
                    底层大模型与工具链
                  </label>
                  <input
                    type="text"
                    value={cModel}
                    onChange={(e) => setCModel(e.target.value)}
                    className="w-full px-3 py-1.5 rounded-lg border border-[#DCDCE0] focus:border-[#0099FF] outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11.5px] font-medium text-[#555558] mb-1">
                  技能标签 (逗号分隔)
                </label>
                <input
                  type="text"
                  value={cSkills}
                  onChange={(e) => setCSkills(e.target.value)}
                  className="w-full px-3 py-1.5 rounded-lg border border-[#DCDCE0] focus:border-[#0099FF] outline-none"
                />
              </div>

              <div>
                <label className="block text-[11.5px] font-medium text-[#555558] mb-1">
                  初始 brief.md 生产规范与人设记忆
                </label>
                <textarea
                  rows={4}
                  value={cBrief}
                  onChange={(e) => setCBrief(e.target.value)}
                  className="w-full px-3 py-1.5 rounded-lg border border-[#DCDCE0] font-mono text-[11.5px] focus:border-[#0099FF] outline-none"
                />
              </div>
            </div>

            <div className="px-5 py-3.5 bg-[#F8F8FA] border-t border-[#EFEFF1] flex justify-end gap-2">
              <button
                onClick={() => setShowCustomAgentModal(false)}
                className="px-4 py-1.5 rounded-lg text-[12.5px] text-[#6E6E73] hover:bg-black/5 cursor-pointer"
              >
                取消
              </button>
              <button
                onClick={() => {
                  if (!cName.trim()) return;
                  onCreateCustomAgent(
                    cName.trim(),
                    cRole.trim() || '专项业务执行Agent',
                    cLevel,
                    cDeptId,
                    cModel,
                    cSkills
                      .split(/[,，]/)
                      .map((s) => s.trim())
                      .filter(Boolean),
                    cBrief
                  );
                  setShowCustomAgentModal(false);
                  setCName('');
                  setCRole('');
                }}
                className="px-4 py-1.5 rounded-lg bg-[#0099FF] hover:bg-[#0082D9] text-white text-[12.5px] font-medium cursor-pointer"
              >
                办理入职并发起对话
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Create New Department */}
      {showNewDeptModal && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl border border-[#E5E5E7] overflow-hidden">
            <div className="px-5 py-4 border-b border-[#EFEFF1] flex items-center justify-between">
              <h3 className="text-[15px] font-bold text-[#1C1C1E]">
                新建 OPC 一级部门与部门群组
              </h3>
              <button
                onClick={() => setShowNewDeptModal(false)}
                className="text-[12.5px] text-[#8E8E93]"
              >
                关闭
              </button>
            </div>
            <div className="p-5 space-y-3 text-[13px]">
              <div>
                <label className="block text-[11.5px] font-medium text-[#555558] mb-1">
                  部门名称
                </label>
                <input
                  type="text"
                  value={dName}
                  onChange={(e) => setDName(e.target.value)}
                  placeholder="如：出海TikTok短剧本地化部"
                  className="w-full px-3 py-1.5 rounded-lg border border-[#DCDCE0] outline-none"
                />
              </div>
              <div>
                <label className="block text-[11.5px] font-medium text-[#555558] mb-1">
                  部门代号
                </label>
                <input
                  type="text"
                  value={dCode}
                  onChange={(e) => setDCode(e.target.value)}
                  className="w-full px-3 py-1.5 rounded-lg border border-[#DCDCE0] font-mono outline-none"
                />
              </div>
              <div>
                <label className="block text-[11.5px] font-medium text-[#555558] mb-1">
                  部门职能描述
                </label>
                <textarea
                  rows={3}
                  value={dDesc}
                  onChange={(e) => setDDesc(e.target.value)}
                  placeholder="负责多语种AI配音克隆、英文字幕切点对齐与TikTok矩阵发布"
                  className="w-full px-3 py-1.5 rounded-lg border border-[#DCDCE0] outline-none"
                />
              </div>
            </div>
            <div className="px-5 py-3.5 bg-[#F8F8FA] border-t border-[#EFEFF1] flex justify-end gap-2">
              <button
                onClick={() => setShowNewDeptModal(false)}
                className="px-4 py-1.5 rounded-lg text-[12.5px] text-[#6E6E73]"
              >
                取消
              </button>
              <button
                onClick={() => {
                  if (!dName.trim()) return;
                  onCreateDepartment(
                    dName.trim(),
                    dCode.trim() || 'DEPT-NEW',
                    dDesc.trim() || '专项AI自动化业务部门'
                  );
                  setShowNewDeptModal(false);
                  setDName('');
                  setDDesc('');
                }}
                className="px-4 py-1.5 rounded-lg bg-[#0099FF] text-white text-[12.5px] font-medium cursor-pointer"
              >
                创建部门并建群
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
