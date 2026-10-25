import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Building2,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Crown,
  Maximize2,
  MessageSquare,
  Plus,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { AgentEmployee, Department } from '../../types/im';
import { AvatarIcon } from '../AvatarIcon';
import {
  AgentAvatar,
  LeadMark,
  LevelTag,
  Metric,
  OrgSelection,
  STATUS_META,
  STATUS_ORDER,
  activateOnKey,
  formatCost,
  getDeptLead,
  sortMembers,
  sumCost,
} from './orgShared';

const LINE = '#C9CCD4';
const AGENT_NODE_H = 58;
const SMALL_NODE_H = 34;
const BRANCH_GAP = 10;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 1.6;
const CANVAS_PAD = 40;

const clampZoom = (z: number) =>
  Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));

interface OrgTreeViewProps {
  departments: Department[];
  agents: AgentEmployee[];
  allAgents: AgentEmployee[];
  selection: OrgSelection | null;
  onSelect: (selection: OrgSelection) => void;
  onStartDm: (agentId: string) => void;
  onHireIntoDept: (deptId: string) => void;
}

/** One child row hanging off a department's vertical spine, with an elbow connector. */
const Branch: React.FC<{ isLast: boolean; nodeHeight: number; children: React.ReactNode }> = ({
  isLast,
  nodeHeight,
  children,
}) => {
  const elbowY = BRANCH_GAP + nodeHeight / 2;
  return (
    <div className="relative pl-[34px]" style={{ paddingTop: BRANCH_GAP }}>
      <span
        className="absolute left-[19px] top-0 w-px"
        style={{ background: LINE, height: isLast ? elbowY : '100%' }}
      />
      <span
        className="absolute left-[19px] w-[15px] h-px"
        style={{ background: LINE, top: elbowY }}
      />
      <div style={{ height: nodeHeight }}>{children}</div>
    </div>
  );
};

const ControlButton: React.FC<{
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}> = ({ title, onClick, disabled, children }) => (
  <button
    title={title}
    onClick={onClick}
    disabled={disabled}
    className="w-7 h-7 rounded-md flex items-center justify-center text-[#555558] hover:bg-[#F2F2F5] hover:text-[#1C1C1E] disabled:opacity-35 disabled:hover:bg-transparent cursor-pointer disabled:cursor-default"
  >
    {children}
  </button>
);

export const OrgTreeView: React.FC<OrgTreeViewProps> = ({
  departments,
  agents,
  allAgents,
  selection,
  onSelect,
  onStartDm,
  onHireIntoDept,
}) => {
  const canvasRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const autoFitDone = useRef(false);
  const [zoom, setZoom] = useState(1);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [panning, setPanning] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  // Track the unscaled chart size so the scroll area matches the scaled chart.
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.offsetWidth, h: el.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Shrink once on first render when the chart is wider than the canvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (autoFitDone.current || !canvas || !size.w) return;
    autoFitDone.current = true;
    const available = canvas.clientWidth - CANVAS_PAD * 2;
    if (size.w > available) setZoom(clampZoom(Math.min(1, available / size.w)));
  }, [size]);

  // Ctrl / Cmd + wheel zoom needs a non-passive native listener to suppress page zoom.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom((z) => clampZoom(z * (e.deltaY > 0 ? 0.92 : 1.08)));
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  const fitToCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas || !size.w || !size.h) return;
    const fit = Math.min(
      (canvas.clientWidth - CANVAS_PAD * 2) / size.w,
      (canvas.clientHeight - CANVAS_PAD * 2) / size.h
    );
    setZoom(clampZoom(Math.min(1, fit)));
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('[data-org-node], button, select, input')) return;
    const canvas = e.currentTarget;
    panRef.current = {
      x: e.clientX,
      y: e.clientY,
      left: canvas.scrollLeft,
      top: canvas.scrollTop,
    };
    canvas.setPointerCapture(e.pointerId);
    setPanning(true);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = panRef.current;
    if (!start) return;
    e.currentTarget.scrollLeft = start.left - (e.clientX - start.x);
    e.currentTarget.scrollTop = start.top - (e.clientY - start.y);
  };

  const endPan = () => {
    panRef.current = null;
    setPanning(false);
  };

  const toggleDept = (deptId: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(deptId)) next.delete(deptId);
      else next.add(deptId);
      return next;
    });

  const allCollapsed = departments.length > 0 && departments.every((d) => collapsed.has(d.id));
  const isSelected = (kind: OrgSelection['kind'], id: string) =>
    selection?.kind === kind && selection.id === id;

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        className={`absolute inset-0 overflow-auto ${panning ? 'cursor-grabbing' : 'cursor-grab'}`}
        style={{
          backgroundImage: 'radial-gradient(circle, #D3D4DA 1px, transparent 1px)',
          backgroundSize: '18px 18px',
          backgroundAttachment: 'local',
        }}
      >
        <div className="min-w-full min-h-full w-max flex justify-center items-start p-10 pb-20">
          <div className="relative shrink-0" style={{ width: size.w * zoom, height: size.h * zoom }}>
            <div
              ref={contentRef}
              className="absolute left-0 top-0 w-max flex flex-col items-center"
              style={{ transform: `scale(${zoom})`, transformOrigin: '0 0' }}
            >
              {/* Root: founder / CEO */}
              <div
                data-org-node
                className="w-[320px] rounded-2xl bg-white border border-[#0099FF]/25 shadow-[0_8px_24px_-10px_rgba(0,153,255,0.4)] overflow-hidden cursor-default"
              >
                <div className="px-4 pt-3.5 pb-3 flex items-center gap-3">
                  <AvatarIcon type="founder-girl" size="lg" showTopBarBadge />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[15px] font-bold text-[#1C1C1E]">丶殇泪</span>
                      <span className="text-[10px] leading-4 font-semibold bg-[#0099FF] text-white px-1.5 rounded">
                        CEO
                      </span>
                    </div>
                    <div className="text-[11.5px] text-[#6E6E73] mt-0.5">
                      一人公司创始人 · 最高指令官
                    </div>
                  </div>
                  <Crown className="w-4 h-4 text-[#F5A623] shrink-0" />
                </div>
                <div className="grid grid-cols-3 border-t border-[#EEF1F5] bg-[#F7FAFE] py-2">
                  <Metric value={departments.length} label="直属部门" />
                  <Metric
                    value={allAgents.length}
                    label="数字员工"
                    className="border-x border-[#E6ECF3]"
                  />
                  <Metric value={formatCost(sumCost(allAgents))} label="日薪合计" />
                </div>
              </div>

              {departments.length > 0 && <span className="w-px h-7" style={{ background: LINE }} />}

              {/* Department columns with shared horizontal bus line */}
              <div className="flex items-start">
                {departments.map((dept, index) => {
                  const lead = getDeptLead(dept, allAgents);
                  const deptAll = allAgents.filter((a) => a.departmentId === dept.id);
                  const members = sortMembers(
                    agents.filter((a) => a.departmentId === dept.id),
                    lead?.id
                  );
                  const isCollapsed = collapsed.has(dept.id);
                  const workingCount = deptAll.filter((a) => a.status === 'working').length;

                  return (
                    <div key={dept.id} className="relative px-3 pt-7">
                      {index > 0 && (
                        <span
                          className="absolute top-0 left-0 right-1/2 h-px"
                          style={{ background: LINE }}
                        />
                      )}
                      {index < departments.length - 1 && (
                        <span
                          className="absolute top-0 left-1/2 right-0 h-px"
                          style={{ background: LINE }}
                        />
                      )}
                      <span
                        className="absolute top-0 left-1/2 w-px h-7"
                        style={{ background: LINE }}
                      />

                      {/* Department node */}
                      <div
                        data-org-node
                        role="button"
                        tabIndex={0}
                        onClick={() => onSelect({ kind: 'dept', id: dept.id })}
                        onKeyDown={activateOnKey(() => onSelect({ kind: 'dept', id: dept.id }))}
                        className={`relative w-[248px] rounded-xl bg-white border overflow-hidden cursor-pointer transition-shadow outline-none focus-visible:ring-2 focus-visible:ring-[#0099FF]/40 ${
                          isSelected('dept', dept.id)
                            ? 'border-[#0099FF] shadow-[0_0_0_3px_rgba(0,153,255,0.15)]'
                            : 'border-[#E3E3E8] shadow-[0_1px_2px_rgba(0,0,0,0.04)] hover:shadow-[0_6px_16px_-6px_rgba(0,0,0,0.16)]'
                        }`}
                      >
                        <div className="h-[3px]" style={{ background: dept.color }} />
                        <div className="p-3">
                          <div className="flex items-start gap-2.5">
                            <span
                              className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                              style={{ background: `${dept.color}1A`, color: dept.color }}
                            >
                              <Building2 className="w-4 h-4" />
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="text-[13px] font-bold text-[#1C1C1E] truncate leading-tight">
                                {dept.name}
                              </div>
                              <div className="text-[10.5px] font-mono text-[#8E8E93] mt-0.5">
                                {dept.code}
                              </div>
                            </div>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleDept(dept.id);
                              }}
                              title={isCollapsed ? '展开成员' : '折叠成员'}
                              className="w-6 h-6 -mr-1 -mt-0.5 rounded-md flex items-center justify-center text-[#8E8E93] hover:bg-[#F2F2F5] hover:text-[#1C1C1E] cursor-pointer"
                            >
                              <ChevronDown
                                className={`w-4 h-4 transition-transform ${isCollapsed ? '-rotate-90' : ''}`}
                              />
                            </button>
                          </div>

                          <div className="mt-2.5 h-6 flex items-center gap-1.5 text-[11px] text-[#6E6E73] min-w-0">
                            {lead ? (
                              <>
                                <AvatarIcon
                                  type={lead.avatarType}
                                  avatarUrl={lead.avatarUrl}
                                  name={lead.name}
                                  size="xs"
                                />
                                <span className="truncate">
                                  负责人 ·{' '}
                                  <span className="text-[#1C1C1E] font-medium">{lead.name}</span>
                                </span>
                              </>
                            ) : (
                              <span className="text-[#AEAEB2]">负责人待任命</span>
                            )}
                          </div>

                          <div className="mt-2.5 grid grid-cols-3 rounded-lg bg-[#F6F6F8] py-1.5">
                            <Metric value={deptAll.length} label="成员" />
                            <Metric
                              value={workingCount}
                              label="执行中"
                              className="border-x border-[#E8E8EC]"
                            />
                            <Metric value={formatCost(sumCost(deptAll))} label="日薪" />
                          </div>
                        </div>
                      </div>

                      {/* Members hanging off the department spine */}
                      {isCollapsed ? (
                        <Branch isLast nodeHeight={SMALL_NODE_H}>
                          <button
                            onClick={() => toggleDept(dept.id)}
                            className="h-full w-[214px] rounded-[10px] bg-white/80 border border-[#E3E3E8] text-[11.5px] text-[#6E6E73] hover:text-[#0077CC] hover:border-[#0099FF]/40 flex items-center justify-center gap-1.5 cursor-pointer"
                          >
                            <ChevronsUpDown className="w-3.5 h-3.5" />
                            已折叠 {members.length} 名成员
                          </button>
                        </Branch>
                      ) : (
                        <div>
                          {members.map((ag) => (
                            <Branch key={ag.id} isLast={false} nodeHeight={AGENT_NODE_H}>
                              <div
                                data-org-node
                                role="button"
                                tabIndex={0}
                                onClick={() => onSelect({ kind: 'agent', id: ag.id })}
                                onKeyDown={activateOnKey(() =>
                                  onSelect({ kind: 'agent', id: ag.id })
                                )}
                                className={`group h-full w-[214px] flex items-center gap-2.5 pl-2.5 pr-1.5 rounded-[10px] bg-white border cursor-pointer transition-all outline-none focus-visible:ring-2 focus-visible:ring-[#0099FF]/40 ${
                                  isSelected('agent', ag.id)
                                    ? 'border-[#0099FF] shadow-[0_0_0_3px_rgba(0,153,255,0.15)]'
                                    : 'border-[#E3E3E8] hover:border-[#C9CCD4] hover:shadow-[0_4px_12px_-6px_rgba(0,0,0,0.18)]'
                                }`}
                              >
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
                                  className="w-6 h-6 rounded-md flex items-center justify-center text-[#0099FF] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-[#E8F3FF] shrink-0 cursor-pointer"
                                >
                                  <MessageSquare className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </Branch>
                          ))}

                          {members.length === 0 && deptAll.length > 0 && (
                            <Branch isLast={false} nodeHeight={SMALL_NODE_H}>
                              <div className="h-full w-[214px] rounded-[10px] border border-[#E3E3E8] bg-white/60 text-[11.5px] text-[#AEAEB2] flex items-center justify-center">
                                无匹配成员
                              </div>
                            </Branch>
                          )}

                          <Branch isLast nodeHeight={SMALL_NODE_H}>
                            <button
                              onClick={() => onHireIntoDept(dept.id)}
                              className="h-full w-[214px] rounded-[10px] border border-dashed border-[#C7C7CC] bg-white/50 text-[11.5px] text-[#8E8E93] hover:text-[#0077CC] hover:border-[#0099FF] hover:bg-white flex items-center justify-center gap-1 transition-colors cursor-pointer"
                            >
                              <Plus className="w-3.5 h-3.5" />
                              增聘 Agent 员工
                            </button>
                          </Branch>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Legend */}
      <div className="absolute left-4 bottom-4 h-9 px-3 flex items-center gap-3 rounded-lg bg-white/95 border border-[#E5E5E7] shadow-[0_4px_14px_-6px_rgba(0,0,0,0.15)] text-[11px] text-[#6E6E73] pointer-events-none">
        {STATUS_ORDER.map((status) => (
          <span key={status} className="flex items-center gap-1.5">
            <span
              className="w-2 h-2 rounded-full"
              style={{ background: STATUS_META[status].color }}
            />
            {STATUS_META[status].label}
          </span>
        ))}
        <span className="w-px h-3 bg-[#E0E0E4]" />
        <span className="flex items-center gap-1">
          <Crown className="w-3 h-3 text-[#F5A623]" />
          负责人
        </span>
        <span className="hidden 2xl:block w-px h-3 bg-[#E0E0E4]" />
        <span className="hidden 2xl:inline text-[#8E8E93]">
          拖拽空白处平移 · ⌘/Ctrl + 滚轮缩放
        </span>
      </div>

      {/* Canvas controls */}
      <div className="absolute right-4 bottom-4 flex items-center gap-0.5 p-1 rounded-lg bg-white border border-[#E5E5E7] shadow-[0_4px_14px_-6px_rgba(0,0,0,0.15)]">
        <ControlButton
          title="缩小"
          onClick={() => setZoom((z) => clampZoom(z - 0.1))}
          disabled={zoom <= MIN_ZOOM}
        >
          <ZoomOut className="w-3.5 h-3.5" />
        </ControlButton>
        <button
          onClick={() => setZoom(1)}
          title="重置为 100%"
          className="w-11 h-7 rounded-md text-[11.5px] font-mono text-[#1C1C1E] hover:bg-[#F2F2F5] cursor-pointer"
        >
          {Math.round(zoom * 100)}%
        </button>
        <ControlButton
          title="放大"
          onClick={() => setZoom((z) => clampZoom(z + 0.1))}
          disabled={zoom >= MAX_ZOOM}
        >
          <ZoomIn className="w-3.5 h-3.5" />
        </ControlButton>
        <span className="w-px h-4 bg-[#E5E5E7] mx-0.5" />
        <ControlButton title="适配画布" onClick={fitToCanvas}>
          <Maximize2 className="w-3.5 h-3.5" />
        </ControlButton>
        <ControlButton
          title={allCollapsed ? '展开全部部门' : '折叠全部部门'}
          onClick={() =>
            setCollapsed(allCollapsed ? new Set() : new Set(departments.map((d) => d.id)))
          }
        >
          {allCollapsed ? (
            <ChevronsUpDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronsDownUp className="w-3.5 h-3.5" />
          )}
        </ControlButton>
      </div>
    </div>
  );
};
