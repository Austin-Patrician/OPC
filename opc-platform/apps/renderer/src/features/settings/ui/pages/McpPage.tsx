import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, KeyRound, Loader2, LogOut, Plug, RefreshCw, RotateCw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { McpServerView, McpToolView } from '@opc/shared/ipc';
import { buttonClass, PageHeader, Section, StatusBadge } from '@/features/settings/ui/kit';
import { cn } from '@/shared/lib/cn';

/**
 * 外部能力（MCP）设置页。
 *
 * 这一页存在的理由很具体：`mcp.json` 手写得，但**手写的人只有已经知道它的人才当得成**。
 * 而"这个应用还能连什么"是一个新用户最先问的问题。
 *
 * 所有操作都落到那个文件上（它是 MCP 生态的公共格式，能进版本库），这一页只是它的编辑器。
 */
interface Draft {
  name: string;
  transport: 'stdio' | 'http';
  target: string;
  exposure: 'deferred' | 'direct' | 'hidden';
  autoApprove: boolean;
  description: string;
}

const EMPTY: Draft = { name: '', transport: 'stdio', target: '', exposure: 'deferred', autoApprove: false, description: '' };

export function McpPage() {
  const { t } = useTranslation();
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tools, setTools] = useState<Record<string, McpToolView[]>>({});
  const [toolsError, setToolsError] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!window.opc?.mcp) return;
    try {
      const next = await window.opc.mcp.list();
      setServers(next.servers);
      setSources(next.sources);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setBusy('save');
    try {
      const next = await window.opc!.mcp.save({
        name: draft.name.trim(),
        transport: draft.transport,
        target: draft.target.trim(),
        exposure: draft.exposure,
        autoApprove: draft.autoApprove,
        ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
      });
      setServers(next.servers);
      setSources(next.sources);
      setDraft(EMPTY);
      setNotice(t('settings.mcp.saved'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const test = async (name: string) => {
    setBusy(`test:${name}`);
    try {
      const result = await window.opc!.mcp.test(name);
      setServers((previous) => previous.map((row) => (row.name === name ? result : row)));
      setNotice(
        result.error
          ? t('settings.mcp.testFailed', { name, reason: result.error })
          : t('settings.mcp.testOk', { name, tools: result.tools ?? 0, resources: result.resources ?? 0 }),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  /** 走一遍 OAuth：会打开浏览器，回来就多一行"已登录"。 */
  const signIn = async (name: string) => {
    setBusy(`auth:${name}`);
    try {
      const next = await window.opc!.mcp.login(name);
      setServers(next.servers);
      setSources(next.sources);
      setNotice(t('settings.mcp.signedInNotice', { name }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const signOut = async (name: string) => {
    setBusy(`auth:${name}`);
    try {
      const next = await window.opc!.mcp.logout(name);
      setServers(next.servers);
      setSources(next.sources);
      setNotice(t('settings.mcp.signedOutNotice', { name }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (name: string) => {
    setBusy(`remove:${name}`);
    try {
      const next = await window.opc!.mcp.remove(name);
      setServers(next.servers);
      setSources(next.sources);
      setNotice(t('settings.mcp.removed', { name }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const setAutoApprove = async (name: string, enabled: boolean) => {
    setBusy(`approval:${name}`);
    try {
      const next = await window.opc!.mcp.setAutoApprove(name, enabled);
      setServers(next.servers);
      setSources(next.sources);
      setNotice(t(enabled ? 'settings.mcp.autoApproveEnabledNotice' : 'settings.mcp.autoApproveDisabledNotice', { name }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const loadTools = async (name: string) => {
    setBusy(`tools:${name}`);
    setToolsError((previous) => ({ ...previous, [name]: '' }));
    try {
      const next = await window.opc!.mcp.listTools(name);
      setTools((previous) => ({ ...previous, [name]: next }));
    } catch (caught) {
      setToolsError((previous) => ({ ...previous, [name]: caught instanceof Error ? caught.message : String(caught) }));
    } finally {
      setBusy(null);
    }
  };

  const toggleTools = (name: string) => {
    if (expanded === name) {
      setExpanded(null);
      return;
    }
    setExpanded(name);
    if (!tools[name]) void loadTools(name);
  };

  const setToolAutoApprove = async (server: string, tool: McpToolView, enabled: boolean) => {
    setBusy(`tool:${server}:${tool.name}`);
    try {
      await window.opc!.mcp.setToolAutoApprove(server, tool.name, enabled);
      setTools((previous) => ({
        ...previous,
        [server]: (previous[server] ?? []).map((item) =>
          item.name === tool.name ? { ...item, autoApprove: enabled, overridden: true } : item,
        ),
      }));
      setNotice(t(enabled ? 'settings.mcp.toolAutoApproveEnabled' : 'settings.mcp.toolAutoApproveDisabled', { tool: tool.title ?? tool.name }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const bulkToolApproval = async (server: McpServerView, enabled: boolean) => {
    setBusy(`bulk:${server.name}`);
    try {
      await window.opc!.mcp.resetToolApprovals(server.name, enabled);
      setTools((previous) => ({
        ...previous,
        [server.name]: (previous[server.name] ?? []).map((tool) => ({ ...tool, autoApprove: enabled, overridden: false })),
      }));
      setServers((previous) => previous.map((item) => item.name === server.name ? { ...item, autoApprove: enabled } : item));
      setNotice(t('settings.mcp.toolsBulkNotice', { name: server.name }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto w-full max-w-[55rem] px-6 py-6">
      <PageHeader
        crumbs={[t('settings.group.mcp')]}
        title={t('settings.mcp.title')}
        description={t('settings.mcp.description')}
        actions={
          <button
            type="button"
            onClick={() => void load()}
            className={buttonClass.secondary}
            disabled={loading}
          >
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
            {t('attention.refresh')}
          </button>
        }
      />

      {error ? (
        <div className="mb-4 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="mb-4 rounded-xl border border-line bg-surface-muted/40 px-4 py-3 text-sm text-ink-secondary">
          {notice}
        </div>
      ) : null}

      <Section title={t('settings.mcp.installed')} description={t('settings.mcp.installedHint')}>
        {servers.length === 0 ? (
          <p className="px-4 py-6 text-sm text-ink-tertiary">{t('settings.mcp.empty')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {servers.map((server) => (
              <li key={server.name} className="flex flex-wrap items-start gap-3 px-4 py-3">
                <Plug className="mt-0.5 size-4 shrink-0 text-ink-quaternary" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink">{server.name}</span>
                    <StatusBadge
                      tone={server.enabled ? 'green' : 'gray'}
                      label={server.enabled ? t('settings.mcp.enabled') : t('settings.mcp.disabled')}
                    />
                    <StatusBadge
                      tone={server.exposure === 'direct' ? 'blue' : 'gray'}
                      label={t(`settings.mcp.exposure.${server.exposure}`)}
                    />
                    {server.auth ? (
                      <StatusBadge
                        tone={server.auth === 'signed-in' ? 'green' : 'amber'}
                        label={
                          server.auth === 'signed-in'
                            ? t('settings.mcp.signedIn')
                            : t('settings.mcp.signedOut')
                        }
                      />
                    ) : null}
                  </div>
                  <div className="mt-0.5 truncate text-2xs text-ink-quaternary">{server.target}</div>
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={server.autoApprove}
                      aria-label={`${server.name}: ${t('settings.mcp.autoApprove')}`}
                      onClick={() => void setAutoApprove(server.name, !server.autoApprove)}
                      disabled={busy === `approval:${server.name}`}
                      className={cn(
                        'relative inline-flex h-[19px] w-[34px] shrink-0 items-center rounded-full border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#87947b] disabled:cursor-wait disabled:opacity-60',
                        server.autoApprove ? 'border-[#526d59] bg-[#526d59]' : 'border-[#c9c9bf] bg-[#e7e6df]',
                      )}
                    >
                      <span
                        className={cn(
                          'size-3.5 rounded-full bg-white shadow-sm transition-transform',
                          server.autoApprove ? 'translate-x-[16px]' : 'translate-x-[2px]',
                        )}
                      />
                    </button>
                    <span className={cn('text-2xs font-medium', server.autoApprove ? 'text-[#8a6636]' : 'text-ink-tertiary')}>
                      {server.autoApprove ? t('settings.mcp.autoApproveOn') : t('settings.mcp.autoApproveOff')}
                    </span>
                  </div>
                  {server.tools !== undefined ? (
                    <div className="mt-0.5 text-2xs text-ink-tertiary">
                      {t('settings.mcp.counts', { tools: server.tools, resources: server.resources ?? 0 })}
                    </div>
                  ) : null}
                  {server.error ? (
                    <div className="mt-1 text-2xs text-danger">{server.error}</div>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => toggleTools(server.name)}
                    className={buttonClass.secondary}
                    aria-expanded={expanded === server.name}
                    title={t('settings.mcp.tools')}
                  >
                    {busy === `tools:${server.name}` ? <Loader2 className="size-3.5 animate-spin" /> : <ChevronDown className={cn('size-3.5 transition-transform', expanded === server.name && 'rotate-180')} />}
                    {t('settings.mcp.tools')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void test(server.name)}
                    disabled={busy === `test:${server.name}`}
                    className={buttonClass.secondary}
                  >
                    {busy === `test:${server.name}` ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Plug className="size-3.5" />
                    )}
                    {t('settings.mcp.test')}
                  </button>
                  {server.auth ? (
                    <button
                      type="button"
                      onClick={() =>
                        void (server.auth === 'signed-in' ? signOut(server.name) : signIn(server.name))
                      }
                      disabled={busy === `auth:${server.name}`}
                      className={buttonClass.secondary}
                    >
                      {busy === `auth:${server.name}` ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : server.auth === 'signed-in' ? (
                        <LogOut className="size-3.5" />
                      ) : (
                        <KeyRound className="size-3.5" />
                      )}
                      {server.auth === 'signed-in' ? t('settings.mcp.signOut') : t('settings.mcp.signIn')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void remove(server.name)}
                    disabled={busy === `remove:${server.name}`}
                    className={buttonClass.secondary}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
                {expanded === server.name ? (
                  <div className="basis-full ml-7 mt-3 border-t border-line/70 pt-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="text-2xs font-medium uppercase tracking-[0.08em] text-ink-quaternary">{t('settings.mcp.highImpactTools')}</span>
                      <div className="flex items-center gap-1.5">
                        <button type="button" className={buttonClass.secondary} onClick={() => void bulkToolApproval(server, true)} disabled={busy === `bulk:${server.name}`}>
                          {t('settings.mcp.allAutoApprove')}
                        </button>
                        <button type="button" className={buttonClass.secondary} onClick={() => void bulkToolApproval(server, false)} disabled={busy === `bulk:${server.name}`}>
                          {t('settings.mcp.allRequireApproval')}
                        </button>
                        <button type="button" className={buttonClass.secondary} onClick={() => void loadTools(server.name)} disabled={busy === `tools:${server.name}`} aria-label={t('attention.refresh')}>
                          <RotateCw className={cn('size-3.5', busy === `tools:${server.name}` && 'animate-spin')} />
                        </button>
                      </div>
                    </div>
                    {toolsError[server.name] ? <div className="text-2xs text-danger">{toolsError[server.name]}</div> : null}
                    {!toolsError[server.name] && tools[server.name]?.length === 0 ? <div className="text-2xs text-ink-tertiary">{t('settings.mcp.noHighImpactTools')}</div> : null}
                    <div className="space-y-1.5">
                      {(tools[server.name] ?? []).map((tool) => (
                        <div key={tool.name} className="flex items-center gap-3 rounded-lg bg-surface-muted/45 px-3 py-2">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-xs font-medium text-ink">{tool.title ?? tool.name}</div>
                            <div className="flex flex-wrap items-center gap-x-2 text-2xs text-ink-quaternary">
                              <span className="truncate">{tool.name}</span>
                              {tool.risk.map((risk) => <span key={risk} className="rounded border border-line px-1 py-0.5">{t(`settings.mcp.risk.${risk}`)}</span>)}
                              {tool.overridden ? <span>{t('settings.mcp.customOverride')}</span> : null}
                            </div>
                          </div>
                          <button type="button" role="switch" aria-checked={tool.autoApprove} aria-label={`${tool.name}: ${t('settings.mcp.autoApprove')}`} onClick={() => void setToolAutoApprove(server.name, tool, !tool.autoApprove)} disabled={busy === `tool:${server.name}:${tool.name}`} className={cn('relative inline-flex h-[19px] w-[34px] shrink-0 items-center rounded-full border transition-colors', tool.autoApprove ? 'border-[#526d59] bg-[#526d59]' : 'border-[#c9c9bf] bg-[#e7e6df]')}>
                            <span className={cn('size-3.5 rounded-full bg-white shadow-sm transition-transform', tool.autoApprove ? 'translate-x-[16px]' : 'translate-x-[2px]')} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={t('settings.mcp.add')} description={t('settings.mcp.addHint')}>
        <div className="grid gap-3 px-4 py-4 sm:grid-cols-[10rem_7rem_1fr]">
          <label className="block text-2xs text-ink-tertiary">
            {t('settings.mcp.name')}
            <input
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="github"
              className="mt-1 w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none"
            />
          </label>
          <label className="block text-2xs text-ink-tertiary">
            {t('settings.mcp.transport')}
            <select
              value={draft.transport}
              onChange={(event) =>
                setDraft({ ...draft, transport: event.target.value === 'http' ? 'http' : 'stdio' })
              }
              className="mt-1 w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none"
            >
              <option value="stdio">stdio</option>
              <option value="http">HTTP</option>
            </select>
          </label>
          <label className="block text-2xs text-ink-tertiary">
            {draft.transport === 'stdio' ? t('settings.mcp.command') : t('settings.mcp.url')}
            <input
              value={draft.target}
              onChange={(event) => setDraft({ ...draft, target: event.target.value })}
              placeholder={
                draft.transport === 'stdio' ? 'npx -y @modelcontextprotocol/server-filesystem .' : 'https://example.com/mcp'
              }
              className="mt-1 w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none"
            />
          </label>
          <label className="block text-2xs text-ink-tertiary sm:col-span-2">
            {t('settings.mcp.descriptionField')}
            <input
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              placeholder={t('settings.mcp.descriptionPlaceholder')}
              className="mt-1 w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none"
            />
          </label>
          <label className="block text-2xs text-ink-tertiary">
            {t('settings.mcp.exposureField')}
            <select
              value={draft.exposure}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  exposure:
                    event.target.value === 'direct' || event.target.value === 'hidden'
                      ? event.target.value
                      : 'deferred',
                })
              }
              className="mt-1 w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none"
            >
              <option value="deferred">{t('settings.mcp.exposure.deferred')}</option>
              <option value="direct">{t('settings.mcp.exposure.direct')}</option>
              <option value="hidden">{t('settings.mcp.exposure.hidden')}</option>
            </select>
          </label>
          <div className="flex items-start gap-2.5 text-2xs text-ink-tertiary sm:col-span-2">
            <button
              type="button"
              role="switch"
              aria-checked={draft.autoApprove}
              aria-label={t('settings.mcp.autoApprove')}
              onClick={() => setDraft({ ...draft, autoApprove: !draft.autoApprove })}
              className={cn(
                'relative mt-0.5 inline-flex h-[19px] w-[34px] shrink-0 items-center rounded-full border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#87947b]',
                draft.autoApprove ? 'border-[#526d59] bg-[#526d59]' : 'border-[#c9c9bf] bg-[#e7e6df]',
              )}
            >
              <span
                className={cn(
                  'size-3.5 rounded-full bg-white shadow-sm transition-transform',
                  draft.autoApprove ? 'translate-x-[16px]' : 'translate-x-[2px]',
                )}
              />
            </button>
            <span>
              <span className="block text-ink-secondary">{t('settings.mcp.autoApprove')}</span>
              <span className="mt-0.5 block text-2xs text-ink-quaternary">{t('settings.mcp.autoApproveHint')}</span>
            </span>
          </div>
        </div>
        <div className="flex justify-end px-4 pb-4">
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy === 'save' || !draft.name.trim() || !draft.target.trim()}
            className={buttonClass.primary}
          >
            {busy === 'save' ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t('settings.mcp.save')}
          </button>
        </div>
      </Section>

      {sources.length > 0 ? (
        <p className="mt-4 text-2xs text-ink-quaternary">
          {t('settings.mcp.sources', { files: sources.join('、') })}
        </p>
      ) : null}
    </div>
  );
}
