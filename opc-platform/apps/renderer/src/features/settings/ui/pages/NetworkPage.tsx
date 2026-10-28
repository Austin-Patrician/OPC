import { useCallback, useEffect, useState } from 'react';
import { Activity, Loader2, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  ProxyConfig,
  ProxyConfigInput,
  ProxyMode,
  ProxyProtocol,
  ProxyTestResult,
} from '@opc/shared/domain';
import { cn } from '@/shared/lib/cn';
import {
  buttonClass,
  Note,
  PageHeader,
  Row,
  SecretField,
  Section,
  Segmented,
  StatusBadge,
  TextField,
} from '../kit';

/** Strips Electron's IPC wrapper so the boss sees the real reason. */
function reasonOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
}

/**
 * Settings → 网络 → 网络与代理.
 *
 * One form, one save, like the company page: the drafts only reach the network
 * when 保存 runs, because a half-typed host would otherwise break every outgoing
 * request the moment it was written.
 *
 * The page never receives the stored password — only `hasPassword`. Leaving the
 * field empty keeps the old secret, typing replaces it, and the explicit link
 * clears it; that is the same three-state contract the main process implements.
 */
export function NetworkPage() {
  const { t } = useTranslation();

  const [config, setConfig] = useState<ProxyConfig | null>(null);
  const [mode, setMode] = useState<ProxyMode>('system');
  const [protocol, setProtocol] = useState<ProxyProtocol>('http');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('7890');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [bypass, setBypass] = useState('');

  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ProxyTestResult | null>(null);

  const syncDrafts = useCallback((next: ProxyConfig) => {
    setConfig(next);
    setMode(next.mode);
    setProtocol(next.protocol);
    setHost(next.host);
    setPort(String(next.port));
    setUsername(next.username);
    // The secret is write-only: an empty box means "keep what is stored".
    setPassword('');
    setClearPassword(false);
    setBypass(next.bypass);
  }, []);

  useEffect(() => {
    const bridge = window.opc?.network;
    if (!bridge) {
      setLoadError(t('settings.network.unavailable'));
      return;
    }

    let cancelled = false;
    void bridge
      .get()
      .then((next) => {
        if (!cancelled) syncDrafts(next);
      })
      .catch((failure: unknown) => {
        if (!cancelled) setLoadError(reasonOf(failure));
      });

    // Another window saving is a real event; the storage is the single truth.
    const off = bridge.onChanged((next) => {
      if (!cancelled) syncDrafts(next);
    });

    return () => {
      cancelled = true;
      off();
    };
  }, [syncDrafts, t]);

  const dirty =
    config !== null &&
    (mode !== config.mode ||
      protocol !== config.protocol ||
      host !== config.host ||
      port !== String(config.port) ||
      username !== config.username ||
      bypass !== config.bypass ||
      password !== '' ||
      (clearPassword && config.hasPassword));

  const draft = (): ProxyConfigInput => ({
    mode,
    protocol,
    host,
    port: Number(port),
    username,
    bypass,
    ...(clearPassword ? { password: '' } : password === '' ? {} : { password }),
  });

  const discardChanges = () => {
    if (config) syncDrafts(config);
    setTestResult(null);
    setError(null);
    setSavedNotice(false);
  };

  const save = async () => {
    if (!dirty || saving) return;
    const bridge = window.opc?.network;
    if (!bridge) return;

    setSaving(true);
    setError(null);
    setTestResult(null);
    try {
      const next = await bridge.update(draft());
      syncDrafts(next);
      setSavedNotice(true);
    } catch (failure) {
      // `update()` persists before applying, so a failed apply still saved the
      // config. Re-read it so the form shows what is stored, not the stale draft.
      try {
        syncDrafts(await bridge.get());
        setSavedNotice(true);
      } catch {
        // Keep the form as-is; the apply error is the actionable part.
      }
      setError(reasonOf(failure));
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    const bridge = window.opc?.network;
    if (!bridge || testing) return;

    setTesting(true);
    setError(null);
    setTestResult(null);
    try {
      setTestResult(await bridge.test(draft()));
    } catch (failure) {
      setError(reasonOf(failure));
    } finally {
      setTesting(false);
    }
  };

  const modeHint =
    mode === 'system'
      ? t('settings.network.modeSystemHint')
      : mode === 'direct'
        ? t('settings.network.modeDirectHint')
        : t('settings.network.modeManualHint');

  return (
    <>
      <PageHeader
        crumbs={[t('settings.group.network'), t('settings.page.network')]}
        title={t('settings.page.network')}
        description={t('settings.network.description')}
        actions={
          <div className="flex items-center gap-2">
            <span
              aria-live="polite"
              className={cn('w-12 shrink-0 text-right text-2xs', dirty ? 'text-ink-tertiary' : 'text-success')}
            >
              {dirty ? t('settings.network.unsaved') : savedNotice ? t('settings.network.saved') : null}
            </span>
            <button
              type="button"
              data-testid="network-discard"
              disabled={!dirty || saving}
              onClick={discardChanges}
              className={buttonClass.secondary}
            >
              {t('settings.network.discard')}
            </button>
            <button
              type="button"
              data-testid="network-save"
              disabled={!dirty || saving}
              aria-busy={saving}
              onClick={() => void save()}
              className={buttonClass.primary}
            >
              <Loader2 className={cn('size-3.5 animate-spin', !saving && 'invisible')} />
              {t('common.save')}
            </button>
          </div>
        }
      />

      {loadError ? (
        <p className="mb-4 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{loadError}</p>
      ) : null}
      {error ? (
        <p className="mb-4 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>
      ) : null}

      <div className="space-y-4">
        <Section title={t('settings.network.modeTitle')} description={t('settings.network.modeDesc')}>
          <Row label={t('settings.network.mode')} hint={modeHint}>
            <Segmented
              value={mode}
              onChange={(next) => {
                setMode(next);
                setTestResult(null);
                setSavedNotice(false);
              }}
              label={t('settings.network.mode')}
              options={[
                { value: 'system', label: t('settings.network.modeSystem') },
                { value: 'direct', label: t('settings.network.modeDirect') },
                { value: 'manual', label: t('settings.network.modeManual') },
              ]}
            />
          </Row>

          {mode === 'manual' ? null : (
            <div className="border-t border-line px-4 py-3">
              <Note tone="info">
                {mode === 'system' ? t('settings.network.systemNote') : t('settings.network.directNote')}
              </Note>
            </div>
          )}
        </Section>

        <Section
          title={t('settings.network.serverTitle')}
          description={t('settings.network.serverDesc')}
          action={
            mode === 'manual' && config?.mode === 'manual' ? (
              <StatusBadge tone="green" label={t('settings.network.inUse')} />
            ) : null
          }
        >
          <Row label={t('settings.network.protocol')} hint={t('settings.network.protocolHint')} disabled={mode !== 'manual'}>
            <Segmented
              value={protocol}
              onChange={setProtocol}
              label={t('settings.network.protocol')}
              options={[
                { value: 'http', label: t('settings.network.protocolHttp') },
                { value: 'https', label: t('settings.network.protocolHttps') },
                { value: 'socks5', label: t('settings.network.protocolSocks5') },
              ]}
            />
          </Row>

          <Row label={t('settings.network.address')} hint={t('settings.network.addressHint')} disabled={mode !== 'manual'}>
            <div className="w-52">
              <TextField
                value={host}
                onChange={setHost}
                ariaLabel={t('settings.network.address')}
                placeholder={t('settings.network.hostPlaceholder')}
                mono
              />
            </div>
            <span className="text-sm text-ink-quaternary">:</span>
            <div className="w-20">
              <TextField
                value={port}
                onChange={setPort}
                ariaLabel={t('settings.network.port')}
                placeholder="7890"
                mono
              />
            </div>
          </Row>

          <Row label={t('settings.network.auth')} hint={t('settings.network.authHint')} disabled={mode !== 'manual'}>
            <div className="w-36">
              <TextField
                value={username}
                onChange={setUsername}
                ariaLabel={t('settings.network.username')}
                placeholder={t('settings.network.usernamePlaceholder')}
                mono
              />
            </div>
            <div className="w-44">
              <SecretField
                value={password}
                onChange={(next) => {
                  setPassword(next);
                  if (next !== '') setClearPassword(false);
                }}
                placeholder={
                  clearPassword
                    ? t('settings.network.passwordCleared')
                    : config?.hasPassword
                      ? t('settings.network.passwordSaved')
                      : t('settings.network.passwordEmpty')
                }
                ariaLabel={t('settings.network.password')}
              />
            </div>
            {config?.hasPassword && !clearPassword ? (
              <button
                type="button"
                onClick={() => {
                  setPassword('');
                  setClearPassword(true);
                  setSavedNotice(false);
                }}
                className="text-xs whitespace-nowrap text-ink-tertiary transition-colors hover:text-danger"
              >
                {t('settings.network.passwordClear')}
              </button>
            ) : null}
          </Row>

          <Row
            label={t('settings.network.bypass')}
            hint={t('settings.network.bypassHint')}
            disabled={mode !== 'manual'}
          >
            <div className="w-[21rem]">
              <TextField
                value={bypass}
                onChange={(next) => {
                  setBypass(next);
                  setTestResult(null);
                }}
                ariaLabel={t('settings.network.bypass')}
                placeholder="*.corp.example.com"
                mono
              />
            </div>
          </Row>
        </Section>

        <Section title={t('settings.network.testTitle')} description={t('settings.network.testDesc')}>
          <Row
            label={t('settings.network.test')}
            hint={mode === 'manual' ? t('settings.network.testHint') : t('settings.network.testNeedManual')}
          >
            <button
              type="button"
              data-testid="network-test"
              disabled={mode !== 'manual' || testing || !host.trim()}
              onClick={() => void runTest()}
              className={buttonClass.secondary}
            >
              {testing ? <Loader2 className="size-3.5 animate-spin" /> : <Activity className="size-3.5" />}
              {t('settings.network.testAction')}
            </button>
          </Row>

          {testResult ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
              <StatusBadge
                tone={testResult.ok ? 'green' : 'red'}
                label={testResult.ok ? t('settings.network.testOk') : t('settings.network.testFailed')}
              />
              <span className="min-w-0 flex-1 text-xs leading-relaxed text-ink-secondary">
                {testResult.message}
              </span>
              <span className="text-2xs text-ink-quaternary">{testResult.latencyMs} ms</span>
            </div>
          ) : null}
        </Section>

        <div className="flex items-start gap-2 rounded-lg bg-surface-muted px-3 py-2 text-xs leading-relaxed text-ink-tertiary">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
          <span>{t('settings.network.coverage')}</span>
        </div>
      </div>
    </>
  );
}
