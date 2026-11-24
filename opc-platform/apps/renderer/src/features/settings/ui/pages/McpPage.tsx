import { useCallback, useEffect, useState } from 'react';
import {
  ChevronDown,
  KeyRound,
  Loader2,
  LogOut,
  Plug,
  Plus,
  RefreshCw,
  RotateCw,
  Trash2,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { McpServerView, McpToolView } from '@opc/shared/ipc';
import { StatStrip } from '@/features/capabilities/ui/CapabilityPrimitives';
import {
  buttonClass,
  PageHeader,
  Section,
  StatusBadge,
  Toggle,
} from '@/features/settings/ui/kit';
import { cn } from '@/shared/lib/cn';
import { Select } from '@/shared/ui/Select';

interface Draft {
  name: string;
  transport: 'stdio' | 'http';
  target: string;
  exposure: 'deferred' | 'direct' | 'hidden';
  autoApprove: boolean;
  description: string;
}

const EMPTY: Draft = {
  name: '',
  transport: 'stdio',
  target: '',
  exposure: 'deferred',
  autoApprove: false,
  description: '',
};

/**
 * 外部能力（MCP）设置页：`mcp.json` 编辑器、连通性测试与高风险工具策略。
 */
export function McpPage() {
  const { t } = useTranslation();
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [showAddForm, setShowAddForm] = useState(false);
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
      setShowAddForm(false);
      setNotice(t('settings.mcp.saved'));
      setError(null);
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
          : t('settings.mcp.testOk', {
              name,
              tools: result.tools ?? 0,
              resources: result.resources ?? 0,
            }),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

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
      setNotice(
        t(
          enabled
            ? 'settings.mcp.autoApproveEnabledNotice'
            : 'settings.mcp.autoApproveDisabledNotice',
          { name },
        ),
      );
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
      setToolsError((previous) => ({
        ...previous,
        [name]: caught instanceof Error ? caught.message : String(caught),
      }));
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
      setNotice(
        t(enabled ? 'settings.mcp.toolAutoApproveEnabled' : 'settings.mcp.toolAutoApproveDisabled', {
          tool: tool.title ?? tool.name,
        }),
      );
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
        [server.name]: (previous[server.name] ?? []).map((tool) => ({
          ...tool,
          autoApprove: enabled,
          overridden: false,
        })),
      }));
      setServers((previous) =>
        previous.map((item) =>
          item.name === server.name ? { ...item, autoApprove: enabled } : item,
        ),
      );
      setNotice(t('settings.mcp.toolsBulkNotice', { name: server.name }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const enabledCount = servers.filter((server) => server.enabled).length;
  const autoApproveCount = servers.filter((server) => server.autoApprove).length;
  const addFormVisible = showAddForm || (!loading && servers.length === 0);

  return (
    <>
      <PageHeader
        crumbs={[t('settings.group.capabilities'), 'MCP']}
        title={t('settings.mcp.title')}
        description={t('settings.mcp.description')}
        actions={
          <>
            <button
              type="button"
              onClick={() => void load()}
              className={buttonClass.secondary}
              disabled={loading}
            >
              <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
              {t('attention.refresh')}
            </button>
            <button
              type="button"
              onClick={() => setShowAddForm((open) => !open)}
              className={buttonClass.primary}
            >
              <Plus className="size-3.5" />
              {t('settings.mcp.addButton')}
            </button>
          </>
        }
      />

      {error ? (
        <div className="mb-4 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="mb-4 rounded-xl border border-line bg-surface-muted/50 px-4 py-2.5 text-sm text-ink-secondary">
          {notice}
        </div>
      ) : null}

      <div className="space-y-5">
        <StatStrip
          items={[
            { label: t('settings.mcp.statTotal'), value: servers.length },
            { label: t('settings.mcp.statEnabled'), value: enabledCount, accent: enabledCount > 0 },
            { label: t('settings.mcp.statAutoApprove'), value: autoApproveCount },
          ]}
        />

        {addFormVisible ? (
          <Section
            title={t('settings.mcp.add')}
            description={t('settings.mcp.addHint')}
            action={
              servers.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setShowAddForm(false)}
                  aria-label={t('common.close')}
                  className="rounded-md p-1 text-ink-tertiary transition-colors hover:bg-surface-muted hover:text-ink"
                >
                  <X className="size-4" />
                </button>
              ) : null
            }
          >
            <div className="grid gap-3 px-4 py-4 sm:grid-cols-[11rem_7.5rem_1fr]">
              <label className="block text-xs text-ink-tertiary">
                {t('settings.mcp.name')}
                <input
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  placeholder="github"
                  className="mt-1 h-8 w-full rounded-lg border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-accent"
                />
              </label>
              <label className="block text-xs text-ink-tertiary">
                {t('settings.mcp.transport')}
                <Select
                  ariaLabel={t('settings.mcp.transport')}
                  value={draft.transport}
                  onValueChange={(value) =>
                    setDraft({ ...draft, transport: value === 'http' ? 'http' : 'stdio' })
                  }
                  className="mt-1"
                  options={[
                    { value: 'stdio', label: 'stdio' },
                    { value: 'http', label: 'HTTP' },
                  ]}
                />
              </label>
              <label className="block text-xs text-ink-tertiary">
                {draft.transport === 'stdio' ? t('settings.mcp.command') : t('settings.mcp.url')}
                <input
                  value={draft.target}
                  onChange={(event) => setDraft({ ...draft, target: event.target.value })}
                  placeholder={
                    draft.transport === 'stdio'
                      ? 'npx -y @modelcontextprotocol/server-filesystem .'
                      : 'https://example.com/mcp'
                  }
                  className="mt-1 h-8 w-full rounded-lg border border-line bg-surface px-2.5 font-mono text-xs text-ink outline-none focus:border-accent"
                />
              </label>
              <label className="block text-xs text-ink-tertiary sm:col-span-2">
                {t('settings.mcp.descriptionField')}
                <input
                  value={draft.description}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                  placeholder={t('settings.mcp.descriptionPlaceholder')}
                  className="mt-1 h-8 w-full rounded-lg border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-accent"
                />
              </label>
              <label className="block text-xs text-ink-tertiary">
                {t('settings.mcp.exposureField')}
                <Select
                  ariaLabel={t('settings.mcp.exposureField')}
                  value={draft.exposure}
                  onValueChange={(value) =>
                    setDraft({
                      ...draft,
                      exposure:
                        value === 'direct' || value === 'hidden' ? value : 'deferred',
                    })
                  }
                  className="mt-1"
                  options={[
                    { value: 'deferred', label: t('settings.mcp.exposure.deferred') },
                    { value: 'direct', label: t('settings.mcp.exposure.direct') },
                    { value: 'hidden', label: t('settings.mcp.exposure.hidden') },
                  ]}
                />
              </label>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-surface-muted/25 px-4 py-3">
              <div className="flex items-center gap-2.5">
                <Toggle
                  checked={draft.autoApprove}
                  onChange={(autoApprove) => setDraft({ ...draft, autoApprove })}
                  label={t('settings.mcp.autoApprove')}
                />
                <div>
                  <span className="block text-xs font-medium text-ink">
                    {t('settings.mcp.autoApprove')}
                  </span>
                  <span className="block text-3xs text-ink-quaternary">
                    {t('settings.mcp.autoApproveHint')}
                  </span>
                </div>
              </div>
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
        ) : null}

        <Section title={t('settings.mcp.installed')} description={t('settings.mcp.installedHint')}>
          {servers.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-ink-tertiary">
              {t('settings.mcp.empty')}
            </p>
          ) : (
            <div className="space-y-3 p-4">
              {servers.map((server) => (
                <article
                  key={server.name}
                  className="overflow-hidden rounded-xl border border-line bg-surface"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3.5">
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      <span
                        className={cn(
                          'grid size-9 shrink-0 place-items-center rounded-lg border',
                          server.enabled
                            ? 'border-accent/20 bg-accent-soft text-accent-ink'
                            : 'border-line bg-surface-muted text-ink-tertiary',
                        )}
                      >
                        <Plug className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h4 className="truncate text-sm font-semibold text-ink">{server.name}</h4>
                          <StatusBadge
                            tone={server.enabled ? 'green' : 'gray'}
                            label={
                              server.enabled
                                ? t('settings.mcp.enabled')
                                : t('settings.mcp.disabled')
                            }
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
                        <div className="mt-1.5 flex flex-wrap items-center gap-2">
                          <code className="max-w-full truncate rounded bg-surface-muted/70 px-2 py-0.5 font-mono text-3xs text-ink-secondary">
                            {server.target}
                          </code>
                          {server.tools !== undefined ? (
                            <span className="text-3xs text-ink-tertiary tabular-nums">
                              {t('settings.mcp.counts', {
                                tools: server.tools,
                                resources: server.resources ?? 0,
                              })}
                            </span>
                          ) : null}
                        </div>
                        {server.error ? (
                          <div className="mt-1.5 text-xs text-danger">{server.error}</div>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => toggleTools(server.name)}
                        className={buttonClass.secondary}
                        aria-expanded={expanded === server.name}
                      >
                        {busy === `tools:${server.name}` ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <ChevronDown
                            className={cn(
                              'size-3.5 transition-transform',
                              expanded === server.name && 'rotate-180',
                            )}
                          />
                        )}
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
                            void (server.auth === 'signed-in'
                              ? signOut(server.name)
                              : signIn(server.name))
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
                          {server.auth === 'signed-in'
                            ? t('settings.mcp.signOut')
                            : t('settings.mcp.signIn')}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => void remove(server.name)}
                        disabled={busy === `remove:${server.name}`}
                        aria-label={`${t('common.remove')} ${server.name}`}
                        className={cn(
                          buttonClass.secondary,
                          'px-2 text-ink-tertiary hover:border-danger/40 hover:text-danger',
                        )}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-3 border-t border-line/70 bg-surface-muted/20 px-4 py-2.5">
                    <span className="text-xs text-ink-secondary">
                      {server.autoApprove
                        ? t('settings.mcp.autoApproveOn')
                        : t('settings.mcp.autoApproveOff')}
                    </span>
                    <Toggle
                      checked={server.autoApprove}
                      disabled={busy === `approval:${server.name}`}
                      onChange={(next) => void setAutoApprove(server.name, next)}
                      label={`${server.name}: ${t('settings.mcp.autoApprove')}`}
                    />
                  </div>

                  {expanded === server.name ? (
                    <div className="border-t border-line bg-surface-muted/35 px-4 py-3.5">
                      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
                        <span className="text-3xs font-semibold tracking-[0.08em] text-ink-quaternary uppercase">
                          {t('settings.mcp.highImpactTools')}
                        </span>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            className={buttonClass.secondary}
                            onClick={() => void bulkToolApproval(server, true)}
                            disabled={busy === `bulk:${server.name}`}
                          >
                            {t('settings.mcp.allAutoApprove')}
                          </button>
                          <button
                            type="button"
                            className={buttonClass.secondary}
                            onClick={() => void bulkToolApproval(server, false)}
                            disabled={busy === `bulk:${server.name}`}
                          >
                            {t('settings.mcp.allRequireApproval')}
                          </button>
                          <button
                            type="button"
                            className={buttonClass.secondary}
                            onClick={() => void loadTools(server.name)}
                            disabled={busy === `tools:${server.name}`}
                            aria-label={t('attention.refresh')}
                          >
                            <RotateCw
                              className={cn(
                                'size-3.5',
                                busy === `tools:${server.name}` && 'animate-spin',
                              )}
                            />
                          </button>
                        </div>
                      </div>

                      {toolsError[server.name] ? (
                        <div className="text-xs text-danger">{toolsError[server.name]}</div>
                      ) : null}
                      {!toolsError[server.name] && tools[server.name]?.length === 0 ? (
                        <div className="text-xs text-ink-tertiary">
                          {t('settings.mcp.noHighImpactTools')}
                        </div>
                      ) : null}

                      <div className="space-y-1.5">
                        {(tools[server.name] ?? []).map((tool) => (
                          <div
                            key={tool.name}
                            className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface px-3 py-2"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-xs font-medium text-ink">
                                {tool.title ?? tool.name}
                              </div>
                              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-3xs text-ink-quaternary">
                                <code className="truncate font-mono">{tool.name}</code>
                                {tool.risk.map((risk) => (
                                  <span
                                    key={risk}
                                    className="rounded border border-warning/35 bg-warning/10 px-1.5 py-px text-warning"
                                  >
                                    {t(`settings.mcp.risk.${risk}`)}
                                  </span>
                                ))}
                                {tool.overridden ? (
                                  <span>{t('settings.mcp.customOverride')}</span>
                                ) : null}
                              </div>
                            </div>
                            <Toggle
                              checked={tool.autoApprove}
                              disabled={busy === `tool:${server.name}:${tool.name}`}
                              onChange={(next) => void setToolAutoApprove(server.name, tool, next)}
                              label={`${tool.name}: ${t('settings.mcp.autoApprove')}`}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          )}
        </Section>

        {sources.length > 0 ? (
          <p className="text-2xs text-ink-quaternary">
            {t('settings.mcp.sources', { files: sources.join('、') })}
          </p>
        ) : null}
      </div>
    </>
  );
}
