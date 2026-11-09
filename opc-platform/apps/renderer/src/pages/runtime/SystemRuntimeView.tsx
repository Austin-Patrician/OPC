import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
} from 'lucide-react';
import { INITIAL_WORKERS, PROTOTYPE_VARIANTS } from '../../data/runtimeData';
import type {
  RuntimePrototypeVariant,
  WorkerRuntimeItem,
  WorkerStatus,
} from '../../data/runtimeData';
import { RuntimeWorld } from './world/RuntimeWorld';
import type { WorldSelection } from './world/RuntimeWorld';
import { RuntimeSim } from './world/runtimeSim';
import type { SimStats, WorkerActivity } from './world/runtimeSim';
import { LabelBridge } from './world/labelBridge';
import {
  SEMANTIC,
  STATIONS,
  setRuntimeStations,
  stationKindForTemplate,
  statusColor,
} from './world/worldConfig';
import { useTranslation } from 'react-i18next';
import type { RuntimeObservatorySnapshot } from '@opc/shared/ipc';
import type { TaskTrace } from '@opc/shared/domain';
import { COMPLETED_WORKER_RETENTION_MS, runtimeSceneWorkers, taskBelongsToWorker, workerTasks } from './runtimeWorkerVisibility';

/* -------------------------------------------------------------------------- */
/* Small UI atoms                                                             */
/* -------------------------------------------------------------------------- */

const STATUS_META: Record<
  WorkerStatus,
  { bg: string; text: string; border: string }
> = {
  Running: {
    bg: 'bg-[#ECF7F0]',
    text: 'text-[#157A45]',
    border: 'border-[#C6E8D3]',
  },
  Waiting: {
    bg: 'bg-[#FDF6E7]',
    text: 'text-[#A26C0B]',
    border: 'border-[#F3DFB0]',
  },
  Completed: {
    bg: 'bg-[#ECF7F0]',
    text: 'text-[#157A45]',
    border: 'border-[#C6E8D3]',
  },
  Idle: {
    bg: 'bg-[#F3F1EE]',
    text: 'text-[#6B655C]',
    border: 'border-[#E3DED6]',
  },
  Failed: {
    bg: 'bg-[#FCEDEB]',
    text: 'text-[#B33326]',
    border: 'border-[#F2C9C3]',
  },
};

const ACTIVITY_META: Record<WorkerActivity, { cn: string; color: string }> = {
  idle: { cn: 'runtime.activity.idle', color: SEMANTIC.idle },
  incoming: { cn: 'runtime.activity.incoming', color: SEMANTIC.route },
  holding: { cn: 'runtime.activity.holding', color: SEMANTIC.wait },
  unboxing: { cn: 'runtime.activity.unboxing', color: '#C08A52' },
  working: { cn: 'runtime.activity.working', color: SEMANTIC.ok },
  completed: { cn: 'runtime.activity.completed', color: SEMANTIC.okSoft },
  fault: { cn: 'runtime.activity.fault', color: SEMANTIC.fail },
};

const STAGE_LABEL_KEYS: Record<string, string> = {
  'Received task': 'runtime.stage.received',
  'Loading context': 'runtime.stage.loading',
  'Calling search tool': 'runtime.stage.calling',
  'Synthesizing report': 'runtime.stage.synthesizing',
};

const Overline: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className = '',
}) => (
  <div className={`font-mono text-[10px] uppercase tracking-[0.16em] text-[#9A9389] ${className}`}>
    {children}
  </div>
);

const StatusBadge: React.FC<{ status: WorkerStatus }> = ({ status }) => {
  const { t } = useTranslation();
  const m = STATUS_META[status];
  const label = t(
    status === 'Running'
      ? 'runtime.status.live'
      : status === 'Waiting'
        ? 'runtime.status.waiting'
        : status === 'Completed'
          ? 'runtime.status.completed'
        : status === 'Idle'
          ? 'runtime.status.standby'
          : 'runtime.status.failed',
  );
  return (
    <span
      className={`inline-flex h-[22px] items-center gap-1.5 rounded-[5px] border px-2 font-mono text-[10.5px] font-semibold ${m.bg} ${m.text} ${m.border}`}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: statusColor(status) }} />
      {label}
    </span>
  );
};

const Sparkline: React.FC<{ values: number[]; color: string }> = ({ values, color }) => {
  const w = 132;
  const h = 28;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i): [number, number] => [
    (i / Math.max(1, values.length - 1)) * w,
    h - 3 - (v / max) * (h - 8),
  ]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${w},${h} L0,${h} Z`;
  const last = pts[pts.length - 1];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible">
      <path d={area} fill={color} opacity={0.08} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {last && <circle cx={last[0]} cy={last[1]} r={2.6} fill={color} />}
    </svg>
  );
};

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
  labels: LabelBridge;
  statuses: WorkerStatus[];
  selection: WorldSelection;
  paused: boolean;
  empty: boolean;
  stale: boolean;
  onSelect: (s: WorldSelection) => void;
  onIngress: () => void;
}) {
  const { t } = useTranslation();
  const items = [
    {
      id: 'ingress',
      title: 'Ingress',
      sub: t('runtime.node.ingress'),
      color: empty ? SEMANTIC.idle : SEMANTIC.route,
      pulse: false,
      align: 'center',
      onClick: onIngress,
    },
    {
      id: 'router',
      title: 'Router',
      sub: t('runtime.node.router'),
      color: empty ? SEMANTIC.idle : SEMANTIC.route,
      pulse: !empty && !paused,
      align: 'center',
      onClick: () => onSelect('router'),
    },
    ...STATIONS.map((s, i) => ({
      id: s.workerId,
      title: s.label === '小助手' ? t(`runtime.station.${s.kind}`) : s.label,
      sub: s.label === '小助手' ? s.label : t(`runtime.station.${s.kind}`),
      color: statusColor(statuses[i]!),
      pulse: statuses[i] === 'Running' && !paused,
      align: 'start',
      onClick: () => onSelect(s.workerId),
    })),
    {
      id: 'watchdog',
      title: 'Watchdog',
      sub: stale ? t('runtime.node.watchdogStale') : t('runtime.node.watchdog'),
      color: stale ? SEMANTIC.fail : SEMANTIC.ok,
      pulse: !paused,
      align: 'center',
      onClick: () => onSelect('watchdog'),
    },
  ];
  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      {items.map((it) => {
        const selected = selection === it.id;
        return (
          <button
            key={it.id}
            ref={labels.bind(it.id)}
            data-align={it.align}
            type="button"
            onClick={it.onClick}
            style={{ opacity: 0 }}
            className={`pointer-events-auto absolute left-0 top-0 flex h-[26px] cursor-pointer select-none items-center gap-2 whitespace-nowrap rounded-full border px-2.5 text-[11px] shadow-[0_6px_18px_rgba(40,30,15,0.10)] transition-[opacity,background-color,border-color,color] duration-200 will-change-transform ${
              selected
                ? 'border-[#17181A] bg-[#17181A] text-white'
                : 'border-black/[0.07] bg-white text-[#2A2E35] hover:border-black/20'
            }`}
          >
            <span className="relative flex h-1.5 w-1.5">
              {it.pulse && (
                <span
                  className="absolute inset-0 rounded-full rt-ping"
                  style={{ background: it.color }}
                />
              )}
              <span
                className="relative h-1.5 w-1.5 rounded-full"
                style={{ background: it.color }}
              />
            </span>
            <span className="font-mono font-semibold tracking-tight">{it.title}</span>
            <span className={selected ? 'text-white/55' : 'text-[#8A857D]'}>{it.sub}</span>
          </button>
        );
      })}
      <div
        ref={labels.bind('tag')}
        style={{ opacity: 0 }}
        className="absolute left-0 top-0 flex items-center gap-1.5 whitespace-nowrap rounded-[6px] border border-black/[0.08] bg-white/95 px-2 py-[3px] font-mono text-[10.5px] text-[#2A2E35] shadow-[0_4px_14px_rgba(30,25,15,0.12)] transition-opacity duration-300 will-change-transform"
      >
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: SEMANTIC.route }} />
        <span />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Inspector sections                                                         */
/* -------------------------------------------------------------------------- */

const StageNode: React.FC<{ status: string }> = ({ status }) => {
  const color =
    status === 'done'
      ? SEMANTIC.ok
      : status === 'running'
        ? SEMANTIC.ok
        : status === 'waiting'
          ? SEMANTIC.wait
          : status === 'failed'
            ? SEMANTIC.fail
            : '#C9C3B9';
  if (status === 'done')
    return (
      <span
        className="flex h-[15px] w-[15px] items-center justify-center rounded-full"
        style={{ background: color }}
      >
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
          <path
            d="M1.5 4.2L3.2 5.8L6.5 2.4"
            stroke="white"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  return (
    <span
      className="relative flex h-[15px] w-[15px] items-center justify-center rounded-full border-[1.5px] bg-white"
      style={{ borderColor: color }}
    >
      {status !== 'idle' && (
        <span
          className={`h-[5px] w-[5px] rounded-full ${status === 'running' ? 'rt-pulse' : ''}`}
          style={{ background: color }}
        />
      )}
    </span>
  );
};

function WorkerInspector({
  worker,
  accent,
  activity,
  queue,
  paused,
  liveMode,
  onDispatch,
}: {
  worker: WorkerRuntimeItem;
  accent: string;
  activity: WorkerActivity;
  queue: number;
  paused: boolean;
  liveMode: boolean;
  onDispatch: () => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'trace' | 'messages' | 'watchdog'>('trace');
  const act = ACTIVITY_META[activity];
  const busy = activity === 'unboxing' || activity === 'working';

  return (
    <>
      <div className="border-b border-black/[0.06] px-5 pb-4 pt-1">
        <Overline>{t('runtime.inspector.currentTask')}</Overline>
        <p className="mt-1.5 text-[15px] font-medium leading-[1.45] text-[#17181A]">
          {t(worker.currentTaskKey ?? `runtime.workerData.${worker.id}.task`, {
            defaultValue: worker.currentTask,
          })}
        </p>
        <div className="mt-3 flex items-center gap-2.5 rounded-[7px] border border-black/[0.06] bg-[#FAF8F5] px-3 py-2">
          <span className="relative flex h-2 w-2">
            {busy && !paused && (
              <span
                className="absolute inset-0 rounded-full rt-ping"
                style={{ background: act.color }}
              />
            )}
            <span className="relative h-2 w-2 rounded-full" style={{ background: act.color }} />
          </span>
          <span className="flex-1 text-[12.5px] text-[#3F3B35]">{t(act.cn)}</span>
          <span className="font-mono text-[11px] text-[#8A857D]">
            {t('runtime.inspector.pipeline', { count: queue })}
          </span>
        </div>
        {busy && (
          <div className="mt-2 h-[3px] overflow-hidden rounded-full bg-[#EDE8E0]">
            <div
              className="h-full w-1/3 rounded-full rt-progress-bar"
              style={{ background: act.color, animationPlayState: paused ? 'paused' : 'running' }}
            />
          </div>
        )}
      </div>

      <dl className="grid grid-cols-2 border-b border-black/[0.06]">
        {[
          [t('runtime.inspector.model'), worker.model],
          [t('runtime.inspector.thread'), worker.thread],
          [t('runtime.inspector.started'), worker.startedAgo],
          [t('runtime.inspector.tokens'), worker.tokens],
        ].map(([k, v], i) => (
          <div
            key={k}
            className={`px-5 py-3 ${i % 2 === 0 ? 'border-r' : ''} ${i < 2 ? 'border-b' : ''} border-black/[0.06]`}
          >
            <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#9A9389]">
              {k}
            </dt>
            <dd className="mt-1 truncate font-mono text-[12.5px] text-[#17181A]">{v}</dd>
          </div>
        ))}
      </dl>

      <div className="flex h-11 shrink-0 items-end gap-5 border-b border-black/[0.06] px-5">
        {(
          [
            ['trace', 'runtime.inspector.trace'],
            ['messages', 'runtime.inspector.messages'],
            ['watchdog', 'runtime.inspector.watchdog'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`relative cursor-pointer pb-2.5 font-mono text-[12px] transition-colors duration-200 ${
              tab === id ? 'font-semibold text-[#17181A]' : 'text-[#9A9389] hover:text-[#3F3B35]'
            }`}
          >
            {t(label)}
            {id === 'watchdog' && worker.watchdog.ttlGuard !== 'PASS' && (
              <span
                className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle"
                style={{
                  background:
                    worker.watchdog.ttlGuard === 'EXPIRED' ? SEMANTIC.fail : SEMANTIC.wait,
                }}
              />
            )}
            <span
              className={`absolute inset-x-0 -bottom-px h-[2px] rounded-full bg-[#17181A] transition-opacity duration-200 ${tab === id ? 'opacity-100' : 'opacity-0'}`}
            />
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {tab === 'trace' && (
          <div className="space-y-5">
            <section>
              <div className="mb-3 flex items-baseline justify-between">
                <h3 className="text-[12.5px] font-semibold text-[#17181A]">
                  {t('runtime.inspector.stages')}
                </h3>
                <span className="font-mono text-[10.5px] text-[#9A9389]">
                  {worker.stages.filter((s) => s.status === 'done').length}/{worker.stages.length}
                </span>
              </div>
              <ol>
                {worker.stages.map((st, i) => (
                  <li key={st.id} className="relative flex gap-3 pb-3.5 last:pb-0">
                    {i < worker.stages.length - 1 && (
                      <span
                        className="absolute left-[7px] top-[17px] bottom-0 w-px"
                        style={{ background: st.status === 'done' ? '#BFE3CC' : '#E7E1D8' }}
                      />
                    )}
                    <span className="relative z-10 mt-[1px]">
                      <StageNode status={st.status} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span
                          className={`font-mono text-[12px] ${st.status === 'idle' ? 'text-[#A39D93]' : 'font-medium text-[#17181A]'}`}
                        >
                          {t(STAGE_LABEL_KEYS[st.label] ?? st.label)}
                        </span>
                        <span className="font-mono text-[10.5px] text-[#A39D93]">
                          {st.timestamp}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[11.5px] leading-snug text-[#8A857D]">
                        {t(`runtime.workerData.${worker.id}.stages.${st.id}`, {
                          defaultValue: st.sublabel,
                        })}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </section>

            <section>
              <div className="mb-2.5 flex items-baseline justify-between">
                <h3 className="font-mono text-[12.5px] font-semibold text-[#17181A]">
                  {t('runtime.inspector.toolTrace')}
                </h3>
                <span className="font-mono text-[10.5px] text-[#9A9389]">
                  {t('runtime.inspector.calls', { count: worker.traces.length })}
                </span>
              </div>
              {worker.traces.length === 0 ? (
                <div className="rounded-[7px] border border-dashed border-black/[0.1] px-3 py-5 text-center text-[12px] text-[#9A9389]">
                  {t('runtime.inspector.noTools')}
                </div>
              ) : (
                <div className="overflow-hidden rounded-[7px] border border-black/[0.07]">
                  {worker.traces.map((tr) => (
                    <div
                      key={tr.id}
                      className="flex items-start gap-2.5 border-t border-black/[0.06] px-3 py-2.5 first:border-t-0"
                    >
                      <span className="mt-[1px]">
                        {tr.status === 'success' && (
                          <CheckCircle2 className="h-3.5 w-3.5" style={{ color: SEMANTIC.ok }} />
                        )}
                        {tr.status === 'running' && (
                          <RefreshCw
                            className="h-3.5 w-3.5 animate-spin"
                            style={{
                              color: SEMANTIC.route,
                              animationPlayState: paused ? 'paused' : 'running',
                            }}
                          />
                        )}
                        {tr.status === 'waiting' && (
                          <Clock className="h-3.5 w-3.5" style={{ color: SEMANTIC.wait }} />
                        )}
                        {tr.status === 'failed' && (
                          <AlertCircle className="h-3.5 w-3.5" style={{ color: SEMANTIC.fail }} />
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="font-mono text-[12px] font-semibold text-[#17181A]">
                            {tr.toolName}
                          </span>
                          <span className="font-mono text-[11px] tabular-nums text-[#3F3B35]">
                            {tr.duration}
                          </span>
                        </div>
                        <div className="mt-0.5 flex items-baseline justify-between gap-2">
                          <span className="truncate font-mono text-[10.5px] text-[#9A9389]">
                            {tr.argsDigest}
                          </span>
                          <span className="shrink-0 font-mono text-[10.5px] text-[#9A9389]">
                            {tr.tokens} tok
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        {tab === 'messages' && (
          worker.messages.length === 0 ? (
            <div className="rounded-[7px] border border-dashed border-black/[0.1] px-3 py-5 text-center text-[12px] leading-relaxed text-[#9A9389]">
              {liveMode ? t('runtime.inspector.messagesUnavailable') : t('runtime.inspector.noMessages')}
            </div>
          ) : <div className="space-y-2.5">
            {worker.messages.map((m) => (
              <div key={m.id} className="rounded-[7px] border border-black/[0.07] px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span
                      className="rounded-[4px] px-1.5 py-[1px] font-mono text-[9.5px] font-semibold"
                      style={{
                        background: m.direction === 'in' ? '#EAF0FE' : '#ECF7F0',
                        color: m.direction === 'in' ? SEMANTIC.route : SEMANTIC.ok,
                      }}
                    >
                      {m.direction === 'in' ? 'IN' : 'OUT'}
                    </span>
                    <span className="font-mono text-[12px] font-semibold text-[#17181A]">
                      {m.type}
                    </span>
                  </div>
                  <span className="font-mono text-[10.5px] text-[#A39D93]">{m.timestamp}</span>
                </div>
                <p className="mt-1.5 text-[12px] text-[#3F3B35]">
                  {t(`runtime.workerData.${worker.id}.messages.${m.id}`, {
                    defaultValue: m.summary,
                  })}
                </p>
                <code className="mt-2 block truncate rounded-[5px] bg-[#F6F3EE] px-2 py-1 font-mono text-[10.5px] text-[#6B655C]">
                  {m.payloadDigest}
                </code>
              </div>
            ))}
          </div>
        )}

        {tab === 'watchdog' && <WorkerWatchdog worker={worker} />}
      </div>

      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-black/[0.06] px-5 py-3">
        <span className="flex items-center gap-1.5 text-[11px] text-[#9A9389]">
          <ShieldCheck className="h-3.5 w-3.5" style={{ color: SEMANTIC.ok }} />
          {t('runtime.inspector.structuredOnly')}
        </span>
        {!liveMode && (
          <button
            type="button"
            onClick={onDispatch}
            className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-[6px] border border-black/[0.08] px-2.5 text-[11.5px] font-medium text-[#17181A] transition-colors duration-200 hover:bg-[#F6F3EE]"
            style={{ boxShadow: `inset 0 -2px 0 ${accent}` }}
          >
            {t('runtime.inspector.dispatch')}
            <ArrowRight className="h-3 w-3" />
          </button>
        )}
      </div>
    </>
  );
}

function WorkerWatchdog({ worker }: { worker: WorkerRuntimeItem }) {
  const { t } = useTranslation();
  const wd = worker.watchdog;
  const tone =
    wd.ttlGuard === 'EXPIRED'
      ? SEMANTIC.fail
      : wd.ttlGuard === 'WARN'
        ? SEMANTIC.wait
        : SEMANTIC.ok;
  return (
    <div className="space-y-3">
      <div
        className="flex items-start gap-2.5 rounded-[7px] border px-3 py-2.5"
        style={{ borderColor: `${tone}40`, background: `${tone}0D` }}
      >
        {wd.ttlGuard === 'EXPIRED' ? (
          <ShieldAlert className="mt-[1px] h-4 w-4" style={{ color: tone }} />
        ) : (
          <ShieldCheck className="mt-[1px] h-4 w-4" style={{ color: tone }} />
        )}
        <div>
          <div className="text-[12.5px] font-semibold text-[#17181A]">
            {wd.ttlGuard === 'EXPIRED'
              ? t('runtime.inspector.expired')
              : wd.ttlGuard === 'WARN'
                ? t('runtime.inspector.slow')
                : t('runtime.inspector.stable')}
          </div>
          <div className="mt-0.5 font-mono text-[11px] text-[#6B655C]">
            ttl_guard={wd.ttlGuard} · drift {wd.driftMs}
          </div>
        </div>
      </div>
      <dl className="overflow-hidden rounded-[7px] border border-black/[0.07]">
        {[
          [t('runtime.inspector.heartbeatInterval'), wd.heartbeatInterval],
          [t('runtime.inspector.lastAck'), wd.lastAck],
          [t('runtime.inspector.memory'), wd.memoryRss],
          [t('runtime.inspector.budget'), wd.tokenBudget],
        ].map(([k, v]) => (
          <div
            key={k}
            className="flex items-center justify-between border-t border-black/[0.06] px-3 py-2 first:border-t-0"
          >
            <dt className="text-[12px] text-[#8A857D]">{k}</dt>
            <dd className="font-mono text-[12px] text-[#17181A]">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function RouterInspector({
  workers,
  sceneWorkers,
  stats,
  onSelectWorker,
}: {
  workers: WorkerRuntimeItem[];
  sceneWorkers: WorkerRuntimeItem[];
  stats: SimStats | null;
  onSelectWorker: (workerId: string) => void;
}) {
  const { t } = useTranslation();
  const total = stats?.workerQueue.reduce((a, b) => a + b, 0) ?? 0;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="grid grid-cols-3 border-b border-black/[0.06]">
        {[
          [t('runtime.inspector.sorting'), stats?.sorting ?? 0],
          [t('runtime.inspector.transit'), stats?.transit ?? 0],
          [t('runtime.inspector.queued'), stats?.ingress ?? 0],
        ].map(([k, v], i) => (
          <div key={k} className={`px-5 py-4 ${i < 2 ? 'border-r border-black/[0.06]' : ''}`}>
            <Overline>{k}</Overline>
            <div className="mt-1.5 text-[24px] font-semibold leading-none tabular-nums text-[#17181A]">
              {String(v).padStart(2, '0')}
            </div>
          </div>
        ))}
      </div>
      <section className="px-5 py-4">
        <div className="mb-3 flex items-baseline justify-between">
          <h3 className="text-[12.5px] font-semibold text-[#17181A]">
            {t('runtime.inspector.routingTable')}
          </h3>
          <span className="font-mono text-[10.5px] text-[#9A9389]">
            {t('runtime.inspector.routingHint', { count: workers.length })}
          </span>
        </div>
        <div className="space-y-2.5">
          {workers.map((w) => {
            const sceneIndex = sceneWorkers.findIndex((sceneWorker) => sceneWorker.id === w.id);
            const queue = sceneIndex >= 0 ? (stats?.workerQueue[sceneIndex] ?? 0) : 0;
            const accent = sceneIndex >= 0 ? STATIONS[sceneIndex]?.accent : statusColor(w.status);
            const share = total > 0 ? queue / total : 0;
            return (
              <button
                key={w.id}
                type="button"
                onClick={() => onSelectWorker(w.id)}
                className="flex w-full cursor-pointer items-center gap-3 text-left hover:bg-[#FAF8F5]"
              >
                <span
                  className="h-6 w-1 rounded-full"
                  style={{ background: accent }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[12px] font-medium text-[#17181A]">
                      {w.name}
                    </span>
                    <span className="flex items-center gap-1.5 font-mono text-[10.5px] text-[#8A857D]">
                      <span
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ background: statusColor(w.status) }}
                      />
                      {t('runtime.inspector.queueItems', { count: queue })}
                    </span>
                  </div>
                  <div className="mt-1.5 h-[3px] overflow-hidden rounded-full bg-[#EFEAE2]">
                    <div
                      className="h-full rounded-full transition-[width] duration-500"
                      style={{ width: `${Math.round(share * 100)}%`, background: SEMANTIC.route }}
                    />
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </section>
      <section className="border-t border-black/[0.06] px-5 py-4">
        <h3 className="mb-2 text-[12.5px] font-semibold text-[#17181A]">
          {t('runtime.inspector.routingRules')}
        </h3>
        <ol className="list-decimal space-y-1.5 pl-4 text-[11px] leading-relaxed text-[#6B655C]">
          <li>{t('runtime.inspector.routingStepFilter')}</li>
          <li>{t('runtime.inspector.routingStepMatch')}</li>
          <li>{t('runtime.inspector.routingStepFallback')}</li>
        </ol>
      </section>
    </div>
  );
}

function WatchdogInspector({
  workers,
  stale,
  heartbeatAgeSeconds,
  stats,
  onSelectWorker,
}: {
  workers: WorkerRuntimeItem[];
  stale: boolean;
  heartbeatAgeSeconds: number | null;
  stats: SimStats | null;
  onSelectWorker: (workerId: string) => void;
}) {
  const { t } = useTranslation();
  const tone = stale ? SEMANTIC.fail : SEMANTIC.ok;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="border-b border-black/[0.06] px-5 py-4">
        <Overline>{t('runtime.inspector.heartbeat')}</Overline>
        <div className="mt-2 flex items-end gap-3">
          <span
            className="text-[30px] font-semibold leading-none tabular-nums"
            style={{ color: stale ? tone : '#17181A' }}
          >
            {heartbeatAgeSeconds === null ? '—' : `${heartbeatAgeSeconds.toFixed(1)}s`}
          </span>
          <span className="pb-1 text-[12px] text-[#8A857D]">
            {heartbeatAgeSeconds === null
              ? t('runtime.inspector.heartbeatUnavailable')
              : stale
                ? t('runtime.inspector.heartbeatMissing')
                : t('runtime.inspector.heartbeatAgo')}
          </span>
        </div>
        <div className="mt-3 flex items-center gap-2 font-mono text-[11px] text-[#6B655C]">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: tone }} />
          {t('runtime.inspector.watchdogStats', {
            interval: '1200ms',
            reports: stats?.delivered ?? 0,
            faults: stats?.faults ?? 0,
          })}
        </div>
      </div>
      <section className="px-5 py-4">
        <h3 className="mb-3 text-[12.5px] font-semibold text-[#17181A]">
          {t('runtime.inspector.workerAcks')}
        </h3>
        <div className="overflow-hidden rounded-[7px] border border-black/[0.07]">
          {workers.map((w) => {
            const g = w.watchdog.ttlGuard;
            const c = g === 'EXPIRED' ? SEMANTIC.fail : g === 'WARN' ? SEMANTIC.wait : SEMANTIC.ok;
            return (
              <button
                key={w.id}
                type="button"
                onClick={() => onSelectWorker(w.id)}
                className="flex w-full cursor-pointer items-center gap-3 border-t border-black/[0.06] px-3 py-2.5 text-left first:border-t-0 hover:bg-[#FAF8F5]"
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: c }} />
                <span className="flex-1 font-mono text-[12px] text-[#17181A]">{w.name}</span>
                <span className="font-mono text-[11px] text-[#8A857D]">{w.watchdog.lastAck}</span>
                <span
                  className="w-[58px] text-right font-mono text-[10px] font-semibold"
                  style={{ color: c }}
                >
                  {g}
                </span>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

const PIPELINE: { key: keyof SimStats; no: string; labelKey: string; color: string }[] = [
  { key: 'ingress', no: '01', labelKey: 'runtime.pipeline.ingress', color: SEMANTIC.route },
  { key: 'sorting', no: '02', labelKey: 'runtime.pipeline.sorting', color: SEMANTIC.route },
  { key: 'transit', no: '03', labelKey: 'runtime.pipeline.transit', color: SEMANTIC.route },
  { key: 'unboxing', no: '04', labelKey: 'runtime.pipeline.unboxing', color: '#C08A52' },
  { key: 'reports', no: '05', labelKey: 'runtime.pipeline.reports', color: SEMANTIC.ok },
];

// The main process writes a heartbeat every 15s; match Watchdog's 90s stale
// policy instead of flagging the normal interval as a timeout.
const HEARTBEAT_STALE_AFTER_SECONDS = 90;

function formatAge(at?: number): string {
  if (!at) return '--:--';
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

function traceToRuntimeTrace(trace: TaskTrace): WorkerRuntimeItem['traces'][number] {
  return {
    id: trace.id,
    toolName: trace.name,
    argsDigest: trace.argsDigest,
    status: trace.ok === false ? 'failed' : trace.ok === null ? 'running' : 'success',
    duration: trace.ms === undefined ? '--' : `${trace.ms}ms`,
    tokens: formatTokens(trace.tokens ?? 0),
    targetNodeId: trace.kind === 'tool' ? 'tool' : trace.kind === 'error' ? 'watchdog' : 'report',
  };
}

function observatoryWorkers(snapshot: RuntimeObservatorySnapshot): WorkerRuntimeItem[] {
  const active = [...snapshot.workers];
  const slots = active.map((worker, index) => {
    const base = INITIAL_WORKERS[index % INITIAL_WORKERS.length]!;
    const task = worker
      ? workerTasks(worker, snapshot.tasks)
          .filter((item) => ['running', 'review', 'open', 'failed'].includes(item.status) || (['accepted', 'delivered', 'rejected', 'cancelled'].includes(item.status) && Date.now() - item.updatedAt <= COMPLETED_WORKER_RETENTION_MS))
          .sort((a, b) => {
            const priority = (status: string) => status === 'running' ? 0 : status === 'review' ? 1 : status === 'open' ? 2 : 3;
            return priority(a.status) - priority(b.status) || b.updatedAt - a.updatedAt;
          })[0]
      : undefined;
    const traces = task ? (snapshot.traces[task.id] ?? []) : [];
    const incident = worker
      ? snapshot.incidents.find((item) => item.subjectId === worker.id && item.state !== 'resolved')
      : undefined;
    const status: WorkerStatus = incident
      ? 'Failed'
      : task?.status === 'failed'
        ? 'Failed'
      : task?.status === 'running'
        ? 'Running'
      : worker?.status === 'running'
        ? 'Running'
        : task?.status === 'review' || task?.status === 'open'
          ? 'Waiting'
          : task && ['accepted', 'delivered', 'rejected', 'cancelled'].includes(task.status)
            ? 'Completed'
          : 'Idle';
    const model = worker
      ? [worker.modelProvider, worker.modelId].filter(Boolean).join('/') || 'default'
      : '—';
    return {
      ...base,
      id: worker?.id ?? `worker-slot-${index + 1}`,
      name: worker?.name ?? '—',
      template: worker?.template,
      shortCode: worker ? `W-${String(index + 1).padStart(2, '0')}` : '—',
      status,
      currentTask: task?.title ?? '—',
      currentTaskKey: undefined,
      model,
      thread: task?.threadId ?? worker?.threadId ?? '—',
      elapsed: formatAge(task?.createdAt),
      startedAgo: task ? `${formatAge(task.createdAt)} ago` : 'idle',
      tokens: formatTokens(worker?.spentTokens ?? 0),
      correlationId: task?.id ?? worker?.id ?? `worker-slot-${index + 1}`,
      connectorLabel: task ? `task · ${task.id}` : 'idle',
      stages: base.stages.map((stage, stageIndex): WorkerRuntimeItem['stages'][number] => ({
        ...stage,
        status: status === 'Failed'
          ? 'failed'
          : status === 'Completed'
            ? 'done'
          : status === 'Idle'
            ? 'idle'
            : stageIndex < Math.min(traces.length, 3)
              ? 'done'
              : stageIndex === Math.min(traces.length, 3)
                ? 'running'
                : 'waiting',
      })),
      traces: traces.map(traceToRuntimeTrace),
      messages: [],
      watchdog: {
        ...base.watchdog,
        lastAck: snapshot.heartbeat ? `${Math.max(0, (Date.now() - snapshot.heartbeat.at) / 1000).toFixed(1)}s ago` : '—',
        ttlGuard: (incident ? 'EXPIRED' : 'PASS') as WorkerRuntimeItem['watchdog']['ttlGuard'],
        driftMs: incident ? 'unknown' : '+0ms',
        tokenBudget: formatTokens(worker?.spentTokens ?? 0),
      },
    };
  });
  return slots;
}

export const SystemRuntimeView: React.FC = () => {
  const { t } = useTranslation();
  const [observatory, setObservatory] = useState<RuntimeObservatorySnapshot | null>(null);
  const [heartbeatClock, setHeartbeatClock] = useState(() => Date.now());
  const [observatoryError, setObservatoryError] = useState<string | null>(null);
  const [variant, setVariant] = useState<RuntimePrototypeVariant>('normal');
  const [paused, setPaused] = useState(false);
  const [selection, setSelection] = useState<WorldSelection>(null);
  const [stats, setStats] = useState<SimStats | null>(null);
  const [history, setHistory] = useState<number[]>(() =>
    Array.from({ length: 28 }, (_, i) => 2 + Math.round(Math.abs(Math.sin(i * 0.9)) * 3)),
  );
  const [pausedFor, setPausedFor] = useState(0);
  const pausedAt = useRef<number | null>(null);
  const lastDelivered = useRef<number | null>(null);
  const lastSample = useRef(0);
  const pendingSpawn = useRef<number | null | undefined>(undefined);
  const detailCache = useRef(new Map<string, { at: number; traces: RuntimeObservatorySnapshot['traces'] }>());

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let lastRequestAt = 0;
    let queued = false;
    let timerId = 0;
    let lastBusinessSignature = '';
    const bridge = window.opc?.runtime;
    if (!bridge?.observatory) {
      setObservatoryError('runtime observatory bridge unavailable');
      return;
    }
    const refresh = async () => {
      if (inFlight) { queued = true; return; }
      const wait = Math.max(0, 2000 - (Date.now() - lastRequestAt));
      if (wait > 0) {
        if (!timerId) timerId = window.setTimeout(() => { timerId = 0; void refresh(); }, wait);
        return;
      }
      inFlight = true;
      lastRequestAt = Date.now();
      try {
        const next = await bridge.observatory({ mode: 'summary' });
        if (!disposed) {
          const signature = JSON.stringify({ workers: next.workers, tasks: next.tasks.map(({ id, status, updatedAt, workerId, assigneeId }) => [id, status, updatedAt, workerId, assigneeId]), incidents: next.incidents, heartbeat: next.heartbeat });
          if (signature !== lastBusinessSignature) { lastBusinessSignature = signature; setObservatory((current) => ({ ...next, traces: current?.traces ?? {}, actions: current?.actions ?? [], events: current?.events ?? [] })); }
          setObservatoryError(null);
        }
      } catch (error) {
        if (!disposed)
          setObservatoryError(error instanceof Error ? error.message : String(error));
      } finally {
        inFlight = false;
        if (queued && !disposed) { queued = false; void refresh(); }
      }
    };
    void refresh();
    const off = bridge.onChanged?.(() => void refresh());
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      if (timerId) window.clearTimeout(timerId);
      off?.();
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setHeartbeatClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!selection) return;
    const bridge = window.opc?.runtime;
    if (!bridge?.observatory) return;
    const workerId = selection === 'router' || selection === 'watchdog' ? undefined : selection;
    const cacheKey = workerId ?? selection;
    const now = Date.now();
    for (const [key, entry] of detailCache.current) {
      if (now - entry.at > 120_000) detailCache.current.delete(key);
    }
    const cached = detailCache.current.get(cacheKey);
    if (cached) setObservatory((current) => current ? { ...current, traces: cached.traces } : current);
    let disposed = false;
    let inFlight = false;
    let queued = false;
    const refreshDetail = async () => {
      if (inFlight) { queued = true; return; }
      inFlight = true;
      try {
        const detail = await bridge.observatory({ mode: 'detail', workerId });
        if (!disposed) {
          detailCache.current.set(cacheKey, { at: Date.now(), traces: detail.traces });
          setObservatory((current) => current ? { ...current, traces: detail.traces, actions: detail.actions, events: detail.events } : current);
        }
      } catch { /* The summary remains usable if detail retrieval temporarily fails. */ }
      finally {
        inFlight = false;
        if (queued && !disposed) { queued = false; void refreshDetail(); }
      }
    };
    void refreshDetail();
    const off = bridge.onChanged?.(() => void refreshDetail());
    const timer = window.setInterval(() => void refreshDetail(), 2000);
    return () => { disposed = true; window.clearInterval(timer); off?.(); };
  }, [selection]);

  const realWorkers = useMemo(
    () => (observatory ? observatoryWorkers(observatory) : null),
    [observatory],
  );

  const workers = useMemo<WorkerRuntimeItem[]>(() => {
    if (realWorkers) return realWorkers;
    if (variant === 'empty')
      return INITIAL_WORKERS.map((w) => ({
        ...w,
        status: 'Idle' as WorkerStatus,
        currentTask: '待命 · 队列为空',
        currentTaskKey: 'runtime.workerData.emptyTask',
        elapsed: '--:--',
        startedAgo: 'idle',
        tokens: '0.0k',
        stages: w.stages.map((s) => ({ ...s, status: 'idle' as const })),
        traces: [],
      }));
    if (variant === 'stale')
      return INITIAL_WORKERS.map((w) => ({
        ...w,
        watchdog: {
          ...w.watchdog,
          lastAck: '48.2s ago',
          ttlGuard: 'EXPIRED' as const,
          driftMs: '+48200ms',
        },
      }));
    return INITIAL_WORKERS;
  }, [realWorkers, variant]);

  const sceneWorkers = useMemo(() => {
    if (!observatory) return workers;
    const visibleIds = new Set(runtimeSceneWorkers(observatory, heartbeatClock).map((worker) => worker.id));
    return workers.filter((worker) => visibleIds.has(worker.id));
  }, [observatory, workers, heartbeatClock]);

  // A live roster can retire a selected worker while the inspector is open.
  // Clear that selection immediately so the camera and inspector never point at
  // a station that no longer exists.
  useEffect(() => {
    if (selection !== null && selection !== 'router' && selection !== 'watchdog' && !workers.some((worker) => worker.id === selection)) {
      setSelection(null);
    }
  }, [selection, workers]);

  const appliedRoster = useRef('');
  const rosterSignature = sceneWorkers
    .map((worker) => {
      const task = observatory?.tasks.find((item) => taskBelongsToWorker(item, { id: worker.id, threadId: worker.thread === '—' ? null : worker.thread }) && ['running', 'review', 'open'].includes(item.status));
      const kind = task?.isReview ? 'review' : stationKindForTemplate(worker.template);
      return `${worker.id}\u0000${worker.name}\u0000${worker.template ?? ''}\u0000${kind}`;
    })
    .join('\u0001');
  if (appliedRoster.current !== rosterSignature) {
    setRuntimeStations(
      sceneWorkers.map((worker) => ({
        id: worker.id,
        name: worker.name,
        template: worker.template,
        kind: observatory?.tasks.some((task) => taskBelongsToWorker(task, { id: worker.id, threadId: worker.thread === '—' ? null : worker.thread }) && task.isReview && ['running', 'review', 'open'].includes(task.status)) ? 'review' : stationKindForTemplate(worker.template),
        threadId: worker.thread !== '—' ? worker.thread : undefined,
      })),
    );
    appliedRoster.current = rosterSignature;
  }

  const statuses = useMemo(() => sceneWorkers.map((w) => w.status), [sceneWorkers]);

  const [sim] = useState(() => {
    const s = new RuntimeSim();
    s.setState(
      INITIAL_WORKERS.map((w) => w.status),
      'normal',
    );
    s.warmUp(9);
    return s;
  });
  const [labels] = useState(() => new LabelBridge());

  useEffect(() => {
    sim.setState(statuses, variant);
    if (pendingSpawn.current !== undefined) {
      sim.spawn(pendingSpawn.current ?? undefined);
      pendingSpawn.current = undefined;
    }
  }, [sim, statuses, variant]);

  useEffect(() => {
    sim.setLiveMode(Boolean(observatory));
  }, [observatory, sim]);

  useEffect(() => {
    if (paused) pausedAt.current = performance.now();
    else {
      pausedAt.current = null;
      setPausedFor(0);
    }
  }, [paused]);

  const handleStats = useCallback((s: SimStats) => {
    setStats(s);
    if (pausedAt.current !== null)
      setPausedFor(Math.round((performance.now() - pausedAt.current) / 1000));
    const now = performance.now();
    if (now - lastSample.current > 1600) {
      lastSample.current = now;
      const prev = lastDelivered.current;
      lastDelivered.current = s.delivered;
      if (prev !== null && pausedAt.current === null)
        setHistory((h) => [...h.slice(1), Math.max(0, s.delivered - prev) + 1]);
    }
  }, []);

  const dispatch = useCallback(
    (worker?: number) => {
      setPaused(false);
      if (variant === 'empty' || variant === 'paused') {
        pendingSpawn.current = worker ?? null;
        setVariant('normal');
        return;
      }
      sim.spawn(worker);
    },
    [sim, variant],
  );

  const handleSelect = useCallback(
    (next: WorldSelection) => setSelection((cur) => (cur === next ? null : next)),
    [],
  );
  const handleBackground = useCallback(() => setSelection(null), []);
  const handleIngress = useCallback(() => dispatch(), [dispatch]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelection(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const selectVariant = (next: RuntimePrototypeVariant) => {
    setVariant(next);
    setPaused(next === 'paused');
    if (next === 'waiting') setSelection('worker-content');
    else if (next === 'failed') setSelection('worker-review');
    else if (next === 'stale') setSelection('watchdog');
    else if (next === 'empty') setSelection(null);
  };

  const togglePause = () => {
    if (paused) {
      setPaused(false);
      if (variant === 'paused') setVariant('normal');
    } else setPaused(true);
  };

  const serverHeartbeatAge = observatory?.heartbeat
    ? Math.max(0, (heartbeatClock - observatory.heartbeat.at) / 1000)
    : null;
  const stale = observatory
    ? serverHeartbeatAge === null || serverHeartbeatAge > HEARTBEAT_STALE_AFTER_SECONDS
    : variant === 'stale';
  const empty = observatory ? observatory.workers.length === 0 && observatory.tasks.length === 0 : variant === 'empty';
  const workerIndex = workers.findIndex((w) => w.id === selection);
  const sceneWorkerIndex = sceneWorkers.findIndex((w) => w.id === selection);
  const inspectorOpen = selection !== null;
  const running = workers.filter((w) => w.status === 'Running').length;
  const activeTaskCount = observatory
    ? observatory.tasks.filter((task) => ['open', 'running', 'review'].includes(task.status)).length
    : 0;
  const standby = observatory
    ? sceneWorkers.length === 0 && activeTaskCount === 0
    : variant === 'empty';
  const liveStats = useMemo<SimStats | null>(() => {
    if (!observatory) return stats;
    const tasks = observatory.tasks;
    const runningTasks = tasks.filter((task) => task.status === 'running').length;
    const queuedTasks = tasks.filter((task) => task.status === 'open').length;
    const reviewTasks = tasks.filter((task) => task.status === 'review').length;
    return {
      ingress: queuedTasks,
      sorting: 0,
      transit: runningTasks,
      unboxing: reviewTasks,
      working: running,
      reports: reviewTasks,
      delivered: tasks.filter((task) => task.status === 'delivered' || task.status === 'accepted').length,
      faults:
        observatory.incidents.filter((incident) => incident.state !== 'resolved').length +
        tasks.filter((task) => task.status === 'failed').length,
      lastBeatAgo: serverHeartbeatAge ?? 0,
      workerActivity: sceneWorkers.map((worker) =>
        worker.status === 'Failed' ? 'fault' : worker.status === 'Running' ? 'working' : worker.status === 'Waiting' ? 'holding' : worker.status === 'Completed' ? 'completed' : 'idle',
      ),
      workerQueue: sceneWorkers.map((worker) =>
        tasks.filter(
          (task) =>
            taskBelongsToWorker(task, {
              id: worker.id,
              threadId: worker.thread === '—' ? null : worker.thread,
            }) && ['open', 'running', 'review'].includes(task.status),
        ).length,
      ),
    };
  }, [observatory, running, sceneWorkers, serverHeartbeatAge, stats]);
  const inFlight = liveStats ? liveStats.ingress + liveStats.sorting + liveStats.transit : 0;
  const updatedAgo = paused
    ? pausedFor + 1
    : stale && serverHeartbeatAge !== null
      ? Math.round(serverHeartbeatAge)
      : observatory
        ? Math.round((Date.now() - observatory.generatedAt) / 1000)
        : 1;

  const live = paused
    ? { label: t('runtime.status.paused'), status: 'paused', color: SEMANTIC.wait }
    : stale
      ? { label: t('runtime.status.stale'), status: 'stale', color: SEMANTIC.fail }
      : standby
        ? { label: t('runtime.status.standby'), status: 'standby', color: SEMANTIC.idle }
        : { label: t('runtime.status.live'), status: 'live', color: SEMANTIC.ok };

  return (
    <div className="@container relative min-h-0 min-w-0 flex-1 overflow-hidden bg-[#F2EEE7] text-[#17181A]">
      {/* 3D world */}
      <div
        className="absolute inset-0 transition-[filter] duration-500"
        style={{ filter: paused ? 'saturate(0.55) brightness(1.02)' : 'none' }}
      >
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
          liveMode={Boolean(observatory)}
          tasks={observatory?.tasks ?? []}
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
        <h1 className="mt-3 text-[34px] font-semibold leading-none tracking-[-0.035em] text-[#17181A]">
          {t('runtime.title')}
        </h1>
        <div className="mt-2.5">
          <span
            className="inline-flex h-[22px] items-center gap-1.5 rounded-full border border-black/[0.07] bg-white px-2 font-mono text-[10px] font-semibold tracking-[0.08em]"
            style={{ color: live.color }}
          >
            <span className="relative flex h-1.5 w-1.5">
              {live.status === 'live' && (
                <span
                  className="absolute inset-0 rounded-full rt-ping"
                  style={{ background: live.color }}
                />
              )}
              <span
                className={`relative h-1.5 w-1.5 rounded-full ${live.status === 'stale' ? 'rt-pulse' : ''}`}
                style={{ background: live.color }}
              />
            </span>
            {live.label}
          </span>
        </div>
        <div className="mt-3 font-mono text-[11px] text-[#9A9389]">
          {empty ? t('runtime.state.idle') : t('runtime.state.lastUpdated', { seconds: updatedAgo })}
          <span className="mx-2 text-[#D3CCC0]">/</span>
          {t('runtime.state.interactionHint')}
        </div>
        {observatoryError && (
          <div className="mt-2 max-w-[340px] font-mono text-[10px] text-[#B33326]">
            {t('runtime.state.liveUnavailable')}
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="absolute right-[132px] top-6 z-30 flex items-center gap-2">
        <div className="flex h-9 items-center rounded-[8px] border border-black/[0.07] bg-white p-[3px] shadow-[0_6px_20px_rgba(40,30,15,0.06)] @max-[1140px]:hidden">
          <span className="px-2 font-mono text-[10px] uppercase tracking-[0.14em] text-[#9A9389]">
            {t('runtime.controls.scene')}
          </span>
          {PROTOTYPE_VARIANTS.map((v) => (
            <button
              key={v.id}
              type="button"
              title={t(`runtime.scenario.${v.id}.description`)}
              onClick={() => selectVariant(v.id)}
              className={`h-full cursor-pointer rounded-[6px] px-2.5 text-[12px] transition-colors duration-200 ${
                variant === v.id
                  ? 'bg-[#17181A] font-medium text-white'
                  : 'text-[#6B655C] hover:bg-[#F4F1EC] hover:text-[#17181A]'
              }`}
            >
              {t(`runtime.scenario.${v.id}.short`)}
            </button>
          ))}
        </div>
        {/* Compact scenario picker for narrow windows */}
        <label className="relative hidden h-9 items-center rounded-[8px] border border-black/[0.07] bg-white pl-3 pr-8 shadow-[0_6px_20px_rgba(40,30,15,0.06)] @max-[1140px]:flex">
          <span className="mr-2 font-mono text-[10px] uppercase tracking-[0.14em] text-[#9A9389]">
            {t('runtime.controls.scene')}
          </span>
          <select
            value={variant}
            onChange={(e) => selectVariant(e.target.value as RuntimePrototypeVariant)}
            aria-label={t('runtime.controls.switchScenario')}
            className="cursor-pointer appearance-none bg-transparent text-[12.5px] font-medium text-[#17181A] outline-none"
          >
            {PROTOTYPE_VARIANTS.map((v) => (
              <option key={v.id} value={v.id}>
                {t(`runtime.scenario.${v.id}.short`)}
              </option>
            ))}
          </select>
          <svg
            className="pointer-events-none absolute right-2.5 h-3 w-3 text-[#9A9389]"
            viewBox="0 0 12 12"
            fill="none"
          >
            <path
              d="M3 4.5L6 7.5L9 4.5"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </label>
        {!observatory && <button
          type="button"
          onClick={() => dispatch()}
          className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[8px] bg-[#17181A] px-3.5 text-[12.5px] font-medium text-white shadow-[0_6px_20px_rgba(23,24,26,0.18)] transition-colors duration-200 hover:bg-[#2A2C30]"
        >
          <Package className="h-3.5 w-3.5" />
          {t('runtime.controls.dispatch')}
        </button>}
        <button
          type="button"
          onClick={togglePause}
          title={paused ? t('runtime.controls.resume') : t('runtime.controls.pause')}
          className={`inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-[8px] border shadow-[0_6px_20px_rgba(40,30,15,0.06)] transition-colors duration-200 ${
            paused
              ? 'border-[#F3DFB0] bg-[#FDF6E7] text-[#A26C0B]'
              : 'border-black/[0.07] bg-white text-[#3F3B35] hover:bg-[#F6F3EE]'
          }`}
        >
          {paused ? (
            <Play className="h-3.5 w-3.5 fill-current" />
          ) : (
            <Pause className="h-3.5 w-3.5" />
          )}
        </button>
        <button
          type="button"
          onClick={() =>
            setSelection((s) => (s ? null : sceneWorkers[0]?.id ?? workers[0]?.id ?? 'router'))
          }
          title={inspectorOpen ? t('runtime.controls.closeDetails') : t('runtime.controls.openDetails')}
          className={`inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-[8px] border shadow-[0_6px_20px_rgba(40,30,15,0.06)] transition-colors duration-200 ${
            inspectorOpen
              ? 'border-[#17181A] bg-[#17181A] text-white'
              : 'border-black/[0.07] bg-white text-[#3F3B35] hover:bg-[#F6F3EE]'
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
            style={{ borderColor: paused ? '#F3DFB0' : '#F2C9C3' }}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: paused ? SEMANTIC.wait : SEMANTIC.fail }}
            />
            <span className="text-[#3F3B35]">
              {paused
                ? t('runtime.state.paused')
                : serverHeartbeatAge === null
                  ? t('runtime.state.heartbeatUnavailable')
                  : t('runtime.state.stale', { seconds: Math.round(serverHeartbeatAge) })}
            </span>
            <button
              type="button"
              onClick={() => (paused ? togglePause() : selectVariant('normal'))}
              className="h-7 cursor-pointer rounded-[6px] bg-[#17181A] px-2.5 text-[12px] font-medium text-white transition-colors duration-200 hover:bg-[#2A2C30]"
            >
              {paused ? t('runtime.controls.resume') : t('runtime.state.resetHeartbeat')}
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
            <h2 className="mt-3 text-[15px] font-semibold">{t('runtime.state.emptyTitle')}</h2>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-[#8A857D]">
              {t('runtime.state.emptyDescription')}
            </p>
            <button
              type="button"
              onClick={() => dispatch()}
              className="mt-4 inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[7px] bg-[#17181A] px-3 text-[12.5px] font-medium text-white transition-colors duration-200 hover:bg-[#2A2C30]"
            >
              {t('runtime.state.dispatchExample')}
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Pipeline */}
      <div className="absolute bottom-6 left-7 z-20 rounded-[8px] border border-black/[0.07] bg-white px-4 pb-2.5 pt-2.5 shadow-[0_12px_36px_rgba(40,30,15,0.08)]">
        <div className="mb-2 flex items-center justify-between">
          <Overline className="text-[#6B655C]">{t('runtime.pipeline.title')}</Overline>
          <span className="font-mono text-[10px] text-[#A39D93]">{t('runtime.pipeline.subtitle')}</span>
        </div>
        <div className="flex items-stretch">
          {PIPELINE.map((s, i) => (
            <React.Fragment key={s.key}>
              <div className="w-[84px]">
                <div className="flex items-center gap-1.5 font-mono text-[10px] text-[#A39D93]">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.color }} />
                  {s.no}
                </div>
                <div className="mt-1 text-[20px] font-semibold leading-none tabular-nums text-[#17181A]">
                  {String((liveStats?.[s.key] as number | undefined) ?? 0).padStart(2, '0')}
                </div>
                <div className="mt-1 text-[11px] text-[#3F3B35]">{t(s.labelKey)}</div>
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
        className={`absolute bottom-6 z-20 w-[300px] rounded-[8px] border border-black/[0.07] bg-white px-3.5 pb-2.5 pt-2.5 shadow-[0_12px_36px_rgba(40,30,15,0.08)] transition-[right,opacity] duration-300 @max-[900px]:hidden ${
          inspectorOpen ? '@max-[1320px]:pointer-events-none @max-[1320px]:opacity-0' : ''
        }`}
        style={{ right: inspectorOpen ? 24 + 360 + 16 : 24 }}
      >
        <div className="flex items-start justify-between">
          <div>
            <Overline className="text-[#6B655C]">{t('runtime.metrics.deliveredToday')}</Overline>
            <div className="mt-1 text-[24px] font-semibold leading-none tabular-nums">
              {liveStats?.delivered ?? 0}
            </div>
          </div>
          <Sparkline values={history} color={SEMANTIC.ok} />
        </div>
        <div className="mt-2 grid grid-cols-3 border-t border-black/[0.06] pt-2">
          <div>
            <div className="text-[10px] text-[#9A9389]">{t('runtime.metrics.running')}</div>
            <div className="mt-0.5 font-mono text-[12px] font-semibold">
              {String(running).padStart(2, '0')}
              <span className="text-[#A39D93]">/{String(workers.length).padStart(2, '0')}</span>
            </div>
          </div>
          <div>
            <div className="text-[10px] text-[#9A9389]">{t('runtime.metrics.inFlight')}</div>
            <div className="mt-0.5 font-mono text-[12px] font-semibold">
              {String(inFlight).padStart(2, '0')}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-[#9A9389]">{t('runtime.metrics.heartbeat')}</div>
            <div
              className="mt-0.5 flex items-center gap-1.5 font-mono text-[12px] font-semibold"
              style={{ color: stale ? SEMANTIC.fail : undefined }}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${stale ? 'rt-pulse' : ''}`}
                style={{ background: stale ? SEMANTIC.fail : SEMANTIC.ok }}
              />
              {stale
                ? serverHeartbeatAge === null
                  ? '—'
                  : `${Math.round(serverHeartbeatAge)}s`
                : `${(liveStats?.lastBeatAgo ?? 0).toFixed(1)}s`}
            </div>
          </div>
        </div>
      </div>

      {/* Inspector */}
      <aside
        className={`absolute bottom-6 right-6 top-[78px] z-30 flex w-[360px] flex-col overflow-hidden rounded-[8px] border border-black/[0.07] bg-white shadow-[0_28px_70px_rgba(40,30,15,0.16)] transition-[transform,opacity] duration-300 ease-out ${
          inspectorOpen
            ? 'translate-x-0 opacity-100'
            : 'pointer-events-none translate-x-[calc(100%+32px)] opacity-0'
        }`}
        aria-hidden={!inspectorOpen}
      >
        <InspectorHeader
          selection={selection}
          workers={workers}
          workerIndex={workerIndex}
          stale={stale}
          onClose={() => setSelection(null)}
        />
        {workerIndex >= 0 && (
          <WorkerInspector
            key={workers[workerIndex]!.id}
            worker={workers[workerIndex]!}
            accent={
              sceneWorkerIndex >= 0
                ? STATIONS[sceneWorkerIndex]?.accent ?? statusColor(workers[workerIndex]!.status)
                : statusColor(workers[workerIndex]!.status)
            }
            activity={liveStats?.workerActivity[sceneWorkerIndex] ?? 'idle'}
            queue={liveStats?.workerQueue[sceneWorkerIndex] ?? 0}
            paused={paused}
            liveMode={Boolean(observatory)}
            onDispatch={() => dispatch(sceneWorkerIndex >= 0 ? sceneWorkerIndex : undefined)}
          />
        )}
        {selection === 'router' && (
          <RouterInspector
            workers={workers}
            sceneWorkers={sceneWorkers}
            stats={liveStats}
            onSelectWorker={setSelection}
          />
        )}
        {selection === 'watchdog' && (
          <WatchdogInspector
            workers={workers}
            stale={stale}
            heartbeatAgeSeconds={observatory ? serverHeartbeatAge : variant === 'stale' ? 48.2 : liveStats?.lastBeatAgo ?? 0}
            stats={liveStats}
            onSelectWorker={setSelection}
          />
        )}
      </aside>
    </div>
  );
};

function InspectorHeader({
  selection,
  workers,
  workerIndex,
  stale,
  onClose,
}: {
  selection: WorldSelection;
  workers: WorkerRuntimeItem[];
  workerIndex: number;
  stale: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  let mark = 'RT';
  let accent = SEMANTIC.route;
  let title = 'Router';
  let subtitle = t('runtime.node.router');
  let badge: React.ReactNode = <StatusBadge status="Running" />;
  if (workerIndex >= 0) {
    const w = workers[workerIndex]!;
    const spec = STATIONS.find((station) => station.workerId === w.id);
    const kind = spec?.kind ?? stationKindForTemplate(w.template);
    mark = (spec?.label ?? w.name).slice(0, 2).toUpperCase();
    accent = spec?.accent ?? statusColor(w.status);
    title = w.name === '小助手' ? t(`runtime.station.${kind}`) : w.name;
    subtitle = `${w.name === '小助手' ? w.name : t(`runtime.station.${kind}`)} · ${String(workerIndex + 1).padStart(2, '0')}`;
    badge = <StatusBadge status={w.status} />;
  } else if (selection === 'watchdog') {
    mark = 'WD';
    accent = stale ? SEMANTIC.fail : SEMANTIC.ok;
    title = 'Watchdog';
    subtitle = t('runtime.node.watchdog');
    badge = <StatusBadge status={stale ? 'Failed' : 'Running'} />;
  }
  return (
    <div className="flex shrink-0 items-start justify-between gap-3 px-5 pb-3 pt-4">
      <div className="flex min-w-0 items-center gap-3">
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[7px] font-mono text-[11px] font-semibold text-white"
          style={{ background: accent }}
        >
          {mark}
        </div>
        <div className="min-w-0">
          <div className="truncate font-mono text-[14.5px] font-semibold text-[#17181A]">
            {title}
          </div>
          <div className="truncate text-[12px] text-[#8A857D]">{subtitle}</div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {badge}
        <button
          type="button"
          onClick={onClose}
          aria-label={t('runtime.inspector.close')}
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[6px] text-[#9A9389] transition-colors duration-200 hover:bg-[#F4F1EC] hover:text-[#17181A]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
