import { useEffect, useState } from 'react';
import { AppWindow, CheckCircle2, Download, Eye, HardDrive, RefreshCw, Search, Shield, Trash2, XCircle } from 'lucide-react';
import type { DesktopAppView, DesktopSettings, DesktopStatus } from '@opc/shared/ipc';
import { buttonClass, PageHeader, Row, Section, StatusBadge, Toggle } from '../kit';

const DEFAULT: DesktopSettings = { enabled: false, allowedApps: [], requireApprovalFor: ['external-submit', 'destructive', 'clipboard-write', 'physical-input'], maxOutputBytes: 64_000 };

function formatBytes(bytes?: number): string { if (bytes === undefined) return '正在统计'; if (bytes < 1024 ** 3) return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`; return `${(bytes / 1024 ** 3).toFixed(1)} GB`; }
function meta(status: DesktopStatus | null) {
  if (!status) return { tone: 'gray' as const, label: '连接中', detail: '正在读取桌面运行时状态' };
  if (status.installState === 'installing') return { tone: 'amber' as const, label: '安装中', detail: '正在准备桌面控制运行环境' };
  if (status.installState === 'permission-required') return { tone: 'amber' as const, label: '需要权限', detail: '请授予操作系统辅助功能权限' };
  if (status.installState === 'error') return { tone: 'red' as const, label: '需要处理', detail: status.error ?? '运行时检查失败' };
  if (status.installState === 'uninstalled') return { tone: 'gray' as const, label: '未安装', detail: '安装后 Personal Agent 才能控制桌面应用' };
  if (status.enabled && status.healthy) return { tone: 'green' as const, label: '已启用', detail: '桌面能力已按应用白名单开放' };
  return { tone: 'gray' as const, label: '已安装', detail: '运行时已就绪，可按需启用' };
}

export function DesktopPage() {
  const bridge = window.opc?.desktop;
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [settings, setSettings] = useState<DesktopSettings>(DEFAULT);
  const [apps, setApps] = useState<DesktopAppView[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inspectTaskId, setInspectTaskId] = useState('');
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const load = async () => {
    if (!bridge) return;
    try { const [nextStatus, nextSettings] = await Promise.all([bridge.status(), bridge.getSettings()]); setStatus(nextStatus); setSettings(nextSettings); if (nextStatus.healthy) setApps(await bridge.listApps()); setError(null); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  };
  // The Electron bridge is stable for the renderer lifetime.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); if (!bridge) return undefined; return bridge.onChanged((next) => setStatus(next)); }, []);
  const save = async (patch: Partial<DesktopSettings>) => { if (!bridge) return; setBusy(true); try { setSettings(await bridge.setSettings(patch)); setNotice('桌面策略已保存'); } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); } finally { setBusy(false); } };
  const install = async () => { if (!bridge) return; setBusy(true); setError(null); try { setStatus(await bridge.install()); setNotice('桌面运行时已安装并启用'); } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); } finally { setBusy(false); } };
  const remove = async () => { if (!bridge || !window.confirm('删除 OPC 的 agent-desktop 运行时？应用白名单会保留。')) return; setBusy(true); try { setStatus(await bridge.uninstall(true)); setNotice('桌面运行时已删除'); } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); } finally { setBusy(false); } };
  const permission = async (guide = false) => { if (!bridge) return; setBusy(true); try { setStatus(await (guide ? bridge.permissionsGuide() : bridge.permissions())); setNotice(guide ? '已打开系统权限引导' : '权限状态已刷新'); } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); } finally { setBusy(false); } };
  const inspect = async () => { if (!bridge || !inspectTaskId.trim()) return; setBusy(true); setError(null); try { const result = await bridge.inspect(inspectTaskId.trim()); setSnapshot(JSON.stringify(result, null, 2)); } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); } finally { setBusy(false); } };
  const statusMeta = meta(status);
  const installed = Boolean(status?.healthy) && status?.installState !== 'permission-required';
  const selected = new Set(settings.allowedApps.map((entry) => entry.id));
  const toggleApp = (app: DesktopAppView) => {
    const id = app.bundleId ?? app.process ?? app.name;
    const next = selected.has(id) ? settings.allowedApps.filter((entry) => entry.id !== id) : [...settings.allowedApps, { id, label: app.name, platform: window.opc?.platform ?? 'unknown', enabled: true, source: 'user' as const }];
    void save({ allowedApps: next });
  };
  return <div className="mx-auto w-full max-w-[55rem] px-6 py-6">
    <PageHeader crumbs={['桌面能力']} title="Personal Agent Computer Use" description="通过操作系统 Accessibility Tree 控制白名单应用。默认后台运行，敏感动作继续在当前对话中审批。" actions={<button type="button" className={buttonClass.secondary} onClick={() => void load()}><RefreshCw className="size-3.5" />刷新</button>} />
    {error ? <div className="mb-4 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">{error}</div> : null}
    {notice ? <div className="mb-4 rounded-lg border border-line bg-surface-muted px-4 py-3 text-sm text-ink-secondary">{notice}</div> : null}
    <section className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
      <div className="relative overflow-hidden px-5 py-5 sm:px-6 sm:py-6"><div className="pointer-events-none absolute -top-24 -right-20 size-64 rounded-full bg-accent/[0.045] blur-3xl" /><div className="relative flex flex-col gap-5 sm:flex-row sm:items-start sm:gap-6">
        <div className="relative flex size-[4.25rem] shrink-0 items-center justify-center rounded-[1.25rem] bg-ink text-surface shadow-[0_10px_24px_-14px_rgba(0,0,0,0.5)]"><AppWindow className="size-8 stroke-[1.35]" aria-hidden="true" /><span className={`absolute -right-1 -bottom-1 size-3 rounded-full border-2 border-surface ${statusMeta.tone === 'green' ? 'bg-success' : statusMeta.tone === 'red' ? 'bg-danger' : statusMeta.tone === 'amber' ? 'bg-warning' : 'bg-ink-quaternary'}`} /></div>
        <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="font-mono text-2xs font-medium tracking-[0.14em] text-ink-tertiary uppercase">Native capability</span><span className="size-1 rounded-full bg-ink-quaternary" /><span className="font-mono text-2xs text-ink-quaternary">opc.desktop</span></div><div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2"><h3 className="text-xl font-semibold tracking-tight text-ink">agent-desktop</h3><StatusBadge tone={statusMeta.tone} label={statusMeta.label} /></div><p className="mt-2 max-w-[38rem] text-sm leading-relaxed text-ink-secondary">让 Personal Agent 通过原生可访问性树观察并操作桌面应用。</p><p className="mt-1.5 text-xs-plus text-ink-tertiary">{statusMeta.detail}</p></div><div className="flex shrink-0 items-center gap-2 self-start rounded-lg border border-line bg-surface/80 px-2.5 py-2 sm:flex-col sm:items-end sm:border-0 sm:bg-transparent sm:px-0 sm:py-0"><span className="text-2xs font-medium tracking-wide text-ink-quaternary uppercase">Runtime</span><span className="font-mono text-xs-plus text-ink-secondary">{status?.version ? `v${status.version}` : '版本待安装'}</span></div>
      </div></div>
      <div className="grid border-t border-line bg-surface-muted/35 sm:grid-cols-2 xl:grid-cols-4"><div className="flex items-center gap-2.5 border-b border-line px-5 py-3.5 sm:border-r sm:border-b-0 sm:px-6"><Shield className="size-4 text-ink-tertiary" /><div><div className="text-2xs text-ink-quaternary">权限</div><div className="mt-0.5 text-xs-plus font-medium text-ink-secondary">{status?.permissions.accessibility === 'granted' ? 'Accessibility 已授予' : '需要系统授权'}</div></div></div><div className="flex items-center gap-2.5 border-b border-line px-5 py-3.5 sm:border-r sm:border-b-0 sm:px-6"><AppWindow className="size-4 text-ink-tertiary" /><div><div className="text-2xs text-ink-quaternary">控制方式</div><div className="mt-0.5 text-xs-plus font-medium text-ink-secondary">后台语义操作</div></div></div><div className="flex items-center gap-2.5 border-b border-line px-5 py-3.5 xl:border-r xl:border-b-0 sm:px-6"><CheckCircle2 className="size-4 text-ink-tertiary" /><div><div className="text-2xs text-ink-quaternary">应用权限</div><div className="mt-0.5 text-xs-plus font-medium text-ink-secondary">{settings.allowedApps.filter((entry) => entry.enabled).length} 个白名单应用</div></div></div><div className="flex items-center gap-2.5 px-5 py-3.5 sm:px-6"><HardDrive className="size-4 text-ink-tertiary" /><div><div className="text-2xs text-ink-quaternary">安装包 / 占用</div><div className="mt-0.5 text-xs-plus font-medium text-ink-secondary">{formatBytes(status?.packageBytes)} · {formatBytes(status?.diskUsageBytes)}</div></div></div></div>
      <div className="flex flex-col gap-3 border-t border-line px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-6"><div className="flex items-center gap-3"><Toggle checked={settings.enabled} disabled={!installed || busy} label="启用桌面能力" onChange={(enabled) => void save({ enabled })} /><div><div className="text-sm font-medium text-ink">启用桌面能力</div><div className="text-xs-plus text-ink-tertiary">Worker 只能操作下方白名单应用</div></div></div><div className="flex flex-wrap gap-2"><button type="button" className={buttonClass.primary} disabled={busy || !bridge} onClick={() => void install()}><Download className="size-3.5" />{installed ? '重新安装' : '安装运行时'}</button><button type="button" className={buttonClass.secondary} disabled={busy || !status?.binary} onClick={() => void permission()}><Shield className="size-3.5" />刷新权限</button><button type="button" className={buttonClass.secondary} disabled={busy || !status?.binary} onClick={() => void permission(true)}><Shield className="size-3.5" />打开权限设置</button><button type="button" className={buttonClass.danger} disabled={busy || !status?.binary} onClick={() => void remove()}><Trash2 className="size-3.5" />删除运行时</button></div></div>
    </section>
    <div className="mt-4"><Section title="应用白名单" description="按 Personal Agent 保存。未列入白名单的应用即使通过审批也不能被控制。"><div className="border-b border-line px-4 py-3"><div className="flex items-center justify-between gap-3"><div><div className="text-sm font-medium text-ink">当前运行应用</div><div className="text-xs-plus text-ink-tertiary">选择后允许该 Agent 读取和操作应用的 Accessibility Tree。</div></div><button type="button" className={buttonClass.secondary} disabled={!installed || busy} onClick={() => void load()}><RefreshCw className="size-3.5" />扫描</button></div></div>{apps.length ? apps.map((app) => { const id = app.bundleId ?? app.process ?? app.name; const enabled = selected.has(id); return <button key={id} type="button" onClick={() => toggleApp(app)} className="flex w-full items-center justify-between gap-3 border-b border-line px-4 py-3 text-left last:border-b-0 hover:bg-surface-muted/50"><span className="flex min-w-0 items-center gap-3"><AppWindow className="size-4 shrink-0 text-ink-tertiary" /><span className="min-w-0"><span className="block truncate text-sm font-medium text-ink">{app.name}</span><span className="block truncate font-mono text-2xs text-ink-quaternary">{app.bundleId ?? app.process ?? id}</span></span></span>{enabled ? <CheckCircle2 className="size-4 shrink-0 text-success" /> : <XCircle className="size-4 shrink-0 text-ink-quaternary" />}</button>; }) : <div className="px-4 py-5 text-sm text-ink-tertiary">安装并授予权限后扫描当前运行应用。</div>}</Section></div>
    <div className="mt-4"><Section title="动作策略" description="外部提交、删除、剪贴板写入和物理输入始终在当前对话中单独审批。"><Row label="敏感动作审批" hint="推荐保持开启，避免桌面应用产生未预期的外部副作用。"><Toggle checked disabled label="敏感动作审批" onChange={() => undefined} /></Row></Section></div>
    <div className="mt-4"><Section title="Desktop Inspector" description="读取当前任务的实时 Accessibility Snapshot。只读取 OPC 已创建的 session，不会启动新的桌面操作。"><div className="flex items-center gap-2 border-b border-line px-4 py-3"><input value={inspectTaskId} onChange={(event) => setInspectTaskId(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void inspect(); }} className="min-w-0 flex-1 rounded-lg border border-line bg-surface-muted px-3 py-2 font-mono text-xs text-ink outline-none focus:border-accent" placeholder="输入正在执行的 taskId" /><button type="button" className={buttonClass.secondary} disabled={busy || !inspectTaskId.trim()} onClick={() => void inspect()}><Search className="size-3.5" />读取 Snapshot</button></div>{snapshot ? <pre className="max-h-[26rem] overflow-auto whitespace-pre-wrap break-words bg-[#171a18] px-4 py-4 font-mono text-[11px] leading-relaxed text-[#d9e3da]">{snapshot}</pre> : <div className="px-4 py-5 text-sm text-ink-tertiary">任务使用桌面能力后，在这里查看最新的控件树和 ref。</div>}</Section></div>
    <div className="mt-4 flex items-center gap-2 text-xs-plus text-ink-tertiary"><Eye className="size-3.5" />默认后台运行；用户可以从任务详情打开 Inspector 查看当前窗口、Accessibility Snapshot 和操作轨迹。</div>
  </div>;
}
