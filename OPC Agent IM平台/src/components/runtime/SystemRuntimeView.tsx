import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Package,
  PanelRight,
  Pause,
  Play,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react"
import {
  INITIAL_WORKERS,
  PROTOTYPE_VARIANTS,
  RuntimePrototypeVariant,
  WorkerRuntimeItem,
  WorkerStatus,
} from "../../data/runtimeData"
import { RuntimeWorld, WorldSelection } from "./world/RuntimeWorld"
import { RuntimeSim, SimStats, WorkerActivity } from "./world/runtimeSim"
import { LabelBridge } from "./world/labelBridge"
import { SEMANTIC, STATIONS, statusColor } from "./world/worldConfig"

/* -------------------------------------------------------------------------- */
/* Small UI atoms                                                             */
/* -------------------------------------------------------------------------- */

const STATUS_META: Record<WorkerStatus, { label: string; cn: string; bg: string; text: string; border: string }> = {
  Running: { label: "RUNNING", cn: "运行中", bg: "bg-[#ECF7F0]", text: "text-[#157A45]", border: "border-[#C6E8D3]" },
  Waiting: { label: "WAITING", cn: "等待上游", bg: "bg-[#FDF6E7]", text: "text-[#A26C0B]", border: "border-[#F3DFB0]" },
  Idle: { label: "IDLE", cn: "待命", bg: "bg-[#F3F1EE]", text: "text-[#6B655C]", border: "border-[#E3DED6]" },
  Failed: { label: "FAILED", cn: "执行失败", bg: "bg-[#FCEDEB]", text: "text-[#B33326]", border: "border-[#F2C9C3]" },
}

const ACTIVITY_META: Record<WorkerActivity, { cn: string; color: string }> = {
  idle: { cn: "空闲，等待分派", color: SEMANTIC.idle },
  incoming: { cn: "包裹正在途中", color: SEMANTIC.route },
  holding: { cn: "包裹已到达，等待上游", color: SEMANTIC.wait },
  unboxing: { cn: "正在拆箱", color: "#C08A52" },
  working: { cn: "拆箱完成，正在处理", color: SEMANTIC.ok },
  fault: { cn: "拆箱时发生异常", color: SEMANTIC.fail },
}

const Overline: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = "" }) => (
  <div className={`font-mono text-[10px] uppercase tracking-[0.16em] text-[#9A9389] ${className}`}>{children}</div>
)

const StatusBadge: React.FC<{ status: WorkerStatus }> = ({ status }) => {
  const m = STATUS_META[status]
  return (
    <span className={`inline-flex h-[22px] items-center gap-1.5 rounded-[5px] border px-2 font-mono text-[10.5px] font-semibold ${m.bg} ${m.text} ${m.border}`}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: statusColor(status) }} />
      {m.label}
    </span>
  )
}

const Sparkline: React.FC<{ values: number[]; color: string }> = ({ values, color }) => {
  const w = 132
  const h = 34
  const max = Math.max(1, ...values)
  const pts = values.map((v, i) => [(i / Math.max(1, values.length - 1)) * w, h - 3 - (v / max) * (h - 8)])
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ")
  const area = `${line} L${w},${h} L0,${h} Z`
  const last = pts[pts.length - 1]
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible">
      <path d={area} fill={color} opacity={0.08} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      {last && <circle cx={last[0]} cy={last[1]} r={2.6} fill={color} />}
    </svg>
  )
}

/* -------------------------------------------------------------------------- */
/* World labels (projected from the 3D scene every frame)                     */
/* -------------------------------------------------------------------------- */

function WorldLabels({
  labels,
  statuses,
  selection,
  paused,
  empty,
  stale,
  onSelect,
  onIngress,
}: {
  labels: LabelBridge
  statuses: WorkerStatus[]
  selection: WorldSelection
  paused: boolean
  empty: boolean
  stale: boolean
  onSelect: (s: WorldSelection) => void
  onIngress: () => void
}) {
  const items = [
    { id: "ingress", title: "Ingress", sub: "收件入口 · 点击投递", color: empty ? SEMANTIC.idle : SEMANTIC.route, pulse: false, align: "center", onClick: onIngress },
    { id: "router", title: "Router", sub: "分拣中心", color: empty ? SEMANTIC.idle : SEMANTIC.route, pulse: !empty && !paused, align: "center", onClick: () => onSelect("router") },
    ...STATIONS.map((s, i) => ({
      id: s.workerId,
      title: s.label,
      sub: s.cnRole,
      color: statusColor(statuses[i]),
      pulse: statuses[i] === "Running" && !paused,
      align: "start",
      onClick: () => onSelect(s.workerId),
    })),
    { id: "watchdog", title: "Watchdog", sub: stale ? "心跳超时" : "健康巡检", color: stale ? SEMANTIC.fail : SEMANTIC.ok, pulse: !paused, align: "center", onClick: () => onSelect("watchdog") },
  ]
  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      {items.map((it) => {
        const selected = selection === it.id
        return (
          <button
            key={it.id}
            ref={labels.bind(it.id)}
            data-align={it.align}
            type="button"
            onClick={it.onClick}
            style={{ opacity: 0 }}
            className={`pointer-events-auto absolute left-0 top-0 flex h-[26px] cursor-pointer select-none items-center gap-2 whitespace-nowrap rounded-full border px-2.5 text-[11px] shadow-[0_6px_18px_rgba(40,30,15,0.10)] transition-[opacity,background-color,border-color,color] duration-200 will-change-transform ${
              selected ? "border-[#17181A] bg-[#17181A] text-white" : "border-black/[0.07] bg-white text-[#2A2E35] hover:border-black/20"
            }`}
          >
            <span className="relative flex h-1.5 w-1.5">
              {it.pulse && <span className="absolute inset-0 rounded-full rt-ping" style={{ background: it.color }} />}
              <span className="relative h-1.5 w-1.5 rounded-full" style={{ background: it.color }} />
            </span>
            <span className="font-mono font-semibold tracking-tight">{it.title}</span>
            <span className={selected ? "text-white/55" : "text-[#8A857D]"}>{it.sub}</span>
          </button>
        )
      })}
      <div
        ref={labels.bind("tag")}
        style={{ opacity: 0 }}
        className="absolute left-0 top-0 flex items-center gap-1.5 whitespace-nowrap rounded-[6px] border border-black/[0.08] bg-white/95 px-2 py-[3px] font-mono text-[10.5px] text-[#2A2E35] shadow-[0_4px_14px_rgba(30,25,15,0.12)] transition-opacity duration-300 will-change-transform"
      >
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: SEMANTIC.route }} />
        <span />
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Inspector sections                                                         */
/* -------------------------------------------------------------------------- */

const StageNode: React.FC<{ status: string }> = ({ status }) => {
  const color =
    status === "done" ? SEMANTIC.ok : status === "running" ? SEMANTIC.ok : status === "waiting" ? SEMANTIC.wait : status === "failed" ? SEMANTIC.fail : "#C9C3B9"
  if (status === "done")
    return (
      <span className="flex h-[15px] w-[15px] items-center justify-center rounded-full" style={{ background: color }}>
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
          <path d="M1.5 4.2L3.2 5.8L6.5 2.4" stroke="white" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    )
  return (
    <span className="relative flex h-[15px] w-[15px] items-center justify-center rounded-full border-[1.5px] bg-white" style={{ borderColor: color }}>
      {status !== "idle" && <span className={`h-[5px] w-[5px] rounded-full ${status === "running" ? "rt-pulse" : ""}`} style={{ background: color }} />}
    </span>
  )
}

function WorkerInspector({
  worker,
  index,
  activity,
  queue,
  paused,
  onDispatch,
}: {
  worker: WorkerRuntimeItem
  index: number
  activity: WorkerActivity
  queue: number
  paused: boolean
  onDispatch: () => void
}) {
  const [tab, setTab] = useState<"trace" | "messages" | "watchdog">("trace")
  const spec = STATIONS[index]
  const act = ACTIVITY_META[activity]
  const busy = activity === "unboxing" || activity === "working"

  return (
    <>
      <div className="border-b border-black/[0.06] px-5 pb-4 pt-1">
        <Overline>当前任务</Overline>
        <p className="mt-1.5 text-[15px] font-medium leading-[1.45] text-[#17181A]">{worker.currentTask}</p>
        <div className="mt-3 flex items-center gap-2.5 rounded-[7px] border border-black/[0.06] bg-[#FAF8F5] px-3 py-2">
          <span className="relative flex h-2 w-2">
            {busy && !paused && <span className="absolute inset-0 rounded-full rt-ping" style={{ background: act.color }} />}
            <span className="relative h-2 w-2 rounded-full" style={{ background: act.color }} />
          </span>
          <span className="flex-1 text-[12.5px] text-[#3F3B35]">{act.cn}</span>
          <span className="font-mono text-[11px] text-[#8A857D]">流水线 {queue}</span>
        </div>
        {busy && (
          <div className="mt-2 h-[3px] overflow-hidden rounded-full bg-[#EDE8E0]">
            <div className="h-full w-1/3 rounded-full rt-progress-bar" style={{ background: act.color, animationPlayState: paused ? "paused" : "running" }} />
          </div>
        )}
      </div>

      <dl className="grid grid-cols-2 border-b border-black/[0.06]">
        {[
          ["Model", worker.model],
          ["Thread", worker.thread],
          ["Started", worker.startedAgo],
          ["Tokens", worker.tokens],
        ].map(([k, v], i) => (
          <div key={k} className={`px-5 py-3 ${i % 2 === 0 ? "border-r" : ""} ${i < 2 ? "border-b" : ""} border-black/[0.06]`}>
            <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#9A9389]">{k}</dt>
            <dd className="mt-1 truncate font-mono text-[12.5px] text-[#17181A]">{v}</dd>
          </div>
        ))}
      </dl>

      <div className="flex h-11 shrink-0 items-end gap-5 border-b border-black/[0.06] px-5">
        {(
          [
            ["trace", "Trace"],
            ["messages", "Messages"],
            ["watchdog", "Watchdog"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`relative cursor-pointer pb-2.5 font-mono text-[12px] transition-colors duration-200 ${
              tab === id ? "font-semibold text-[#17181A]" : "text-[#9A9389] hover:text-[#3F3B35]"
            }`}
          >
            {label}
            {id === "watchdog" && worker.watchdog.ttlGuard !== "PASS" && (
              <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle" style={{ background: worker.watchdog.ttlGuard === "EXPIRED" ? SEMANTIC.fail : SEMANTIC.wait }} />
            )}
            <span className={`absolute inset-x-0 -bottom-px h-[2px] rounded-full bg-[#17181A] transition-opacity duration-200 ${tab === id ? "opacity-100" : "opacity-0"}`} />
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {tab === "trace" && (
          <div className="space-y-5">
            <section>
              <div className="mb-3 flex items-baseline justify-between">
                <h3 className="text-[12.5px] font-semibold text-[#17181A]">执行阶段</h3>
                <span className="font-mono text-[10.5px] text-[#9A9389]">
                  {worker.stages.filter((s) => s.status === "done").length}/{worker.stages.length}
                </span>
              </div>
              <ol>
                {worker.stages.map((st, i) => (
                  <li key={st.id} className="relative flex gap-3 pb-3.5 last:pb-0">
                    {i < worker.stages.length - 1 && (
                      <span className="absolute left-[7px] top-[17px] bottom-0 w-px" style={{ background: st.status === "done" ? "#BFE3CC" : "#E7E1D8" }} />
                    )}
                    <span className="relative z-10 mt-[1px]">
                      <StageNode status={st.status} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className={`font-mono text-[12px] ${st.status === "idle" ? "text-[#A39D93]" : "font-medium text-[#17181A]"}`}>{st.label}</span>
                        <span className="font-mono text-[10.5px] text-[#A39D93]">{st.timestamp}</span>
                      </div>
                      <p className="mt-0.5 text-[11.5px] leading-snug text-[#8A857D]">{st.sublabel}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </section>

            <section>
              <div className="mb-2.5 flex items-baseline justify-between">
                <h3 className="font-mono text-[12.5px] font-semibold text-[#17181A]">Tool trace</h3>
                <span className="font-mono text-[10.5px] text-[#9A9389]">{worker.traces.length} calls</span>
              </div>
              {worker.traces.length === 0 ? (
                <div className="rounded-[7px] border border-dashed border-black/[0.1] px-3 py-5 text-center text-[12px] text-[#9A9389]">暂无工具调用</div>
              ) : (
                <div className="overflow-hidden rounded-[7px] border border-black/[0.07]">
                  {worker.traces.map((tr) => (
                    <div key={tr.id} className="flex items-start gap-2.5 border-t border-black/[0.06] px-3 py-2.5 first:border-t-0">
                      <span className="mt-[1px]">
                        {tr.status === "success" && <CheckCircle2 className="h-3.5 w-3.5" style={{ color: SEMANTIC.ok }} />}
                        {tr.status === "running" && <RefreshCw className="h-3.5 w-3.5 animate-spin" style={{ color: SEMANTIC.route, animationPlayState: paused ? "paused" : "running" }} />}
                        {tr.status === "waiting" && <Clock className="h-3.5 w-3.5" style={{ color: SEMANTIC.wait }} />}
                        {tr.status === "failed" && <AlertCircle className="h-3.5 w-3.5" style={{ color: SEMANTIC.fail }} />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="font-mono text-[12px] font-semibold text-[#17181A]">{tr.toolName}</span>
                          <span className="font-mono text-[11px] tabular-nums text-[#3F3B35]">{tr.duration}</span>
                        </div>
                        <div className="mt-0.5 flex items-baseline justify-between gap-2">
                          <span className="truncate font-mono text-[10.5px] text-[#9A9389]">{tr.argsDigest}</span>
                          <span className="shrink-0 font-mono text-[10.5px] text-[#9A9389]">{tr.tokens} tok</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        {tab === "messages" && (
          <div className="space-y-2.5">
            {worker.messages.map((m) => (
              <div key={m.id} className="rounded-[7px] border border-black/[0.07] px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span
                      className="rounded-[4px] px-1.5 py-[1px] font-mono text-[9.5px] font-semibold"
                      style={{ background: m.direction === "in" ? "#EAF0FE" : "#ECF7F0", color: m.direction === "in" ? SEMANTIC.route : SEMANTIC.ok }}
                    >
                      {m.direction === "in" ? "IN" : "OUT"}
                    </span>
                    <span className="font-mono text-[12px] font-semibold text-[#17181A]">{m.type}</span>
                  </div>
                  <span className="font-mono text-[10.5px] text-[#A39D93]">{m.timestamp}</span>
                </div>
                <p className="mt-1.5 text-[12px] text-[#3F3B35]">{m.summary}</p>
                <code className="mt-2 block truncate rounded-[5px] bg-[#F6F3EE] px-2 py-1 font-mono text-[10.5px] text-[#6B655C]">{m.payloadDigest}</code>
              </div>
            ))}
          </div>
        )}

        {tab === "watchdog" && <WorkerWatchdog worker={worker} />}
      </div>

      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-black/[0.06] px-5 py-3">
        <span className="flex items-center gap-1.5 text-[11px] text-[#9A9389]">
          <ShieldCheck className="h-3.5 w-3.5" style={{ color: SEMANTIC.ok }} />
          仅展示结构化摘要，不含原始推理
        </span>
        <button
          type="button"
          onClick={onDispatch}
          className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-[6px] border border-black/[0.08] px-2.5 text-[11.5px] font-medium text-[#17181A] transition-colors duration-200 hover:bg-[#F6F3EE]"
          style={{ boxShadow: `inset 0 -2px 0 ${spec.accent}` }}
        >
          投递任务
          <ArrowRight className="h-3 w-3" />
        </button>
      </div>
    </>
  )
}

function WorkerWatchdog({ worker }: { worker: WorkerRuntimeItem }) {
  const wd = worker.watchdog
  const tone = wd.ttlGuard === "EXPIRED" ? SEMANTIC.fail : wd.ttlGuard === "WARN" ? SEMANTIC.wait : SEMANTIC.ok
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2.5 rounded-[7px] border px-3 py-2.5" style={{ borderColor: `${tone}40`, background: `${tone}0D` }}>
        {wd.ttlGuard === "EXPIRED" ? <ShieldAlert className="mt-[1px] h-4 w-4" style={{ color: tone }} /> : <ShieldCheck className="mt-[1px] h-4 w-4" style={{ color: tone }} />}
        <div>
          <div className="text-[12.5px] font-semibold text-[#17181A]">
            {wd.ttlGuard === "EXPIRED" ? "心跳回执已超时" : wd.ttlGuard === "WARN" ? "挂起等待，回执偏慢" : "心跳稳定"}
          </div>
          <div className="mt-0.5 font-mono text-[11px] text-[#6B655C]">
            ttl_guard={wd.ttlGuard} · drift {wd.driftMs}
          </div>
        </div>
      </div>
      <dl className="overflow-hidden rounded-[7px] border border-black/[0.07]">
        {[
          ["心跳周期", wd.heartbeatInterval],
          ["最近回执", wd.lastAck],
          ["常驻内存", wd.memoryRss],
          ["Token 预算", wd.tokenBudget],
        ].map(([k, v]) => (
          <div key={k} className="flex items-center justify-between border-t border-black/[0.06] px-3 py-2 first:border-t-0">
            <dt className="text-[12px] text-[#8A857D]">{k}</dt>
            <dd className="font-mono text-[12px] text-[#17181A]">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function RouterInspector({ workers, stats }: { workers: WorkerRuntimeItem[]; stats: SimStats | null }) {
  const total = Math.max(1, stats?.workerQueue.reduce((a, b) => a + b, 0) ?? 1)
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="grid grid-cols-3 border-b border-black/[0.06]">
        {[
          ["正在分拣", stats?.sorting ?? 0],
          ["轨道在途", stats?.transit ?? 0],
          ["待入队", 8],
        ].map(([k, v], i) => (
          <div key={k} className={`px-5 py-4 ${i < 2 ? "border-r border-black/[0.06]" : ""}`}>
            <Overline>{k}</Overline>
            <div className="mt-1.5 text-[24px] font-semibold leading-none tabular-nums text-[#17181A]">{String(v).padStart(2, "0")}</div>
          </div>
        ))}
      </div>
      <section className="px-5 py-4">
        <div className="mb-3 flex items-baseline justify-between">
          <h3 className="text-[12.5px] font-semibold text-[#17181A]">路由表</h3>
          <span className="font-mono text-[10.5px] text-[#9A9389]">triage → worker</span>
        </div>
        <div className="space-y-2.5">
          {workers.map((w, i) => {
            const share = stats ? stats.workerQueue[i] / total : 0
            return (
              <div key={w.id} className="flex items-center gap-3">
                <span className="h-6 w-1 rounded-full" style={{ background: STATIONS[i].accent }} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[12px] font-medium text-[#17181A]">{w.name}</span>
                    <span className="flex items-center gap-1.5 font-mono text-[10.5px] text-[#8A857D]">
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: statusColor(w.status) }} />
                      {stats?.workerQueue[i] ?? 0} 件
                    </span>
                  </div>
                  <div className="mt-1.5 h-[3px] overflow-hidden rounded-full bg-[#EFEAE2]">
                    <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.round(share * 100)}%`, background: SEMANTIC.route }} />
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </section>
      <section className="border-t border-black/[0.06] px-5 py-4">
        <h3 className="mb-2 text-[12.5px] font-semibold text-[#17181A]">分拣规则</h3>
        <ul className="space-y-1.5 font-mono text-[11px] text-[#6B655C]">
          <li>scan.label → triage.score → exit.gate</li>
          <li>Waiting worker：同一时间只保留 1 件到站包裹</li>
          <li>Failed worker：降权分派，异常经 Watchdog 回报</li>
        </ul>
      </section>
    </div>
  )
}

function WatchdogInspector({ workers, stale, stats }: { workers: WorkerRuntimeItem[]; stale: boolean; stats: SimStats | null }) {
  const tone = stale ? SEMANTIC.fail : SEMANTIC.ok
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="border-b border-black/[0.06] px-5 py-4">
        <Overline>系统心跳</Overline>
        <div className="mt-2 flex items-end gap-3">
          <span className="text-[30px] font-semibold leading-none tabular-nums" style={{ color: stale ? tone : "#17181A" }}>
            {stale ? "48.2s" : `${(stats?.lastBeatAgo ?? 0).toFixed(1)}s`}
          </span>
          <span className="pb-1 text-[12px] text-[#8A857D]">{stale ? "未收到守护回执" : "前收到最近一次心跳"}</span>
        </div>
        <div className="mt-3 flex items-center gap-2 font-mono text-[11px] text-[#6B655C]">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: tone }} />
          interval 1200ms · reports {stats?.delivered ?? 0} · faults {stats?.faults ?? 0}
        </div>
      </div>
      <section className="px-5 py-4">
        <h3 className="mb-3 text-[12.5px] font-semibold text-[#17181A]">Worker 回执</h3>
        <div className="overflow-hidden rounded-[7px] border border-black/[0.07]">
          {workers.map((w) => {
            const g = w.watchdog.ttlGuard
            const c = g === "EXPIRED" ? SEMANTIC.fail : g === "WARN" ? SEMANTIC.wait : SEMANTIC.ok
            return (
              <div key={w.id} className="flex items-center gap-3 border-t border-black/[0.06] px-3 py-2.5 first:border-t-0">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: c }} />
                <span className="flex-1 font-mono text-[12px] text-[#17181A]">{w.name}</span>
                <span className="font-mono text-[11px] text-[#8A857D]">{w.watchdog.lastAck}</span>
                <span className="w-[58px] text-right font-mono text-[10px] font-semibold" style={{ color: c }}>
                  {g}
                </span>
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

const PIPELINE: { key: keyof SimStats; no: string; cn: string; en: string; color: string }[] = [
  { key: "ingress", no: "01", cn: "收件入站", en: "ingress", color: SEMANTIC.route },
  { key: "sorting", no: "02", cn: "扫码分拣", en: "route.scan", color: SEMANTIC.route },
  { key: "transit", no: "03", cn: "轨道派送", en: "dispatch", color: SEMANTIC.route },
  { key: "unboxing", no: "04", cn: "拆箱开工", en: "unbox", color: "#C08A52" },
  { key: "reports", no: "05", cn: "回报巡检", en: "report", color: SEMANTIC.ok },
]

export const SystemRuntimeView: React.FC = () => {
  const [variant, setVariant] = useState<RuntimePrototypeVariant>("normal")
  const [paused, setPaused] = useState(false)
  const [selection, setSelection] = useState<WorldSelection>(null)
  const [stats, setStats] = useState<SimStats | null>(null)
  const [history, setHistory] = useState<number[]>(() => Array.from({ length: 28 }, (_, i) => 2 + Math.round(Math.abs(Math.sin(i * 0.9)) * 3)))
  const [pausedFor, setPausedFor] = useState(0)
  const pausedAt = useRef<number | null>(null)
  const lastDelivered = useRef<number | null>(null)
  const lastSample = useRef(0)
  const pendingSpawn = useRef<number | null | undefined>(undefined)

  const workers = useMemo<WorkerRuntimeItem[]>(() => {
    if (variant === "empty")
      return INITIAL_WORKERS.map((w) => ({
        ...w,
        status: "Idle" as WorkerStatus,
        currentTask: "待命 · 队列为空",
        elapsed: "--:--",
        startedAgo: "idle",
        tokens: "0.0k",
        stages: w.stages.map((s) => ({ ...s, status: "idle" as const })),
        traces: [],
      }))
    if (variant === "stale")
      return INITIAL_WORKERS.map((w) => ({
        ...w,
        watchdog: { ...w.watchdog, lastAck: "48.2s ago", ttlGuard: "EXPIRED" as const, driftMs: "+48200ms" },
      }))
    return INITIAL_WORKERS
  }, [variant])

  const statuses = useMemo(() => workers.map((w) => w.status), [workers])

  const [sim] = useState(() => {
    const s = new RuntimeSim()
    s.setState(
      INITIAL_WORKERS.map((w) => w.status),
      "normal",
    )
    s.warmUp(9)
    return s
  })
  const [labels] = useState(() => new LabelBridge())

  useEffect(() => {
    sim.setState(statuses, variant)
    if (pendingSpawn.current !== undefined) {
      sim.spawn(pendingSpawn.current ?? undefined)
      pendingSpawn.current = undefined
    }
  }, [sim, statuses, variant])

  useEffect(() => {
    if (paused) pausedAt.current = performance.now()
    else {
      pausedAt.current = null
      setPausedFor(0)
    }
  }, [paused])

  const handleStats = useCallback((s: SimStats) => {
    setStats(s)
    if (pausedAt.current !== null) setPausedFor(Math.round((performance.now() - pausedAt.current) / 1000))
    const now = performance.now()
    if (now - lastSample.current > 1600) {
      lastSample.current = now
      const prev = lastDelivered.current
      lastDelivered.current = s.delivered
      if (prev !== null && pausedAt.current === null) setHistory((h) => [...h.slice(1), Math.max(0, s.delivered - prev) + 1])
    }
  }, [])

  const dispatch = useCallback(
    (worker?: number) => {
      setPaused(false)
      if (variant === "empty" || variant === "paused") {
        pendingSpawn.current = worker ?? null
        setVariant("normal")
        return
      }
      sim.spawn(worker)
    },
    [sim, variant],
  )

  const handleSelect = useCallback((next: WorldSelection) => setSelection((cur) => (cur === next ? null : next)), [])
  const handleBackground = useCallback(() => setSelection(null), [])
  const handleIngress = useCallback(() => dispatch(), [dispatch])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelection(null)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const selectVariant = (next: RuntimePrototypeVariant) => {
    setVariant(next)
    setPaused(next === "paused")
    if (next === "waiting") setSelection("worker-content")
    else if (next === "failed") setSelection("worker-review")
    else if (next === "stale") setSelection("watchdog")
    else if (next === "empty") setSelection(null)
  }

  const togglePause = () => {
    if (paused) {
      setPaused(false)
      if (variant === "paused") setVariant("normal")
    } else setPaused(true)
  }

  const stale = variant === "stale"
  const empty = variant === "empty"
  const workerIndex = workers.findIndex((w) => w.id === selection)
  const inspectorOpen = selection !== null
  const running = workers.filter((w) => w.status === "Running").length
  const inFlight = stats ? stats.ingress + stats.sorting + stats.transit : 0
  const updatedAgo = paused ? pausedFor + 1 : stale ? 48 : 1

  const live = paused
    ? { label: "PAUSED", color: SEMANTIC.wait }
    : stale
      ? { label: "STALE", color: SEMANTIC.fail }
      : empty
        ? { label: "STANDBY", color: SEMANTIC.idle }
        : { label: "LIVE", color: SEMANTIC.ok }

  return (
    <div className="@container relative min-h-0 min-w-0 flex-1 overflow-hidden bg-[#F2EEE7] text-[#17181A]">
      {/* 3D world */}
      <div className="absolute inset-0 transition-[filter] duration-500" style={{ filter: paused ? "saturate(0.55) brightness(1.02)" : "none" }}>
        <RuntimeWorld
          sim={sim}
          labels={labels}
          statuses={statuses}
          variant={variant}
          paused={paused}
          selection={selection}
          onSelect={handleSelect}
          onIngress={handleIngress}
          onBackground={handleBackground}
          onStats={handleStats}
        />
      </div>

      <WorldLabels
        labels={labels}
        statuses={statuses}
        selection={selection}
        paused={paused}
        empty={empty}
        stale={stale}
        onSelect={handleSelect}
        onIngress={handleIngress}
      />

      {/* Title block */}
      <div className="pointer-events-none absolute left-7 top-6 z-20 select-none">
        <div className="flex items-center gap-2.5 font-mono text-[10px] uppercase tracking-[0.2em] text-[#9A9389]">
          <span>Runtime Observatory</span>
          <span className="h-px w-8 bg-[#D3CCC0]" />
          <span>pi.router.v2 · local</span>
        </div>
        <h1 className="mt-3 text-[34px] font-semibold leading-none tracking-[-0.035em] text-[#17181A]">系统运行态</h1>
        <div className="mt-2.5 flex items-center gap-3">
          <span className="font-display text-[20px] italic leading-none text-[#6B655C]">Router · Workers · Watchdog</span>
          <span className="inline-flex h-[22px] items-center gap-1.5 rounded-full border border-black/[0.07] bg-white px-2 font-mono text-[10px] font-semibold tracking-[0.08em]" style={{ color: live.color }}>
            <span className="relative flex h-1.5 w-1.5">
              {live.label === "LIVE" && <span className="absolute inset-0 rounded-full rt-ping" style={{ background: live.color }} />}
              <span className={`relative h-1.5 w-1.5 rounded-full ${live.label === "STALE" ? "rt-pulse" : ""}`} style={{ background: live.color }} />
            </span>
            {live.label}
          </span>
        </div>
        <div className="mt-3 font-mono text-[11px] text-[#9A9389]">
          {empty ? "系统空闲 · 监听收件入口" : `最后更新 ${updatedAgo} 秒前`}
          <span className="mx-2 text-[#D3CCC0]">/</span>
          拖拽旋转视角，点击建筑查看详情
        </div>
      </div>

      {/* Controls */}
      <div className="absolute right-6 top-6 z-30 flex items-center gap-2">
        <div className="flex h-9 items-center rounded-[8px] border border-black/[0.07] bg-white p-[3px] shadow-[0_6px_20px_rgba(40,30,15,0.06)] @max-[1140px]:hidden">
          <span className="px-2 font-mono text-[10px] uppercase tracking-[0.14em] text-[#9A9389]">场景</span>
          {PROTOTYPE_VARIANTS.map((v) => (
            <button
              key={v.id}
              type="button"
              title={v.description}
              onClick={() => selectVariant(v.id)}
              className={`h-full cursor-pointer rounded-[6px] px-2.5 text-[12px] transition-colors duration-200 ${
                variant === v.id ? "bg-[#17181A] font-medium text-white" : "text-[#6B655C] hover:bg-[#F4F1EC] hover:text-[#17181A]"
              }`}
            >
              {v.shortLabel}
            </button>
          ))}
        </div>
        {/* Compact scenario picker for narrow windows */}
        <label className="relative hidden h-9 items-center rounded-[8px] border border-black/[0.07] bg-white pl-3 pr-8 shadow-[0_6px_20px_rgba(40,30,15,0.06)] @max-[1140px]:flex">
          <span className="mr-2 font-mono text-[10px] uppercase tracking-[0.14em] text-[#9A9389]">场景</span>
          <select
            value={variant}
            onChange={(e) => selectVariant(e.target.value as RuntimePrototypeVariant)}
            aria-label="切换运行场景"
            className="cursor-pointer appearance-none bg-transparent text-[12.5px] font-medium text-[#17181A] outline-none"
          >
            {PROTOTYPE_VARIANTS.map((v) => (
              <option key={v.id} value={v.id}>
                {v.shortLabel}
              </option>
            ))}
          </select>
          <svg className="pointer-events-none absolute right-2.5 h-3 w-3 text-[#9A9389]" viewBox="0 0 12 12" fill="none">
            <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </label>
        <button
          type="button"
          onClick={() => dispatch()}
          className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[8px] bg-[#17181A] px-3.5 text-[12.5px] font-medium text-white shadow-[0_6px_20px_rgba(23,24,26,0.18)] transition-colors duration-200 hover:bg-[#2A2C30]"
        >
          <Package className="h-3.5 w-3.5" />
          投递任务
        </button>
        <button
          type="button"
          onClick={togglePause}
          title={paused ? "继续接收" : "暂停实时更新"}
          className={`inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-[8px] border shadow-[0_6px_20px_rgba(40,30,15,0.06)] transition-colors duration-200 ${
            paused ? "border-[#F3DFB0] bg-[#FDF6E7] text-[#A26C0B]" : "border-black/[0.07] bg-white text-[#3F3B35] hover:bg-[#F6F3EE]"
          }`}
        >
          {paused ? <Play className="h-3.5 w-3.5 fill-current" /> : <Pause className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          onClick={() => setSelection((s) => (s ? null : "worker-research"))}
          title={inspectorOpen ? "收起详情" : "展开详情"}
          className={`inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-[8px] border shadow-[0_6px_20px_rgba(40,30,15,0.06)] transition-colors duration-200 ${
            inspectorOpen ? "border-[#17181A] bg-[#17181A] text-white" : "border-black/[0.07] bg-white text-[#3F3B35] hover:bg-[#F6F3EE]"
          }`}
        >
          <PanelRight className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* State banners */}
      {(paused || stale) && (
        <div className="absolute left-1/2 top-[88px] z-20 -translate-x-1/2">
          <div
            className="flex items-center gap-3 rounded-[8px] border bg-white py-1.5 pl-3 pr-1.5 text-[12.5px] shadow-[0_10px_30px_rgba(40,30,15,0.10)]"
            style={{ borderColor: paused ? "#F3DFB0" : "#F2C9C3" }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: paused ? SEMANTIC.wait : SEMANTIC.fail }} />
            <span className="text-[#3F3B35]">{paused ? "实时更新已暂停，画面停在当前帧" : "Watchdog 已 48 秒未收到心跳回执"}</span>
            <button
              type="button"
              onClick={() => (paused ? togglePause() : selectVariant("normal"))}
              className="h-7 cursor-pointer rounded-[6px] bg-[#17181A] px-2.5 text-[12px] font-medium text-white transition-colors duration-200 hover:bg-[#2A2C30]"
            >
              {paused ? "继续接收" : "重置心跳"}
            </button>
          </div>
        </div>
      )}

      {/* Empty state */}
      {empty && (
        <div className="pointer-events-none absolute inset-x-0 top-[34%] z-20 flex justify-center">
          <div className="pointer-events-auto w-[340px] rounded-[8px] border border-black/[0.07] bg-white px-6 py-5 text-center shadow-[0_24px_60px_rgba(40,30,15,0.12)]">
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-[8px] bg-[#F6EDE1]">
              <Package className="h-5 w-5 text-[#B98B5A]" />
            </div>
            <h2 className="mt-3 text-[15px] font-semibold">当前没有进行中的任务</h2>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-[#8A857D]">Router 正在监听收件入口。投递一个任务，看看它如何被分拣、派送和拆箱。</p>
            <button
              type="button"
              onClick={() => dispatch()}
              className="mt-4 inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[7px] bg-[#17181A] px-3 text-[12.5px] font-medium text-white transition-colors duration-200 hover:bg-[#2A2C30]"
            >
              投递示例任务
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Pipeline */}
      <div className="absolute bottom-6 left-7 z-20 rounded-[8px] border border-black/[0.07] bg-white px-4 pb-3.5 pt-3 shadow-[0_12px_36px_rgba(40,30,15,0.08)]">
        <div className="mb-3 flex items-center justify-between">
          <Overline className="text-[#6B655C]">Pipeline</Overline>
          <span className="font-mono text-[10px] text-[#A39D93]">parcel lifecycle · live</span>
        </div>
        <div className="flex items-stretch">
          {PIPELINE.map((s, i) => (
            <React.Fragment key={s.key}>
              <div className="w-[84px]">
                <div className="flex items-center gap-1.5 font-mono text-[10px] text-[#A39D93]">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.color }} />
                  {s.no}
                </div>
                <div className="mt-1.5 text-[24px] font-semibold leading-none tabular-nums text-[#17181A]">
                  {String((stats?.[s.key] as number | undefined) ?? 0).padStart(2, "0")}
                </div>
                <div className="mt-1.5 text-[12px] text-[#3F3B35]">{s.cn}</div>
                <div className="font-mono text-[10px] text-[#A39D93]">{s.en}</div>
              </div>
              {i < PIPELINE.length - 1 && (
                <div className="mx-2 flex items-center">
                  <ArrowRight className="h-3 w-3 text-[#D3CCC0]" />
                </div>
              )}
            </React.Fragment>
          ))}
        </div>
      </div>

      {/* Metrics */}
      <div
        className={`absolute bottom-6 z-20 w-[300px] rounded-[8px] border border-black/[0.07] bg-white px-4 pb-3.5 pt-3 shadow-[0_12px_36px_rgba(40,30,15,0.08)] transition-[right,opacity] duration-300 @max-[900px]:hidden ${
          inspectorOpen ? "@max-[1320px]:pointer-events-none @max-[1320px]:opacity-0" : ""
        }`}
        style={{ right: inspectorOpen ? 24 + 360 + 16 : 24 }}
      >
        <div className="flex items-start justify-between">
          <div>
            <Overline className="text-[#6B655C]">今日交付</Overline>
            <div className="mt-1.5 text-[28px] font-semibold leading-none tabular-nums">{stats?.delivered ?? 0}</div>
          </div>
          <Sparkline values={history} color={SEMANTIC.ok} />
        </div>
        <div className="mt-3 grid grid-cols-3 border-t border-black/[0.06] pt-2.5">
          <div>
            <div className="text-[11px] text-[#9A9389]">运行中</div>
            <div className="mt-0.5 font-mono text-[13px] font-semibold">
              {String(running).padStart(2, "0")}
              <span className="text-[#A39D93]">/05</span>
            </div>
          </div>
          <div>
            <div className="text-[11px] text-[#9A9389]">在途包裹</div>
            <div className="mt-0.5 font-mono text-[13px] font-semibold">{String(inFlight).padStart(2, "0")}</div>
          </div>
          <div>
            <div className="text-[11px] text-[#9A9389]">心跳</div>
            <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[13px] font-semibold" style={{ color: stale ? SEMANTIC.fail : undefined }}>
              <span className={`h-1.5 w-1.5 rounded-full ${stale ? "rt-pulse" : ""}`} style={{ background: stale ? SEMANTIC.fail : SEMANTIC.ok }} />
              {stale ? "48s" : `${(stats?.lastBeatAgo ?? 0).toFixed(1)}s`}
            </div>
          </div>
        </div>
      </div>

      {/* Inspector */}
      <aside
        className={`absolute bottom-6 right-6 top-[78px] z-30 flex w-[360px] flex-col overflow-hidden rounded-[8px] border border-black/[0.07] bg-white shadow-[0_28px_70px_rgba(40,30,15,0.16)] transition-[transform,opacity] duration-300 ease-out ${
          inspectorOpen ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-[calc(100%+32px)] opacity-0"
        }`}
        aria-hidden={!inspectorOpen}
      >
        <InspectorHeader selection={selection} workers={workers} workerIndex={workerIndex} stale={stale} onClose={() => setSelection(null)} />
        {workerIndex >= 0 && (
          <WorkerInspector
            key={workers[workerIndex].id}
            worker={workers[workerIndex]}
            index={workerIndex}
            activity={stats?.workerActivity[workerIndex] ?? "idle"}
            queue={stats?.workerQueue[workerIndex] ?? 0}
            paused={paused}
            onDispatch={() => dispatch(workerIndex)}
          />
        )}
        {selection === "router" && <RouterInspector workers={workers} stats={stats} />}
        {selection === "watchdog" && <WatchdogInspector workers={workers} stale={stale} stats={stats} />}
      </aside>
    </div>
  )
}

function InspectorHeader({
  selection,
  workers,
  workerIndex,
  stale,
  onClose,
}: {
  selection: WorldSelection
  workers: WorkerRuntimeItem[]
  workerIndex: number
  stale: boolean
  onClose: () => void
}) {
  let mark = "RT"
  let accent = SEMANTIC.route
  let title = "Router"
  let subtitle = "中央分拣 · pi.router.v2"
  let badge: React.ReactNode = <StatusBadge status="Running" />
  if (workerIndex >= 0) {
    const w = workers[workerIndex]
    const spec = STATIONS[workerIndex]
    mark = spec.label.slice(0, 2).toUpperCase()
    accent = spec.accent
    title = w.name
    subtitle = `${spec.cnRole} · 工坊 ${String(workerIndex + 1).padStart(2, "0")}`
    badge = <StatusBadge status={w.status} />
  } else if (selection === "watchdog") {
    mark = "WD"
    accent = stale ? SEMANTIC.fail : SEMANTIC.ok
    title = "Watchdog"
    subtitle = "健康巡检 · 心跳与回执"
    badge = <StatusBadge status={stale ? "Failed" : "Running"} />
  }
  return (
    <div className="flex shrink-0 items-start justify-between gap-3 px-5 pb-3 pt-4">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[7px] font-mono text-[11px] font-semibold text-white" style={{ background: accent }}>
          {mark}
        </div>
        <div className="min-w-0">
          <div className="truncate font-mono text-[14.5px] font-semibold text-[#17181A]">{title}</div>
          <div className="truncate text-[12px] text-[#8A857D]">{subtitle}</div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {badge}
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭详情"
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[6px] text-[#9A9389] transition-colors duration-200 hover:bg-[#F4F1EC] hover:text-[#17181A]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
