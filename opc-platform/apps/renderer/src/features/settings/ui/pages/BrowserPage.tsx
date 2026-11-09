import { useEffect, useState } from 'react';
import { CheckCircle2, Download, Globe2, HardDrive, PanelsTopLeft, RefreshCw, Shield, Trash2 } from 'lucide-react';
import type { BrowserSettings, BrowserStatus } from '@opc/shared/ipc';
import { buttonClass, PageHeader, Row, Section, StatusBadge, Toggle } from '../kit';

const DEFAULT: BrowserSettings = {
  enabled: false,
  allowedDomains: [],
  blockedDomains: [],
  allowAllDomains: false,
  requireApprovalFor: ['external-submit', 'download', 'upload', 'authentication', 'destructive'],
  maxOutputBytes: 32_000,
};

const APPROVAL_OPTIONS = [
  ['external-submit', '外部提交、发送和发布'],
  ['download', '下载文件'],
  ['upload', '上传文件'],
  ['authentication', '登录和身份验证'],
  ['destructive', '删除、支付和不可逆操作'],
  ['navigation', '打开未允许域名'],
] as const;

function browserStatusMeta(status: BrowserStatus | null) {
  if (!status) return { tone: 'gray' as const, label: '连接中', detail: '正在读取运行时状态' };
  if (status.installState === 'installing') return { tone: 'amber' as const, label: '安装中', detail: '正在准备浏览器运行环境' };
  if (status.installState === 'error') return { tone: 'red' as const, label: '需要处理', detail: status.error ?? '运行时检查失败' };
  if (status.installState === 'uninstalled') return { tone: 'gray' as const, label: '未安装', detail: '安装后即可让 Worker 使用浏览器工具' };
  if (status.enabled && status.healthy) return { tone: 'green' as const, label: '已启用', detail: '浏览器能力已对 Worker 开放' };
  return { tone: 'gray' as const, label: '已安装', detail: '运行时已就绪，可按需启用' };
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '正在统计';
  if (bytes < 1024 ** 3) return `${Math.max(1, Math.round(bytes / (1024 ** 2)))} MB`;
  return `${(bytes / (1024 ** 3)).toFixed(1)} GB`;
}

export function BrowserPage() {
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [settings, setSettings] = useState<BrowserSettings>(DEFAULT);
  const [domains, setDomains] = useState('');
  const [blockedDomains, setBlockedDomains] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bridge = window.opc?.browser;

  const load = async () => {
    if (!bridge) return;
    try {
      const [nextStatus, nextSettings] = await Promise.all([bridge.status(), bridge.getSettings()]);
      setStatus(nextStatus); setSettings(nextSettings); setDomains(nextSettings.allowedDomains.join('\n')); setBlockedDomains(nextSettings.blockedDomains.join('\n')); setError(null);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  };
  // The preload bridge is stable for the lifetime of the renderer.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); if (!bridge) return undefined; return bridge.onChanged((next) => setStatus(next)); }, []);

  const install = async () => { if (!bridge) return; setBusy(true); setError(null); try { setStatus(await bridge.install()); setNotice('浏览器已安装并启用'); } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); } finally { setBusy(false); } };
  const save = async (patch: Partial<BrowserSettings>) => { if (!bridge) return; setBusy(true); try { const next = await bridge.setSettings(patch); setSettings(next); setNotice('浏览器策略已保存'); } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); } finally { setBusy(false); } };
  const uninstall = async () => { if (!bridge || !window.confirm('停用浏览器运行时？登录档案会保留。')) return; setBusy(true); setError(null); try { setStatus(await bridge.uninstall(false)); setNotice('浏览器已停用'); } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); } finally { setBusy(false); } };
  const removeRuntime = async () => {
    if (!bridge || !window.confirm('删除 agent-browser 运行时和 Chrome for Testing 缓存？登录档案会保留；其他应用共享的 Playwright 缓存也可能受到影响。')) return;
    setBusy(true);
    setError(null);
    try { setStatus(await bridge.uninstall(false, true)); setNotice('浏览器运行时和浏览器缓存已删除'); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  const resetProfile = async () => { if (!bridge || !window.confirm('清除浏览器登录状态和站点数据？此操作不可撤销。')) return; setBusy(true); try { await bridge.resetProfile(); setNotice('浏览器档案已清除'); } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); } finally { setBusy(false); } };
  const statusMeta = browserStatusMeta(status);
  const runtimeReady = Boolean(status?.healthy) || status?.installState === 'ready' || status?.installState === 'disabled';
  const installed = runtimeReady;
  const installLabel = status?.installState === 'installing'
    ? '安装中'
    : runtimeReady
      ? '重新安装'
      : status?.installState === 'error'
        ? '重新安装'
        : '安装运行时';

  return (
    <div className="mx-auto w-full max-w-[55rem] px-6 py-6">
      <PageHeader crumbs={['浏览器']} title="Personal Agent 浏览器" description="浏览器是 OPC 的原生执行能力，不通过 MCP 暴露。默认后台运行，外部副作用始终由对话审批卡片控制。" actions={<button type="button" className={buttonClass.secondary} onClick={() => void load()}><RefreshCw className="size-3.5" />刷新</button>} />
      {error ? <div className="mb-4 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">{error}</div> : null}
      {notice ? <div className="mb-4 rounded-lg border border-line bg-surface-muted px-4 py-3 text-sm text-ink-secondary">{notice}</div> : null}
      <section className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
        <div className="relative overflow-hidden px-5 py-5 sm:px-6 sm:py-6">
          <div className="pointer-events-none absolute -top-24 -right-20 size-64 rounded-full bg-accent/[0.045] blur-3xl" />
          <div className="relative flex flex-col gap-5 sm:flex-row sm:items-start sm:gap-6">
            <div className="relative flex size-[4.25rem] shrink-0 items-center justify-center rounded-[1.25rem] bg-ink text-surface shadow-[0_10px_24px_-14px_rgba(0,0,0,0.5)]">
              <PanelsTopLeft className="size-8 stroke-[1.35]" aria-hidden="true" />
              <span className="absolute right-2.5 bottom-2.5 flex size-5 items-center justify-center rounded-md bg-surface/15 text-surface/80">
                <Globe2 className="size-3.5" strokeWidth={1.7} aria-hidden="true" />
              </span>
              <span className={`absolute -right-1 -bottom-1 size-3 rounded-full border-2 border-surface ${statusMeta.tone === 'green' ? 'bg-success' : statusMeta.tone === 'red' ? 'bg-danger' : statusMeta.tone === 'amber' ? 'bg-warning' : 'bg-ink-quaternary'}`} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-2xs font-medium tracking-[0.14em] text-ink-tertiary uppercase">Native capability</span>
                <span className="size-1 rounded-full bg-ink-quaternary" />
                <span className="font-mono text-2xs text-ink-quaternary">opc.browser</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                <h3 className="text-xl font-semibold tracking-tight text-ink">agent-browser</h3>
                <StatusBadge tone={statusMeta.tone} label={statusMeta.label} />
              </div>
              <p className="mt-2 max-w-[38rem] text-sm leading-relaxed text-ink-secondary">
                为 Personal Agent 提供可控、可审批、可持久化的浏览器执行能力。
              </p>
              <p className="mt-1.5 text-xs-plus text-ink-tertiary">{statusMeta.detail}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2 self-start rounded-lg border border-line bg-surface/80 px-2.5 py-2 sm:flex-col sm:items-end sm:border-0 sm:bg-transparent sm:px-0 sm:py-0">
              <span className="text-2xs font-medium tracking-wide text-ink-quaternary uppercase">Runtime</span>
              <span className="font-mono text-xs-plus text-ink-secondary">{status?.version ? `v${status.version}` : '版本待安装'}</span>
            </div>
          </div>
        </div>
        <div className="grid border-t border-line bg-surface-muted/35 sm:grid-cols-2 xl:grid-cols-4">
          <div className="flex items-center gap-2.5 border-b border-line px-5 py-3.5 sm:border-r sm:border-b-0 sm:px-6">
            <Globe2 className="size-4 text-ink-tertiary" strokeWidth={1.7} aria-hidden="true" />
            <div className="min-w-0"><div className="text-2xs text-ink-quaternary">运行环境</div><div className="mt-0.5 truncate text-xs-plus font-medium text-ink-secondary">Chrome for Testing</div></div>
          </div>
          <div className="flex items-center gap-2.5 border-b border-line px-5 py-3.5 sm:border-r sm:border-b-0 sm:px-6">
            <Shield className="size-4 text-ink-tertiary" strokeWidth={1.7} aria-hidden="true" />
            <div className="min-w-0"><div className="text-2xs text-ink-quaternary">会话档案</div><div className="mt-0.5 truncate text-xs-plus font-medium text-ink-secondary" title={status?.profilePath}>持久化登录状态</div></div>
          </div>
          <div className="flex items-center gap-2.5 border-b border-line px-5 py-3.5 xl:border-r xl:border-b-0 sm:px-6">
            <CheckCircle2 className="size-4 text-ink-tertiary" strokeWidth={1.7} aria-hidden="true" />
            <div className="min-w-0"><div className="text-2xs text-ink-quaternary">运行方式</div><div className="mt-0.5 truncate text-xs-plus font-medium text-ink-secondary">默认后台运行</div></div>
          </div>
          <div className="flex items-center gap-2.5 px-5 py-3.5 sm:px-6">
            <HardDrive className="size-4 text-ink-tertiary" strokeWidth={1.7} aria-hidden="true" />
            <div className="min-w-0">
              <div className="text-2xs text-ink-quaternary">{runtimeReady ? '实际磁盘占用' : '预计下载'}</div>
              <div className="mt-0.5 truncate text-xs-plus font-medium text-ink-secondary" title={runtimeReady ? 'agent-browser 运行时与 Playwright 浏览器缓存' : '估算值，实际下载量会因平台和缓存状态而变化'}>
                {runtimeReady ? formatBytes(status?.diskUsageBytes) : `约 ${formatBytes(status?.downloadEstimateBytes)}`}
              </div>
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-3 border-t border-line px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex items-center gap-3">
            <Toggle checked={settings.enabled} disabled={!installed || busy} label="启用浏览器能力" onChange={(enabled) => void save({ enabled })} />
            <div><div className="text-sm font-medium text-ink">启用浏览器能力</div><div className="text-xs-plus text-ink-tertiary">Worker 可调用 browser_* 原生工具</div></div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass.primary} disabled={busy || status?.installState === 'installing' || !bridge} onClick={() => void install()}><Download className="size-3.5" />{installLabel}</button>
            <button type="button" className={buttonClass.secondary} disabled={busy || !installed} onClick={uninstall}><Trash2 className="size-3.5" />停用</button>
            <button type="button" className={buttonClass.danger} disabled={busy || !installed} onClick={() => void removeRuntime()}><Trash2 className="size-3.5" />删除运行时</button>
          </div>
        </div>
      </section>
      <div className="mt-4">
        <Section title="域名策略" description="每行一个域名，支持 *.example.com。阻止列表优先于允许列表。">
          <Row label="允许所有域名" hint="开启后仍会拦截阻止列表中的域名。">
            <Toggle checked={settings.allowAllDomains} disabled={busy} label="允许所有域名" onChange={(allowAllDomains) => void save({ allowAllDomains })} />
          </Row>
          <div className="border-t border-line px-4 py-3"><label className="block text-sm font-medium text-ink">允许域名</label><textarea value={domains} onChange={(event) => setDomains(event.target.value)} onBlur={() => void save({ allowedDomains: domains.split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean) })} className="mt-2 min-h-24 w-full rounded-lg border border-line bg-surface-muted px-3 py-2 text-sm text-ink outline-none focus:border-accent" placeholder="example.com\n*.company.com" /></div>
          <div className="border-t border-line px-4 py-3"><label className="block text-sm font-medium text-ink">阻止域名</label><textarea value={blockedDomains} onChange={(event) => setBlockedDomains(event.target.value)} onBlur={() => void save({ blockedDomains: blockedDomains.split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean) })} className="mt-2 min-h-20 w-full rounded-lg border border-line bg-surface-muted px-3 py-2 text-sm text-ink outline-none focus:border-accent" placeholder="ads.example.com\n*.tracking.test" /></div>
        </Section>
      </div>
      <div className="mt-4">
        <Section title="审批策略" description="高风险动作会暂停当前 Worker，并在当前对话卡片中等待确认。">
          {APPROVAL_OPTIONS.map(([key, label]) => <Row key={key} label={label} hint={key === 'navigation' ? '允许列表之外的导航仍然会先请求审批。' : '关闭后，该类动作不会自动弹出审批卡片。'}><Toggle checked={settings.requireApprovalFor.includes(key)} disabled={busy} label={label} onChange={(enabled) => void save({ requireApprovalFor: enabled ? [...new Set([...settings.requireApprovalFor, key])] : settings.requireApprovalFor.filter((item) => item !== key) })} /></Row>)}
        </Section>
      </div>
      <div className="mt-4 flex items-center justify-between gap-4"><div className="flex items-center gap-2 text-xs-plus text-ink-tertiary"><Shield className="size-3.5" />登录、提交、下载、上传、删除和发布动作会在当前对话中显示审批卡片；审批后继续原 Worker 和原任务。</div><button type="button" className={buttonClass.secondary} disabled={busy} onClick={() => void resetProfile()}><Trash2 className="size-3.5" />清除登录档案</button></div>
    </div>
  );
}

