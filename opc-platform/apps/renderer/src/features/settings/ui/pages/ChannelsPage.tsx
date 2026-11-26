import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  MessageSquare,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserCheck,
  Users,
  X,
} from 'lucide-react';
import type {
  ChannelConnectionTestResult,
  ChannelDmPolicy,
  ChannelGroupPolicy,
  ChannelView,
  FeishuChannelSettingsPatch,
  FeishuDomain,
} from '@opc/shared/domain';
import {
  Note,
  PageHeader,
  Row,
  Section,
  SecretField,
  Segmented,
  StatusBadge,
  TextField,
  Toggle,
  buttonClass,
} from '../kit';

const FEISHU_RECOMMENDED_SCOPES = JSON.stringify(
  {
    scopes: {
      tenant: [
        'im:message',
        'im:message:send_as_bot',
        'im:message:readonly',
        'im:message.p2p_msg:readonly',
        'im:message.group_at_msg:readonly',
        'im:message.group_msg',
        'im:resource',
        'im:chat:readonly',
        'im:message.reactions:write_only',
        'contact:user.base:readonly',
      ],
      user: [],
    },
  },
  null,
  2,
);

function statusTone(state: ChannelView['status']['state']): 'green' | 'blue' | 'amber' | 'red' | 'gray' {
  switch (state) {
    case 'connected':
      return 'green';
    case 'connecting':
      return 'blue';
    case 'reconnecting':
      return 'amber';
    case 'error':
      return 'red';
    default:
      return 'gray';
  }
}

export function ChannelsPage() {
  const { t } = useTranslation();
  const [channels, setChannels] = useState<ChannelView[]>([]);
  const [loading, setLoading] = useState(true);
  const [guideOpen, setGuideOpen] = useState(false);
  const [scopesCopied, setScopesCopied] = useState(false);

  const [domainDraft, setDomainDraft] = useState<FeishuDomain>('feishu');
  const [appIdDraft, setAppIdDraft] = useState('');
  const [appSecretDraft, setAppSecretDraft] = useState('');
  const [savingCredentials, setSavingCredentials] = useState(false);
  const [testing, setTesting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [testResult, setTestResult] = useState<ChannelConnectionTestResult | null>(null);

  const [newDmId, setNewDmId] = useState('');
  const [newGroupId, setNewGroupId] = useState('');

  const syncDraftsFrom = useCallback((views: ChannelView[]) => {
    const feishu = views.find((item) => item.id === 'feishu');
    if (feishu) {
      setDomainDraft(feishu.settings.domain);
      setAppIdDraft(feishu.settings.appId);
    }
  }, []);

  useEffect(() => {
    const api = window.opc?.channels;
    if (!api) {
      setLoading(false);
      return;
    }

    let active = true;
    void api
      .list()
      .then((views) => {
        if (!active) return;
        setChannels(views);
        syncDraftsFrom(views);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    const unsub = api.onChanged((views) => {
      if (!active) return;
      setChannels(views);
    });

    return () => {
      active = false;
      unsub();
    };
  }, [syncDraftsFrom]);

  const feishu = channels.find((item) => item.id === 'feishu');

  const applyFeishuPatch = async (patch: FeishuChannelSettingsPatch) => {
    const api = window.opc?.channels;
    if (!api) return [];
    const next = await api.updateFeishu(patch);
    setChannels(next);
    return next;
  };

  const handleSaveCredentials = async () => {
    setSavingCredentials(true);
    setTestResult(null);
    try {
      const patch: FeishuChannelSettingsPatch = {
        domain: domainDraft,
        appId: appIdDraft.trim(),
        ...(appSecretDraft.trim() ? { appSecret: appSecretDraft.trim() } : {}),
      };
      await applyFeishuPatch(patch);
      setAppSecretDraft('');
    } finally {
      setSavingCredentials(false);
    }
  };

  const handleClearSecret = async () => {
    setSavingCredentials(true);
    setTestResult(null);
    try {
      await applyFeishuPatch({ appSecret: '' });
      setAppSecretDraft('');
    } finally {
      setSavingCredentials(false);
    }
  };

  const handleTestConnection = async () => {
    const api = window.opc?.channels;
    if (!api) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.testConnection('feishu', {
        domain: domainDraft,
        appId: appIdDraft.trim(),
        ...(appSecretDraft.trim() ? { appSecret: appSecretDraft.trim() } : {}),
      });
      setTestResult(result);
    } finally {
      setTesting(false);
    }
  };

  const handleReconnect = async () => {
    const api = window.opc?.channels;
    if (!api) return;
    setReconnecting(true);
    try {
      const next = await api.reconnect('feishu');
      setChannels(next);
    } finally {
      setReconnecting(false);
    }
  };

  const handleCopyScopes = () => {
    void navigator.clipboard.writeText(FEISHU_RECOMMENDED_SCOPES).then(() => {
      setScopesCopied(true);
      setTimeout(() => setScopesCopied(false), 1800);
    });
  };

  const handleAddAllowlist = async (kind: 'dm' | 'group', rawId: string) => {
    if (!feishu) return;
    const entry = rawId.trim();
    if (!entry) return;
    if (kind === 'dm') {
      if (!feishu.settings.access.dmAllowlist.includes(entry)) {
        await applyFeishuPatch({
          access: { dmAllowlist: [...feishu.settings.access.dmAllowlist, entry] },
        });
      }
      setNewDmId('');
      return;
    }
    if (!feishu.settings.access.groupAllowlist.includes(entry)) {
      await applyFeishuPatch({
        access: { groupAllowlist: [...feishu.settings.access.groupAllowlist, entry] },
      });
    }
    setNewGroupId('');
  };

  if (loading && !feishu) {
    return (
      <div>
        <PageHeader
          crumbs={[t('settings.title'), t('settings.group.channels')]}
          title={t('settings.page.channels')}
          description={t('settings.channels.description')}
        />
        <div className="rounded-xl border border-line bg-surface p-6 text-sm text-ink-tertiary">
          {t('common.loading')}
        </div>
      </div>
    );
  }

  const groupTargets = (feishu?.knownTargets ?? []).filter((item) => item.chatKind === 'group');

  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={[t('settings.title'), t('settings.group.channels')]}
        title={t('settings.page.channels')}
        description={t('settings.channels.description')}
      />

      {feishu ? (
        <>
          <Section
            title={t('settings.channels.feishu.title')}
            description={t('settings.channels.feishu.subtitle')}
            action={
              <div className="flex items-center gap-2.5">
                <StatusBadge
                  tone={statusTone(feishu.status.state)}
                  label={t(`settings.channels.state.${feishu.status.state}`)}
                />
                {feishu.settings.enabled ? (
                  <button
                    type="button"
                    disabled={reconnecting}
                    onClick={() => void handleReconnect()}
                    className={buttonClass.secondary}
                  >
                    <RefreshCw className={`size-3.5 ${reconnecting ? 'animate-spin' : ''}`} />
                    {t('settings.channels.actions.reconnect')}
                  </button>
                ) : null}
                <Toggle
                  checked={feishu.settings.enabled}
                  onChange={(enabled) => void applyFeishuPatch({ enabled })}
                  label={t('settings.channels.feishu.enableToggle')}
                />
              </div>
            }
          >
            {feishu.status.lastError ? (
              <div className="border-b border-line px-4 py-3">
                <Note tone="warn">{feishu.status.lastError}</Note>
              </div>
            ) : null}

            {feishu.status.botName ? (
              <Row label={t('settings.channels.feishu.botIdentity')}>
                <div className="flex items-center gap-2 text-xs text-ink-secondary">
                  <span className="font-medium text-ink">{feishu.status.botName}</span>
                  {feishu.status.botOpenId ? (
                    <code className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-2xs text-ink-tertiary">
                      {feishu.status.botOpenId}
                    </code>
                  ) : null}
                </div>
              </Row>
            ) : null}

            <div className="border-t border-line first:border-t-0">
              <button
                type="button"
                onClick={() => setGuideOpen((prev) => !prev)}
                className="flex w-full items-center justify-between px-4 py-2.5 text-left text-xs font-medium text-ink-secondary hover:bg-surface-muted/50"
              >
                <span className="flex items-center gap-1.5">
                  {guideOpen ? (
                    <ChevronDown className="size-3.5 text-ink-tertiary" />
                  ) : (
                    <ChevronRight className="size-3.5 text-ink-tertiary" />
                  )}
                  {t('settings.channels.feishu.guideTitle')}
                </span>
                <span className="text-2xs text-ink-quaternary">
                  {t('settings.channels.feishu.guideHint')}
                </span>
              </button>

              {guideOpen ? (
                <div className="space-y-3 border-t border-line bg-surface-muted/30 px-4 py-3 text-xs leading-relaxed text-ink-secondary">
                  <ol className="list-decimal space-y-1.5 pl-4">
                    <li>{t('settings.channels.feishu.step1')}</li>
                    <li>{t('settings.channels.feishu.step2')}</li>
                    <li>{t('settings.channels.feishu.step3')}</li>
                    <li>{t('settings.channels.feishu.step4')}</li>
                  </ol>
                  <div className="rounded-lg border border-line bg-surface p-2.5">
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-2xs font-medium text-ink-tertiary">
                        {t('settings.channels.feishu.scopesLabel')}
                      </span>
                      <button
                        type="button"
                        onClick={handleCopyScopes}
                        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs text-accent-ink hover:bg-accent-soft"
                      >
                        {scopesCopied ? (
                          <Check className="size-3" />
                        ) : (
                          <Copy className="size-3" />
                        )}
                        {scopesCopied ? t('common.copied') : t('settings.channels.feishu.copyScopes')}
                      </button>
                    </div>
                    <pre className="max-h-36 overflow-auto font-mono text-[11px] leading-snug text-ink-tertiary">
                      {FEISHU_RECOMMENDED_SCOPES}
                    </pre>
                  </div>
                </div>
              ) : null}
            </div>

            <Row
              label={t('settings.channels.feishu.domain')}
              hint={t('settings.channels.feishu.domainHint')}
            >
              <Segmented
                label={t('settings.channels.feishu.domain')}
                value={domainDraft}
                onChange={(next) => setDomainDraft(next as FeishuDomain)}
                options={[
                  { value: 'feishu', label: t('settings.channels.feishu.domainFeishu') },
                  { value: 'lark', label: t('settings.channels.feishu.domainLark') },
                ]}
              />
            </Row>

            <Row label={t('settings.channels.feishu.appId')} stacked>
              <TextField
                ariaLabel={t('settings.channels.feishu.appId')}
                value={appIdDraft}
                onChange={setAppIdDraft}
                placeholder="cli_xxxxxxxxxxxxxxxx"
                mono
              />
            </Row>

            <Row
              label={t('settings.channels.feishu.appSecret')}
              hint={
                feishu.settings.hasAppSecret
                  ? t('settings.channels.feishu.secretSavedHint')
                  : t('settings.channels.feishu.secretEmptyHint')
              }
              stacked
            >
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <SecretField
                    ariaLabel={t('settings.channels.feishu.appSecret')}
                    value={appSecretDraft}
                    onChange={setAppSecretDraft}
                    placeholder={
                      feishu.settings.hasAppSecret
                        ? t('settings.channels.feishu.secretSavedPlaceholder')
                        : t('settings.channels.feishu.secretPlaceholder')
                    }
                  />
                </div>
                {feishu.settings.hasAppSecret ? (
                  <button
                    type="button"
                    disabled={savingCredentials}
                    onClick={() => void handleClearSecret()}
                    className={buttonClass.danger}
                  >
                    {t('settings.channels.actions.clearSecret')}
                  </button>
                ) : null}
              </div>
            </Row>

            <Row label={t('settings.channels.feishu.credentialsActions')}>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={testing}
                  onClick={() => void handleTestConnection()}
                  className={buttonClass.secondary}
                >
                  {testing
                    ? t('settings.channels.actions.testing')
                    : t('settings.channels.actions.test')}
                </button>
                <button
                  type="button"
                  disabled={savingCredentials}
                  onClick={() => void handleSaveCredentials()}
                  className={buttonClass.primary}
                >
                  {savingCredentials
                    ? t('settings.channels.actions.saving')
                    : t('settings.channels.actions.save')}
                </button>
              </div>
            </Row>

            {testResult ? (
              <div className="border-t border-line px-4 py-3">
                <Note tone={testResult.ok ? 'info' : 'warn'}>
                  {testResult.ok
                    ? t('settings.channels.testSuccess', {
                        bot: testResult.botName ?? 'Feishu Bot',
                        ms: testResult.latencyMs,
                      })
                    : t('settings.channels.testFailed', {
                        error: testResult.error ?? 'Unknown error',
                      })}
                </Note>
              </div>
            ) : null}
          </Section>

          <Section
            title={t('settings.channels.access.title')}
            description={t('settings.channels.access.desc')}
          >
            {feishu.pendingPairings.length > 0 ? (
              <div className="border-b border-line bg-accent-soft/25 px-4 py-3">
                <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-ink">
                  <UserCheck className="size-3.5 text-accent-ink" />
                  <span>
                    {t('settings.channels.pairing.pendingTitle', {
                      count: feishu.pendingPairings.length,
                    })}
                  </span>
                </div>
                <div className="space-y-2">
                  {feishu.pendingPairings.map((req) => (
                    <div
                      key={req.id}
                      className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface px-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-xs font-medium text-ink">
                          <span>{req.senderName}</span>
                          <code className="font-mono text-2xs text-ink-quaternary">
                            {req.senderId}
                          </code>
                        </div>
                        {req.firstMessagePreview ? (
                          <p className="mt-0.5 truncate text-2xs text-ink-tertiary">
                            “{req.firstMessagePreview}”
                          </p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => void window.opc?.channels.approvePairing(req.id)}
                          className={buttonClass.primary}
                        >
                          <Check className="size-3.5" />
                          {t('settings.channels.pairing.approve')}
                        </button>
                        <button
                          type="button"
                          onClick={() => void window.opc?.channels.rejectPairing(req.id)}
                          className={buttonClass.secondary}
                        >
                          <X className="size-3.5" />
                          {t('settings.channels.pairing.reject')}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <Row
              label={t('settings.channels.access.dmPolicy')}
              hint={t('settings.channels.access.dmPolicyHint')}
            >
              <Segmented
                label={t('settings.channels.access.dmPolicy')}
                value={feishu.settings.access.dmPolicy}
                onChange={(dmPolicy) =>
                  void applyFeishuPatch({ access: { dmPolicy: dmPolicy as ChannelDmPolicy } })
                }
                options={[
                  { value: 'pairing', label: t('settings.channels.access.dmPairing') },
                  { value: 'allowlist', label: t('settings.channels.access.dmAllowlist') },
                  { value: 'open', label: t('settings.channels.access.dmOpen') },
                ]}
              />
            </Row>

            <Row
              label={t('settings.channels.access.dmListTitle')}
              hint={t('settings.channels.access.dmListHint')}
              stacked
            >
              <div className="space-y-2">
                {feishu.settings.access.dmAllowlist.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {feishu.settings.access.dmAllowlist.map((id) => (
                      <span
                        key={id}
                        className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-muted px-2.5 py-0.5 font-mono text-2xs text-ink-secondary"
                      >
                        {id}
                        <button
                          type="button"
                          aria-label={t('settings.channels.actions.remove')}
                          onClick={() =>
                            void window.opc?.channels.removeAllowlistEntry('feishu', 'dm', id)
                          }
                          className="text-ink-quaternary hover:text-danger"
                        >
                          <X className="size-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-2xs text-ink-quaternary">
                    {t('settings.channels.access.emptyAllowlist')}
                  </p>
                )}
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <TextField
                      ariaLabel={t('settings.channels.access.addDmPlaceholder')}
                      value={newDmId}
                      onChange={setNewDmId}
                      placeholder={t('settings.channels.access.addDmPlaceholder')}
                      mono
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleAddAllowlist('dm', newDmId)}
                    className={buttonClass.secondary}
                  >
                    <Plus className="size-3.5" />
                    {t('settings.channels.actions.add')}
                  </button>
                </div>
              </div>
            </Row>

            <Row
              label={t('settings.channels.access.groupPolicy')}
              hint={t('settings.channels.access.groupPolicyHint')}
            >
              <Segmented
                label={t('settings.channels.access.groupPolicy')}
                value={feishu.settings.access.groupPolicy}
                onChange={(groupPolicy) =>
                  void applyFeishuPatch({
                    access: { groupPolicy: groupPolicy as ChannelGroupPolicy },
                  })
                }
                options={[
                  { value: 'mention', label: t('settings.channels.access.groupMention') },
                  { value: 'allowlist', label: t('settings.channels.access.groupAllowlist') },
                  { value: 'open', label: t('settings.channels.access.groupOpen') },
                  { value: 'disabled', label: t('settings.channels.access.groupDisabled') },
                ]}
              />
            </Row>

            <Row
              label={t('settings.channels.access.groupListTitle')}
              hint={t('settings.channels.access.groupListHint')}
              stacked
            >
              <div className="space-y-2">
                {feishu.settings.access.groupAllowlist.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {feishu.settings.access.groupAllowlist.map((id) => (
                      <span
                        key={id}
                        className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-muted px-2.5 py-0.5 font-mono text-2xs text-ink-secondary"
                      >
                        {id}
                        <button
                          type="button"
                          aria-label={t('settings.channels.actions.remove')}
                          onClick={() =>
                            void window.opc?.channels.removeAllowlistEntry('feishu', 'group', id)
                          }
                          className="text-ink-quaternary hover:text-danger"
                        >
                          <X className="size-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : null}

                {groupTargets.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5 text-2xs text-ink-tertiary">
                    <span>{t('settings.channels.access.discoveredGroups')}</span>
                    {groupTargets.map((grp) => {
                      const rawId = grp.address.replace(/^feishu:chat:/, '');
                      const added = feishu.settings.access.groupAllowlist.includes(rawId);
                      return (
                        <button
                          key={grp.address}
                          type="button"
                          disabled={added}
                          onClick={() => void handleAddAllowlist('group', rawId)}
                          className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-0.5 text-2xs text-ink-secondary hover:border-accent disabled:opacity-50"
                        >
                          <Users className="size-3" />
                          {grp.title}
                          {added ? ' ✓' : ' +'}
                        </button>
                      );
                    })}
                  </div>
                ) : null}

                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <TextField
                      ariaLabel={t('settings.channels.access.addGroupPlaceholder')}
                      value={newGroupId}
                      onChange={setNewGroupId}
                      placeholder={t('settings.channels.access.addGroupPlaceholder')}
                      mono
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleAddAllowlist('group', newGroupId)}
                    className={buttonClass.secondary}
                  >
                    <Plus className="size-3.5" />
                    {t('settings.channels.actions.add')}
                  </button>
                </div>
              </div>
            </Row>
          </Section>

          <Section
            title={t('settings.channels.behavior.title')}
            description={t('settings.channels.behavior.desc')}
          >
            <Row
              label={t('settings.channels.behavior.mirrorLabel')}
              hint={t('settings.channels.behavior.mirrorHint')}
            >
              <Toggle
                checked={feishu.settings.mirrorToDesktop}
                onChange={(mirrorToDesktop) => void applyFeishuPatch({ mirrorToDesktop })}
                label={t('settings.channels.behavior.mirrorLabel')}
              />
            </Row>

            <Row
              label={t('settings.channels.behavior.thinkingLabel')}
              hint={t('settings.channels.behavior.thinkingHint')}
            >
              <Toggle
                checked={feishu.settings.thinkingReaction}
                onChange={(thinkingReaction) => void applyFeishuPatch({ thinkingReaction })}
                label={t('settings.channels.behavior.thinkingLabel')}
              />
            </Row>
          </Section>

          <Section
            title={t('settings.channels.targets.title')}
            description={t('settings.channels.targets.desc')}
          >
            {feishu.knownTargets.length === 0 ? (
              <div className="px-4 py-4 text-xs text-ink-quaternary">
                {t('settings.channels.targets.empty')}
              </div>
            ) : (
              <div>
                {feishu.knownTargets.map((target) => (
                  <Row
                    key={target.address}
                    label={
                      <span className="flex items-center gap-2">
                        {target.chatKind === 'group' ? (
                          <Users className="size-3.5 text-ink-tertiary" />
                        ) : (
                          <MessageSquare className="size-3.5 text-ink-tertiary" />
                        )}
                        <span>{target.title}</span>
                      </span>
                    }
                    hint={target.address}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        void window.opc?.channels.forgetTarget('feishu', target.address)
                      }
                      aria-label={t('settings.channels.actions.forget')}
                      className={buttonClass.secondary}
                    >
                      <Trash2 className="size-3.5" />
                      {t('settings.channels.actions.forget')}
                    </button>
                  </Row>
                ))}
              </div>
            )}
          </Section>

          <Note tone="info">
            <span className="inline-flex items-center gap-1.5">
              <ShieldCheck className="size-3.5 shrink-0" />
              {t('settings.channels.extensibilityNote')}
            </span>
          </Note>
        </>
      ) : null}
    </div>
  );
}
