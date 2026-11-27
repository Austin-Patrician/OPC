import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Lock,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  UserCheck,
  Users,
  X,
} from 'lucide-react';
import type {
  ChannelAccessConfig,
  ChannelConnectionTestResult,
  ChannelDmPolicy,
  ChannelGroupPolicy,
  ChannelPairingRequest,
  ChannelTargetView,
  ChannelView,
  DingTalkChannelSettingsPatch,
  DingTalkChannelView,
  FeishuChannelSettingsPatch,
  FeishuChannelView,
  FeishuDomain,
  SlackChannelSettingsPatch,
  SlackChannelView,
  TelegramChannelSettingsPatch,
  TelegramChannelView,
  WeComChannelSettingsPatch,
  WeComChannelView,
  GitHubChannelSettingsPatch,
  GitHubChannelView,
  GitHubRepoOption,
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
import { ChannelBrandIcon } from '@/shared/icons/ChannelBrandIcon';

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

const SLACK_APP_MANIFEST_YAML = `display_information:
  name: Buddy Assistant
features:
  bot_user:
    display_name: Buddy
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - channels:read
      - groups:history
      - groups:read
      - im:history
      - im:read
      - mpim:history
      - mpim:read
      - chat:write
      - files:read
      - files:write
      - reactions:write
      - users:read
settings:
  socket_mode_enabled: true
  event_subscriptions:
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
      - message.mpim
`;

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

function clampGitHubPollInterval(raw: string, fallback: number): number {
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(600, Math.max(30, Math.round(parsed)));
}

function useSavedNotice() {
  const [savedNotice, setSavedNotice] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const flashSaved = () => {
    setSavedNotice(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setSavedNotice(false);
    }, 2500);
  };

  const clearSaved = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setSavedNotice(false);
  };

  return { savedNotice, flashSaved, clearSaved };
}

function ChannelSaveRow({
  testing,
  saving,
  dirty,
  savedNotice,
  onTest,
  onSave,
}: {
  testing: boolean;
  saving: boolean;
  dirty: boolean;
  savedNotice: boolean;
  onTest: () => void;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Row label={t('settings.channels.feishu.credentialsActions')}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={testing}
          onClick={onTest}
          className={buttonClass.secondary}
        >
          {testing ? t('settings.channels.actions.testing') : t('settings.channels.actions.test')}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={onSave}
          className={buttonClass.primary}
        >
          {saving ? t('settings.channels.actions.saving') : t('settings.channels.actions.save')}
        </button>
        <span aria-live="polite" className="text-2xs">
          {dirty ? (
            <span className="text-warning">{t('settings.channels.actions.unsaved')}</span>
          ) : savedNotice ? (
            <span className="text-success">{t('settings.channels.actions.saved')}</span>
          ) : null}
        </span>
      </div>
    </Row>
  );
}

function extractGroupEntryId(channelId: ChannelView['id'], address: string): string {
  if (channelId === 'feishu') return address.replace(/^feishu:chat:/, '');
  if (channelId === 'dingtalk') return address.replace(/^dingtalk:group:/, '');
  if (channelId === 'slack') return address.replace(/^slack:channel:/, '');
  if (channelId === 'wecom') return address.replace(/^wecom:group:/, '');
  if (channelId === 'telegram') {
    return address.replace(/^telegram:chat:/, '').replace(/:topic:\d+$/, '');
  }
  if (channelId === 'github') {
    return address.replace(/^github:/, '').replace(/#\d+$/, '');
  }
  return address;
}

function ChannelAccessSection({
  channelId,
  access,
  pendingPairings,
  knownTargets,
  dmPlaceholder,
  groupPlaceholder,
  onPatchAccess,
}: {
  channelId: ChannelView['id'];
  access: ChannelAccessConfig;
  pendingPairings: readonly ChannelPairingRequest[];
  knownTargets: readonly ChannelTargetView[];
  dmPlaceholder: string;
  groupPlaceholder: string;
  onPatchAccess: (patch: Partial<ChannelAccessConfig>) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [newDmId, setNewDmId] = useState('');
  const [newGroupId, setNewGroupId] = useState('');

  const handleAddAllowlist = async (kind: 'dm' | 'group', rawId: string) => {
    const entry = rawId.trim();
    if (!entry) return;
    if (kind === 'dm') {
      if (!access.dmAllowlist.includes(entry)) {
        await onPatchAccess({ dmAllowlist: [...access.dmAllowlist, entry] });
      }
      setNewDmId('');
      return;
    }
    if (!access.groupAllowlist.includes(entry)) {
      await onPatchAccess({ groupAllowlist: [...access.groupAllowlist, entry] });
    }
    setNewGroupId('');
  };

  const groupTargets = knownTargets.filter((item) => item.chatKind === 'group');

  return (
    <Section
      title={t('settings.channels.access.title')}
      description={t('settings.channels.access.desc')}
    >
      {pendingPairings.length > 0 ? (
        <div className="border-b border-line bg-accent-soft/25 px-4 py-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-ink">
            <UserCheck className="size-3.5 text-accent-ink" />
            <span>
              {t('settings.channels.pairing.pendingTitle', {
                count: pendingPairings.length,
              })}
            </span>
          </div>
          <div className="space-y-2">
            {pendingPairings.map((req) => (
              <div
                key={req.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-xs font-medium text-ink">
                    <span>{req.senderName}</span>
                    <code className="font-mono text-2xs text-ink-quaternary">{req.senderId}</code>
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
          value={access.dmPolicy}
          onChange={(dmPolicy) => void onPatchAccess({ dmPolicy: dmPolicy as ChannelDmPolicy })}
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
          {access.dmAllowlist.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {access.dmAllowlist.map((id) => (
                <span
                  key={id}
                  className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-muted px-2.5 py-0.5 font-mono text-2xs text-ink-secondary"
                >
                  {id}
                  <button
                    type="button"
                    aria-label={t('settings.channels.actions.remove')}
                    onClick={() =>
                      void window.opc?.channels.removeAllowlistEntry(channelId, 'dm', id)
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
                ariaLabel={dmPlaceholder}
                value={newDmId}
                onChange={setNewDmId}
                placeholder={dmPlaceholder}
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
          value={access.groupPolicy}
          onChange={(groupPolicy) =>
            void onPatchAccess({ groupPolicy: groupPolicy as ChannelGroupPolicy })
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
          {access.groupAllowlist.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {access.groupAllowlist.map((id) => (
                <span
                  key={id}
                  className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-muted px-2.5 py-0.5 font-mono text-2xs text-ink-secondary"
                >
                  {id}
                  <button
                    type="button"
                    aria-label={t('settings.channels.actions.remove')}
                    onClick={() =>
                      void window.opc?.channels.removeAllowlistEntry(channelId, 'group', id)
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
                const rawId = extractGroupEntryId(channelId, grp.address);
                const added = access.groupAllowlist.includes(rawId);
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
                ariaLabel={groupPlaceholder}
                value={newGroupId}
                onChange={setNewGroupId}
                placeholder={groupPlaceholder}
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
  );
}

function ChannelTargetsSection({
  channelId,
  targets,
  emptyText,
}: {
  channelId: ChannelView['id'];
  targets: readonly ChannelTargetView[];
  emptyText: string;
}) {
  const { t } = useTranslation();

  return (
    <Section
      title={t('settings.channels.targets.title')}
      description={t('settings.channels.targets.desc')}
    >
      {targets.length === 0 ? (
        <div className="px-4 py-4 text-xs text-ink-quaternary">{emptyText}</div>
      ) : (
        <div>
          {targets.map((target) => (
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
                onClick={() => void window.opc?.channels.forgetTarget(channelId, target.address)}
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
  );
}

function FeishuChannelDetail({
  feishu,
  onChannelsUpdate,
}: {
  feishu: FeishuChannelView;
  onChannelsUpdate: (next: ChannelView[]) => void;
}) {
  const { t } = useTranslation();
  const [guideOpen, setGuideOpen] = useState(false);
  const [scopesCopied, setScopesCopied] = useState(false);

  const [domainDraft, setDomainDraft] = useState<FeishuDomain>(feishu.settings.domain);
  const [appIdDraft, setAppIdDraft] = useState(feishu.settings.appId);
  const [appSecretDraft, setAppSecretDraft] = useState('');
  const [savingCredentials, setSavingCredentials] = useState(false);
  const [testing, setTesting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [testResult, setTestResult] = useState<ChannelConnectionTestResult | null>(null);
  const { savedNotice, flashSaved, clearSaved } = useSavedNotice();

  useEffect(() => {
    setDomainDraft(feishu.settings.domain);
    setAppIdDraft(feishu.settings.appId);
  }, [feishu.settings.domain, feishu.settings.appId]);

  const feishuDirty =
    domainDraft !== feishu.settings.domain ||
    appIdDraft.trim() !== feishu.settings.appId ||
    appSecretDraft.trim().length > 0;

  const applyPatch = async (patch: FeishuChannelSettingsPatch) => {
    const api = window.opc?.channels;
    if (!api) return;
    const next = await api.updateFeishu(patch);
    onChannelsUpdate(next);
  };

  const handleSaveCredentials = async () => {
    setSavingCredentials(true);
    setTestResult(null);
    clearSaved();
    try {
      await applyPatch({
        domain: domainDraft,
        appId: appIdDraft.trim(),
        ...(appSecretDraft.trim() ? { appSecret: appSecretDraft.trim() } : {}),
      });
      setAppSecretDraft('');
      flashSaved();
    } finally {
      setSavingCredentials(false);
    }
  };

  const handleClearSecret = async () => {
    setSavingCredentials(true);
    setTestResult(null);
    try {
      await applyPatch({ appSecret: '' });
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
      onChannelsUpdate(await api.reconnect('feishu'));
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

  return (
    <div className="space-y-5">
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
              onChange={(enabled) => void applyPatch({ enabled })}
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
                    {scopesCopied ? <Check className="size-3" /> : <Copy className="size-3" />}
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

        <ChannelSaveRow
          testing={testing}
          saving={savingCredentials}
          dirty={feishuDirty}
          savedNotice={savedNotice}
          onTest={() => void handleTestConnection()}
          onSave={() => void handleSaveCredentials()}
        />

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

      <ChannelAccessSection
        channelId="feishu"
        access={feishu.settings.access}
        pendingPairings={feishu.pendingPairings}
        knownTargets={feishu.knownTargets}
        dmPlaceholder={t('settings.channels.access.addDmPlaceholder')}
        groupPlaceholder={t('settings.channels.access.addGroupPlaceholder')}
        onPatchAccess={(access) => applyPatch({ access })}
      />

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
            onChange={(mirrorToDesktop) => void applyPatch({ mirrorToDesktop })}
            label={t('settings.channels.behavior.mirrorLabel')}
          />
        </Row>

        <Row
          label={t('settings.channels.behavior.thinkingLabel')}
          hint={t('settings.channels.behavior.thinkingHint')}
        >
          <Toggle
            checked={feishu.settings.thinkingReaction}
            onChange={(thinkingReaction) => void applyPatch({ thinkingReaction })}
            label={t('settings.channels.behavior.thinkingLabel')}
          />
        </Row>
      </Section>

      <ChannelTargetsSection
        channelId="feishu"
        targets={feishu.knownTargets}
        emptyText={t('settings.channels.targets.empty')}
      />
    </div>
  );
}

function DingTalkChannelDetail({
  dingtalk,
  onChannelsUpdate,
}: {
  dingtalk: DingTalkChannelView;
  onChannelsUpdate: (next: ChannelView[]) => void;
}) {
  const { t } = useTranslation();
  const [guideOpen, setGuideOpen] = useState(false);

  const [clientIdDraft, setClientIdDraft] = useState(dingtalk.settings.clientId);
  const [clientSecretDraft, setClientSecretDraft] = useState('');
  const [robotCodeDraft, setRobotCodeDraft] = useState(dingtalk.settings.robotCode);
  const [savingCredentials, setSavingCredentials] = useState(false);
  const [testing, setTesting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [testResult, setTestResult] = useState<ChannelConnectionTestResult | null>(null);
  const { savedNotice, flashSaved, clearSaved } = useSavedNotice();

  useEffect(() => {
    setClientIdDraft(dingtalk.settings.clientId);
    setRobotCodeDraft(dingtalk.settings.robotCode);
  }, [dingtalk.settings.clientId, dingtalk.settings.robotCode]);

  const dingtalkDirty =
    clientIdDraft.trim() !== dingtalk.settings.clientId ||
    robotCodeDraft.trim() !== dingtalk.settings.robotCode ||
    clientSecretDraft.trim().length > 0;

  const applyPatch = async (patch: DingTalkChannelSettingsPatch) => {
    const api = window.opc?.channels;
    if (!api) return;
    const next = await api.updateDingTalk(patch);
    onChannelsUpdate(next);
  };

  const handleSaveCredentials = async () => {
    setSavingCredentials(true);
    setTestResult(null);
    clearSaved();
    try {
      await applyPatch({
        clientId: clientIdDraft.trim(),
        robotCode: robotCodeDraft.trim(),
        ...(clientSecretDraft.trim() ? { clientSecret: clientSecretDraft.trim() } : {}),
      });
      setClientSecretDraft('');
      flashSaved();
    } finally {
      setSavingCredentials(false);
    }
  };

  const handleClearSecret = async () => {
    setSavingCredentials(true);
    setTestResult(null);
    try {
      await applyPatch({ clientSecret: '' });
      setClientSecretDraft('');
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
      const result = await api.testConnection('dingtalk', {
        clientId: clientIdDraft.trim(),
        robotCode: robotCodeDraft.trim(),
        ...(clientSecretDraft.trim() ? { clientSecret: clientSecretDraft.trim() } : {}),
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
      onChannelsUpdate(await api.reconnect('dingtalk'));
    } finally {
      setReconnecting(false);
    }
  };

  return (
    <div className="space-y-5">
      <Section
        title={t('settings.channels.dingtalk.title')}
        description={t('settings.channels.dingtalk.subtitle')}
        action={
          <div className="flex items-center gap-2.5">
            <StatusBadge
              tone={statusTone(dingtalk.status.state)}
              label={t(`settings.channels.state.${dingtalk.status.state}`)}
            />
            {dingtalk.settings.enabled ? (
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
              checked={dingtalk.settings.enabled}
              onChange={(enabled) => void applyPatch({ enabled })}
              label={t('settings.channels.dingtalk.enableToggle')}
            />
          </div>
        }
      >
        {dingtalk.status.lastError ? (
          <div className="border-b border-line px-4 py-3">
            <Note tone="warn">{dingtalk.status.lastError}</Note>
          </div>
        ) : null}

        {dingtalk.status.botName ? (
          <Row label={t('settings.channels.dingtalk.botIdentity')}>
            <code className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-2xs text-ink-secondary">
              {dingtalk.status.botName}
            </code>
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
              {t('settings.channels.dingtalk.guideTitle')}
            </span>
            <span className="text-2xs text-ink-quaternary">
              {t('settings.channels.dingtalk.guideHint')}
            </span>
          </button>

          {guideOpen ? (
            <div className="space-y-2 border-t border-line bg-surface-muted/30 px-4 py-3 text-xs leading-relaxed text-ink-secondary">
              <ol className="list-decimal space-y-1.5 pl-4">
                <li>{t('settings.channels.dingtalk.step1')}</li>
                <li>{t('settings.channels.dingtalk.step2')}</li>
                <li>{t('settings.channels.dingtalk.step3')}</li>
                <li>{t('settings.channels.dingtalk.step4')}</li>
              </ol>
            </div>
          ) : null}
        </div>

        <Row label={t('settings.channels.dingtalk.clientId')} stacked>
          <TextField
            ariaLabel={t('settings.channels.dingtalk.clientId')}
            value={clientIdDraft}
            onChange={setClientIdDraft}
            placeholder="dingxxxxxxxxxxxxxxxx"
            mono
          />
        </Row>

        <Row
          label={t('settings.channels.dingtalk.clientSecret')}
          hint={
            dingtalk.settings.hasClientSecret
              ? t('settings.channels.dingtalk.secretSavedHint')
              : t('settings.channels.dingtalk.secretEmptyHint')
          }
          stacked
        >
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <SecretField
                ariaLabel={t('settings.channels.dingtalk.clientSecret')}
                value={clientSecretDraft}
                onChange={setClientSecretDraft}
                placeholder={
                  dingtalk.settings.hasClientSecret
                    ? t('settings.channels.dingtalk.secretSavedPlaceholder')
                    : t('settings.channels.dingtalk.secretPlaceholder')
                }
              />
            </div>
            {dingtalk.settings.hasClientSecret ? (
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

        <Row
          label={t('settings.channels.dingtalk.robotCode')}
          hint={t('settings.channels.dingtalk.robotCodeHint')}
          stacked
        >
          <TextField
            ariaLabel={t('settings.channels.dingtalk.robotCode')}
            value={robotCodeDraft}
            onChange={setRobotCodeDraft}
            placeholder={t('settings.channels.dingtalk.robotCodePlaceholder')}
            mono
          />
        </Row>

        <ChannelSaveRow
          testing={testing}
          saving={savingCredentials}
          dirty={dingtalkDirty}
          savedNotice={savedNotice}
          onTest={() => void handleTestConnection()}
          onSave={() => void handleSaveCredentials()}
        />

        {testResult ? (
          <div className="border-t border-line px-4 py-3">
            <Note tone={testResult.ok ? 'info' : 'warn'}>
              {testResult.ok
                ? t('settings.channels.testSuccess', {
                    bot: testResult.botName ?? 'DingTalk Bot',
                    ms: testResult.latencyMs,
                  })
                : t('settings.channels.testFailed', {
                    error: testResult.error ?? 'Unknown error',
                  })}
            </Note>
          </div>
        ) : null}
      </Section>

      <ChannelAccessSection
        channelId="dingtalk"
        access={dingtalk.settings.access}
        pendingPairings={dingtalk.pendingPairings}
        knownTargets={dingtalk.knownTargets}
        dmPlaceholder={t('settings.channels.dingtalk.addDmPlaceholder')}
        groupPlaceholder={t('settings.channels.dingtalk.addGroupPlaceholder')}
        onPatchAccess={(access) => applyPatch({ access })}
      />

      <Section
        title={t('settings.channels.behavior.title')}
        description={t('settings.channels.behavior.desc')}
      >
        <Row
          label={t('settings.channels.behavior.mirrorLabel')}
          hint={t('settings.channels.dingtalk.mirrorHint')}
        >
          <Toggle
            checked={dingtalk.settings.mirrorToDesktop}
            onChange={(mirrorToDesktop) => void applyPatch({ mirrorToDesktop })}
            label={t('settings.channels.behavior.mirrorLabel')}
          />
        </Row>
      </Section>

      <ChannelTargetsSection
        channelId="dingtalk"
        targets={dingtalk.knownTargets}
        emptyText={t('settings.channels.dingtalk.targetsEmpty')}
      />
    </div>
  );
}

function SlackChannelDetail({
  slack,
  onChannelsUpdate,
}: {
  slack: SlackChannelView;
  onChannelsUpdate: (next: ChannelView[]) => void;
}) {
  const { t } = useTranslation();
  const [guideOpen, setGuideOpen] = useState(false);
  const [manifestCopied, setManifestCopied] = useState(false);

  const [botTokenDraft, setBotTokenDraft] = useState('');
  const [appTokenDraft, setAppTokenDraft] = useState('');
  const [savingCredentials, setSavingCredentials] = useState(false);
  const [testing, setTesting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [testResult, setTestResult] = useState<ChannelConnectionTestResult | null>(null);
  const { savedNotice, flashSaved, clearSaved } = useSavedNotice();

  const slackDirty = botTokenDraft.trim().length > 0 || appTokenDraft.trim().length > 0;

  const applyPatch = async (patch: SlackChannelSettingsPatch) => {
    const api = window.opc?.channels;
    if (!api) return;
    const next = await api.updateSlack(patch);
    onChannelsUpdate(next);
  };

  const handleSaveCredentials = async () => {
    setSavingCredentials(true);
    setTestResult(null);
    clearSaved();
    try {
      await applyPatch({
        ...(botTokenDraft.trim() ? { botToken: botTokenDraft.trim() } : {}),
        ...(appTokenDraft.trim() ? { appToken: appTokenDraft.trim() } : {}),
      });
      setBotTokenDraft('');
      setAppTokenDraft('');
      flashSaved();
    } finally {
      setSavingCredentials(false);
    }
  };

  const handleClearToken = async (kind: 'botToken' | 'appToken') => {
    setSavingCredentials(true);
    setTestResult(null);
    try {
      await applyPatch(kind === 'botToken' ? { botToken: '' } : { appToken: '' });
      if (kind === 'botToken') setBotTokenDraft('');
      else setAppTokenDraft('');
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
      const result = await api.testConnection('slack', {
        ...(botTokenDraft.trim() ? { botToken: botTokenDraft.trim() } : {}),
        ...(appTokenDraft.trim() ? { appToken: appTokenDraft.trim() } : {}),
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
      onChannelsUpdate(await api.reconnect('slack'));
    } finally {
      setReconnecting(false);
    }
  };

  const handleCopyManifest = () => {
    void navigator.clipboard.writeText(SLACK_APP_MANIFEST_YAML).then(() => {
      setManifestCopied(true);
      setTimeout(() => setManifestCopied(false), 1800);
    });
  };

  return (
    <div className="space-y-5">
      <Section
        title={t('settings.channels.slack.title')}
        description={t('settings.channels.slack.subtitle')}
        action={
          <div className="flex items-center gap-2.5">
            <StatusBadge
              tone={statusTone(slack.status.state)}
              label={t(`settings.channels.state.${slack.status.state}`)}
            />
            {slack.settings.enabled ? (
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
              checked={slack.settings.enabled}
              onChange={(enabled) => void applyPatch({ enabled })}
              label={t('settings.channels.slack.enableToggle')}
            />
          </div>
        }
      >
        {slack.status.lastError ? (
          <div className="border-b border-line px-4 py-3">
            <Note tone="warn">{slack.status.lastError}</Note>
          </div>
        ) : null}

        {slack.status.botName ? (
          <Row label={t('settings.channels.slack.botIdentity')}>
            <div className="flex items-center gap-2 text-xs text-ink-secondary">
              <span className="font-medium text-ink">{slack.status.botName}</span>
              {slack.status.botOpenId ? (
                <code className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-2xs text-ink-tertiary">
                  {slack.status.botOpenId}
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
              {t('settings.channels.slack.guideTitle')}
            </span>
            <span className="text-2xs text-ink-quaternary">
              {t('settings.channels.slack.guideHint')}
            </span>
          </button>

          {guideOpen ? (
            <div className="space-y-3 border-t border-line bg-surface-muted/30 px-4 py-3 text-xs leading-relaxed text-ink-secondary">
              <ol className="list-decimal space-y-1.5 pl-4">
                <li>{t('settings.channels.slack.step1')}</li>
                <li>{t('settings.channels.slack.step2')}</li>
                <li>{t('settings.channels.slack.step3')}</li>
                <li>{t('settings.channels.slack.step4')}</li>
              </ol>
              <div className="rounded-lg border border-line bg-surface p-2.5">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-2xs font-medium text-ink-tertiary">
                    {t('settings.channels.slack.manifestLabel')}
                  </span>
                  <button
                    type="button"
                    onClick={handleCopyManifest}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs text-accent-ink hover:bg-accent-soft"
                  >
                    {manifestCopied ? (
                      <Check className="size-3" />
                    ) : (
                      <Copy className="size-3" />
                    )}
                    {manifestCopied
                      ? t('common.copied')
                      : t('settings.channels.slack.copyManifest')}
                  </button>
                </div>
                <pre className="max-h-40 overflow-auto font-mono text-[11px] leading-snug text-ink-tertiary">
                  {SLACK_APP_MANIFEST_YAML}
                </pre>
              </div>
            </div>
          ) : null}
        </div>

        <Row
          label={t('settings.channels.slack.botToken')}
          hint={
            slack.settings.hasBotToken
              ? t('settings.channels.slack.botTokenSavedHint')
              : t('settings.channels.slack.botTokenEmptyHint')
          }
          stacked
        >
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <SecretField
                ariaLabel={t('settings.channels.slack.botToken')}
                value={botTokenDraft}
                onChange={setBotTokenDraft}
                placeholder={
                  slack.settings.hasBotToken
                    ? t('settings.channels.slack.tokenSavedPlaceholder')
                    : 'xoxb-...'
                }
              />
            </div>
            {slack.settings.hasBotToken ? (
              <button
                type="button"
                disabled={savingCredentials}
                onClick={() => void handleClearToken('botToken')}
                className={buttonClass.danger}
              >
                {t('settings.channels.actions.clearSecret')}
              </button>
            ) : null}
          </div>
        </Row>

        <Row
          label={t('settings.channels.slack.appToken')}
          hint={
            slack.settings.hasAppToken
              ? t('settings.channels.slack.appTokenSavedHint')
              : t('settings.channels.slack.appTokenEmptyHint')
          }
          stacked
        >
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <SecretField
                ariaLabel={t('settings.channels.slack.appToken')}
                value={appTokenDraft}
                onChange={setAppTokenDraft}
                placeholder={
                  slack.settings.hasAppToken
                    ? t('settings.channels.slack.tokenSavedPlaceholder')
                    : 'xapp-...'
                }
              />
            </div>
            {slack.settings.hasAppToken ? (
              <button
                type="button"
                disabled={savingCredentials}
                onClick={() => void handleClearToken('appToken')}
                className={buttonClass.danger}
              >
                {t('settings.channels.actions.clearSecret')}
              </button>
            ) : null}
          </div>
        </Row>

        <ChannelSaveRow
          testing={testing}
          saving={savingCredentials}
          dirty={slackDirty}
          savedNotice={savedNotice}
          onTest={() => void handleTestConnection()}
          onSave={() => void handleSaveCredentials()}
        />

        {testResult ? (
          <div className="border-t border-line px-4 py-3">
            <Note tone={testResult.ok ? 'info' : 'warn'}>
              {testResult.ok
                ? t('settings.channels.testSuccess', {
                    bot: testResult.botName ?? 'Slack Bot',
                    ms: testResult.latencyMs,
                  })
                : t('settings.channels.testFailed', {
                    error: testResult.error ?? 'Unknown error',
                  })}
            </Note>
          </div>
        ) : null}
      </Section>

      <ChannelAccessSection
        channelId="slack"
        access={slack.settings.access}
        pendingPairings={slack.pendingPairings}
        knownTargets={slack.knownTargets}
        dmPlaceholder={t('settings.channels.slack.addDmPlaceholder')}
        groupPlaceholder={t('settings.channels.slack.addGroupPlaceholder')}
        onPatchAccess={(access) => applyPatch({ access })}
      />

      <Section
        title={t('settings.channels.behavior.title')}
        description={t('settings.channels.behavior.desc')}
      >
        <Row
          label={t('settings.channels.behavior.mirrorLabel')}
          hint={t('settings.channels.slack.mirrorHint')}
        >
          <Toggle
            checked={slack.settings.mirrorToDesktop}
            onChange={(mirrorToDesktop) => void applyPatch({ mirrorToDesktop })}
            label={t('settings.channels.behavior.mirrorLabel')}
          />
        </Row>

        <Row
          label={t('settings.channels.behavior.thinkingLabel')}
          hint={t('settings.channels.slack.thinkingHint')}
        >
          <Toggle
            checked={slack.settings.thinkingReaction}
            onChange={(thinkingReaction) => void applyPatch({ thinkingReaction })}
            label={t('settings.channels.behavior.thinkingLabel')}
          />
        </Row>

        <Row
          label={t('settings.channels.slack.replyInThreadLabel')}
          hint={t('settings.channels.slack.replyInThreadHint')}
        >
          <Toggle
            checked={slack.settings.replyInThread}
            onChange={(replyInThread) => void applyPatch({ replyInThread })}
            label={t('settings.channels.slack.replyInThreadLabel')}
          />
        </Row>
      </Section>

      <ChannelTargetsSection
        channelId="slack"
        targets={slack.knownTargets}
        emptyText={t('settings.channels.slack.targetsEmpty')}
      />
    </div>
  );
}

function WeComChannelDetail({
  wecom,
  onChannelsUpdate,
}: {
  wecom: WeComChannelView;
  onChannelsUpdate: (next: ChannelView[]) => void;
}) {
  const { t } = useTranslation();
  const [guideOpen, setGuideOpen] = useState(false);

  const [botIdDraft, setBotIdDraft] = useState(wecom.settings.botId);
  const [secretDraft, setSecretDraft] = useState('');
  const [savingCredentials, setSavingCredentials] = useState(false);
  const [testing, setTesting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [testResult, setTestResult] = useState<ChannelConnectionTestResult | null>(null);
  const { savedNotice, flashSaved, clearSaved } = useSavedNotice();

  useEffect(() => {
    setBotIdDraft(wecom.settings.botId);
  }, [wecom.settings.botId]);

  const wecomDirty =
    botIdDraft.trim() !== wecom.settings.botId || secretDraft.trim().length > 0;

  const applyPatch = async (patch: WeComChannelSettingsPatch) => {
    const api = window.opc?.channels;
    if (!api) return;
    const next = await api.updateWeCom(patch);
    onChannelsUpdate(next);
  };

  const handleSaveCredentials = async () => {
    setSavingCredentials(true);
    setTestResult(null);
    clearSaved();
    try {
      await applyPatch({
        botId: botIdDraft.trim(),
        ...(secretDraft.trim() ? { secret: secretDraft.trim() } : {}),
      });
      setSecretDraft('');
      flashSaved();
    } finally {
      setSavingCredentials(false);
    }
  };

  const handleClearSecret = async () => {
    setSavingCredentials(true);
    setTestResult(null);
    try {
      await applyPatch({ secret: '' });
      setSecretDraft('');
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
      const result = await api.testConnection('wecom', {
        botId: botIdDraft.trim(),
        ...(secretDraft.trim() ? { secret: secretDraft.trim() } : {}),
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
      onChannelsUpdate(await api.reconnect('wecom'));
    } finally {
      setReconnecting(false);
    }
  };

  return (
    <div className="space-y-5">
      <Section
        title={t('settings.channels.wecom.title')}
        description={t('settings.channels.wecom.subtitle')}
        action={
          <div className="flex items-center gap-2.5">
            <StatusBadge
              tone={statusTone(wecom.status.state)}
              label={t(`settings.channels.state.${wecom.status.state}`)}
            />
            {wecom.settings.enabled ? (
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
              checked={wecom.settings.enabled}
              onChange={(enabled) => void applyPatch({ enabled })}
              label={t('settings.channels.wecom.enableToggle')}
            />
          </div>
        }
      >
        {wecom.status.lastError ? (
          <div className="border-b border-line px-4 py-3">
            <Note tone="warn">{wecom.status.lastError}</Note>
          </div>
        ) : null}

        {wecom.status.botName ? (
          <Row label={t('settings.channels.wecom.botIdentity')}>
            <code className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-2xs text-ink-secondary">
              {wecom.status.botName}
            </code>
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
              {t('settings.channels.wecom.guideTitle')}
            </span>
            <span className="text-2xs text-ink-quaternary">
              {t('settings.channels.wecom.guideHint')}
            </span>
          </button>

          {guideOpen ? (
            <div className="space-y-3 border-t border-line bg-surface-muted/30 px-4 py-3 text-xs leading-relaxed text-ink-secondary">
              <ol className="list-decimal space-y-1.5 pl-4">
                <li>{t('settings.channels.wecom.step1')}</li>
                <li>{t('settings.channels.wecom.step2')}</li>
                <li>{t('settings.channels.wecom.step3')}</li>
                <li>{t('settings.channels.wecom.step4')}</li>
              </ol>
              <Note tone="info">{t('settings.channels.wecom.singleConnTip')}</Note>
            </div>
          ) : null}
        </div>

        <Row label={t('settings.channels.wecom.botId')} stacked>
          <TextField
            ariaLabel={t('settings.channels.wecom.botId')}
            value={botIdDraft}
            onChange={setBotIdDraft}
            placeholder={t('settings.channels.wecom.botIdPlaceholder')}
            mono
          />
        </Row>

        <Row
          label={t('settings.channels.wecom.secret')}
          hint={
            wecom.settings.hasSecret
              ? t('settings.channels.wecom.secretSavedHint')
              : t('settings.channels.wecom.secretEmptyHint')
          }
          stacked
        >
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <SecretField
                ariaLabel={t('settings.channels.wecom.secret')}
                value={secretDraft}
                onChange={setSecretDraft}
                placeholder={
                  wecom.settings.hasSecret
                    ? t('settings.channels.wecom.secretSavedPlaceholder')
                    : t('settings.channels.wecom.secretPlaceholder')
                }
              />
            </div>
            {wecom.settings.hasSecret ? (
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

        <ChannelSaveRow
          testing={testing}
          saving={savingCredentials}
          dirty={wecomDirty}
          savedNotice={savedNotice}
          onTest={() => void handleTestConnection()}
          onSave={() => void handleSaveCredentials()}
        />

        {testResult ? (
          <div className="border-t border-line px-4 py-3">
            <Note tone={testResult.ok ? 'info' : 'warn'}>
              {testResult.ok
                ? t('settings.channels.testSuccess', {
                    bot: testResult.botName ?? 'WeCom Bot',
                    ms: testResult.latencyMs,
                  })
                : t('settings.channels.testFailed', {
                    error: testResult.error ?? 'Unknown error',
                  })}
            </Note>
          </div>
        ) : null}
      </Section>

      <ChannelAccessSection
        channelId="wecom"
        access={wecom.settings.access}
        pendingPairings={wecom.pendingPairings}
        knownTargets={wecom.knownTargets}
        dmPlaceholder={t('settings.channels.wecom.addDmPlaceholder')}
        groupPlaceholder={t('settings.channels.wecom.addGroupPlaceholder')}
        onPatchAccess={(access) => applyPatch({ access })}
      />

      <Section
        title={t('settings.channels.behavior.title')}
        description={t('settings.channels.behavior.desc')}
      >
        <Row
          label={t('settings.channels.behavior.mirrorLabel')}
          hint={t('settings.channels.wecom.mirrorHint')}
        >
          <Toggle
            checked={wecom.settings.mirrorToDesktop}
            onChange={(mirrorToDesktop) => void applyPatch({ mirrorToDesktop })}
            label={t('settings.channels.behavior.mirrorLabel')}
          />
        </Row>

        <Row
          label={t('settings.channels.wecom.thinkingLabel')}
          hint={t('settings.channels.wecom.thinkingHint')}
        >
          <Toggle
            checked={wecom.settings.thinkingStream}
            onChange={(thinkingStream) => void applyPatch({ thinkingStream })}
            label={t('settings.channels.wecom.thinkingLabel')}
          />
        </Row>
      </Section>

      <ChannelTargetsSection
        channelId="wecom"
        targets={wecom.knownTargets}
        emptyText={t('settings.channels.wecom.targetsEmpty')}
      />
    </div>
  );
}

function TelegramChannelDetail({
  telegram,
  onChannelsUpdate,
}: {
  telegram: TelegramChannelView;
  onChannelsUpdate: (next: ChannelView[]) => void;
}) {
  const { t } = useTranslation();
  const [guideOpen, setGuideOpen] = useState(false);

  const [botTokenDraft, setBotTokenDraft] = useState('');
  const [apiBaseUrlDraft, setApiBaseUrlDraft] = useState(telegram.settings.apiBaseUrl);
  const [savingCredentials, setSavingCredentials] = useState(false);
  const [testing, setTesting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [testResult, setTestResult] = useState<ChannelConnectionTestResult | null>(null);
  const { savedNotice, flashSaved, clearSaved } = useSavedNotice();

  useEffect(() => {
    setApiBaseUrlDraft(telegram.settings.apiBaseUrl);
  }, [telegram.settings.apiBaseUrl]);

  const telegramDirty =
    apiBaseUrlDraft.trim() !== telegram.settings.apiBaseUrl || botTokenDraft.trim().length > 0;

  const applyPatch = async (patch: TelegramChannelSettingsPatch) => {
    const api = window.opc?.channels;
    if (!api) return;
    const next = await api.updateTelegram(patch);
    onChannelsUpdate(next);
  };

  const handleSaveCredentials = async () => {
    setSavingCredentials(true);
    setTestResult(null);
    clearSaved();
    try {
      await applyPatch({
        apiBaseUrl: apiBaseUrlDraft.trim(),
        ...(botTokenDraft.trim() ? { botToken: botTokenDraft.trim() } : {}),
      });
      setBotTokenDraft('');
      flashSaved();
    } finally {
      setSavingCredentials(false);
    }
  };

  const handleClearToken = async () => {
    setSavingCredentials(true);
    setTestResult(null);
    try {
      await applyPatch({ botToken: '' });
      setBotTokenDraft('');
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
      const result = await api.testConnection('telegram', {
        apiBaseUrl: apiBaseUrlDraft.trim(),
        ...(botTokenDraft.trim() ? { botToken: botTokenDraft.trim() } : {}),
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
      onChannelsUpdate(await api.reconnect('telegram'));
    } finally {
      setReconnecting(false);
    }
  };

  return (
    <div className="space-y-5">
      <Section
        title={t('settings.channels.telegram.title')}
        description={t('settings.channels.telegram.subtitle')}
        action={
          <div className="flex items-center gap-2.5">
            <StatusBadge
              tone={statusTone(telegram.status.state)}
              label={t(`settings.channels.state.${telegram.status.state}`)}
            />
            {telegram.settings.enabled ? (
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
              checked={telegram.settings.enabled}
              onChange={(enabled) => void applyPatch({ enabled })}
              label={t('settings.channels.telegram.enableToggle')}
            />
          </div>
        }
      >
        {telegram.status.lastError ? (
          <div className="border-b border-line px-4 py-3">
            <Note tone="warn">{telegram.status.lastError}</Note>
          </div>
        ) : null}

        {telegram.status.botName ? (
          <Row label={t('settings.channels.telegram.botIdentity')}>
            <div className="flex items-center gap-2 text-xs text-ink-secondary">
              <span className="font-medium text-ink">{telegram.status.botName}</span>
              {telegram.status.botOpenId ? (
                <code className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-2xs text-ink-tertiary">
                  {telegram.status.botOpenId}
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
              {t('settings.channels.telegram.guideTitle')}
            </span>
            <span className="text-2xs text-ink-quaternary">
              {t('settings.channels.telegram.guideHint')}
            </span>
          </button>

          {guideOpen ? (
            <div className="space-y-3 border-t border-line bg-surface-muted/30 px-4 py-3 text-xs leading-relaxed text-ink-secondary">
              <ol className="list-decimal space-y-1.5 pl-4">
                <li>{t('settings.channels.telegram.step1')}</li>
                <li>{t('settings.channels.telegram.step2')}</li>
                <li>{t('settings.channels.telegram.step3')}</li>
                <li>{t('settings.channels.telegram.step4')}</li>
              </ol>
              <Note tone="info">{t('settings.channels.telegram.privacyTip')}</Note>
            </div>
          ) : null}
        </div>

        <Row
          label={t('settings.channels.telegram.botToken')}
          hint={
            telegram.settings.hasBotToken
              ? t('settings.channels.telegram.tokenSavedHint')
              : t('settings.channels.telegram.tokenEmptyHint')
          }
          stacked
        >
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <SecretField
                ariaLabel={t('settings.channels.telegram.botToken')}
                value={botTokenDraft}
                onChange={setBotTokenDraft}
                placeholder={
                  telegram.settings.hasBotToken
                    ? t('settings.channels.telegram.tokenSavedPlaceholder')
                    : '123456789:ABCdef...'
                }
              />
            </div>
            {telegram.settings.hasBotToken ? (
              <button
                type="button"
                disabled={savingCredentials}
                onClick={() => void handleClearToken()}
                className={buttonClass.danger}
              >
                {t('settings.channels.actions.clearSecret')}
              </button>
            ) : null}
          </div>
        </Row>

        <Row
          label={t('settings.channels.telegram.apiBaseUrl')}
          hint={t('settings.channels.telegram.apiBaseUrlHint')}
          stacked
        >
          <TextField
            ariaLabel={t('settings.channels.telegram.apiBaseUrl')}
            value={apiBaseUrlDraft}
            onChange={setApiBaseUrlDraft}
            placeholder="https://api.telegram.org"
            mono
          />
        </Row>

        <ChannelSaveRow
          testing={testing}
          saving={savingCredentials}
          dirty={telegramDirty}
          savedNotice={savedNotice}
          onTest={() => void handleTestConnection()}
          onSave={() => void handleSaveCredentials()}
        />

        {testResult ? (
          <div className="border-t border-line px-4 py-3">
            <Note tone={testResult.ok ? 'info' : 'warn'}>
              {testResult.ok
                ? t('settings.channels.testSuccess', {
                    bot: testResult.botName ?? 'Telegram Bot',
                    ms: testResult.latencyMs,
                  })
                : t('settings.channels.testFailed', {
                    error: testResult.error ?? 'Unknown error',
                  })}
            </Note>
          </div>
        ) : null}
      </Section>

      <ChannelAccessSection
        channelId="telegram"
        access={telegram.settings.access}
        pendingPairings={telegram.pendingPairings}
        knownTargets={telegram.knownTargets}
        dmPlaceholder={t('settings.channels.telegram.addDmPlaceholder')}
        groupPlaceholder={t('settings.channels.telegram.addGroupPlaceholder')}
        onPatchAccess={(access) => applyPatch({ access })}
      />

      <Section
        title={t('settings.channels.behavior.title')}
        description={t('settings.channels.behavior.desc')}
      >
        <Row
          label={t('settings.channels.behavior.mirrorLabel')}
          hint={t('settings.channels.telegram.mirrorHint')}
        >
          <Toggle
            checked={telegram.settings.mirrorToDesktop}
            onChange={(mirrorToDesktop) => void applyPatch({ mirrorToDesktop })}
            label={t('settings.channels.behavior.mirrorLabel')}
          />
        </Row>

        <Row
          label={t('settings.channels.telegram.typingLabel')}
          hint={t('settings.channels.telegram.typingHint')}
        >
          <Toggle
            checked={telegram.settings.typingAction}
            onChange={(typingAction) => void applyPatch({ typingAction })}
            label={t('settings.channels.telegram.typingLabel')}
          />
        </Row>
      </Section>

      <ChannelTargetsSection
        channelId="telegram"
        targets={telegram.knownTargets}
        emptyText={t('settings.channels.telegram.targetsEmpty')}
      />
    </div>
  );
}

function GitHubChannelDetail({
  github,
  onChannelsUpdate,
}: {
  github: GitHubChannelView;
  onChannelsUpdate: (next: ChannelView[]) => void;
}) {
  const { t } = useTranslation();
  const [guideOpen, setGuideOpen] = useState(false);

  const [tokenDraft, setTokenDraft] = useState('');
  const [notificationsTokenDraft, setNotificationsTokenDraft] = useState('');
  const [apiBaseUrlDraft, setApiBaseUrlDraft] = useState(github.settings.apiBaseUrl);
  const [pollIntervalDraft, setPollIntervalDraft] = useState(String(github.settings.pollIntervalSec));
  const [wakeWordDraft, setWakeWordDraft] = useState(github.settings.wakeWord);
  const [newWatchRepo, setNewWatchRepo] = useState('');

  const [savingCredentials, setSavingCredentials] = useState(false);
  const [testing, setTesting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [testResult, setTestResult] = useState<ChannelConnectionTestResult | null>(null);
  const { savedNotice, flashSaved, clearSaved } = useSavedNotice();

  const [optimisticWatchRepos, setOptimisticWatchRepos] = useState<string[] | null>(null);
  const latestWatchReposRef = useRef<string[] | null>(null);
  const watchReposSavingRef = useRef(false);

  const [repoPickerOpen, setRepoPickerOpen] = useState(false);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [fetchedRepos, setFetchedRepos] = useState<GitHubRepoOption[]>([]);
  const [reposHasMore, setReposHasMore] = useState(false);
  const [repoLoadError, setRepoLoadError] = useState<string | null>(null);
  const [repoQuery, setRepoQuery] = useState('');
  const [onlySelectedRepos, setOnlySelectedRepos] = useState(false);

  const effectiveWatchRepos = optimisticWatchRepos ?? github.settings.watchRepos;

  useEffect(() => {
    setApiBaseUrlDraft(github.settings.apiBaseUrl);
    setPollIntervalDraft(String(github.settings.pollIntervalSec));
    setWakeWordDraft(github.settings.wakeWord);
  }, [github.settings.apiBaseUrl, github.settings.pollIntervalSec, github.settings.wakeWord]);

  const githubDirty =
    apiBaseUrlDraft.trim() !== github.settings.apiBaseUrl ||
    pollIntervalDraft.trim() !== String(github.settings.pollIntervalSec) ||
    (wakeWordDraft.trim() || '/buddy') !== github.settings.wakeWord ||
    tokenDraft.trim().length > 0 ||
    notificationsTokenDraft.trim().length > 0;

  const applyPatch = async (patch: GitHubChannelSettingsPatch) => {
    const api = window.opc?.channels;
    if (!api) return;
    const next = await api.updateGitHub(patch);
    onChannelsUpdate(next);
  };

  const commitPollInterval = async () => {
    const clamped = clampGitHubPollInterval(pollIntervalDraft, github.settings.pollIntervalSec);
    setPollIntervalDraft(String(clamped));
    if (clamped !== github.settings.pollIntervalSec) {
      await applyPatch({ pollIntervalSec: clamped });
      flashSaved();
    }
  };

  const commitWakeWord = async () => {
    const normalized = wakeWordDraft.trim() || '/buddy';
    setWakeWordDraft(normalized);
    if (normalized !== github.settings.wakeWord) {
      await applyPatch({ wakeWord: normalized });
      flashSaved();
    }
  };

  const handleSaveCredentials = async () => {
    setSavingCredentials(true);
    setTestResult(null);
    clearSaved();
    try {
      const clampedInterval = clampGitHubPollInterval(
        pollIntervalDraft,
        github.settings.pollIntervalSec,
      );
      const normalizedWakeWord = wakeWordDraft.trim() || '/buddy';
      await applyPatch({
        apiBaseUrl: apiBaseUrlDraft.trim(),
        pollIntervalSec: clampedInterval,
        wakeWord: normalizedWakeWord,
        ...(tokenDraft.trim() ? { token: tokenDraft.trim() } : {}),
        ...(notificationsTokenDraft.trim()
          ? { notificationsToken: notificationsTokenDraft.trim() }
          : {}),
      });
      setTokenDraft('');
      setNotificationsTokenDraft('');
      setPollIntervalDraft(String(clampedInterval));
      setWakeWordDraft(normalizedWakeWord);
      flashSaved();
    } finally {
      setSavingCredentials(false);
    }
  };

  const handleClearToken = async () => {
    setSavingCredentials(true);
    setTestResult(null);
    try {
      await applyPatch({ token: '' });
      setTokenDraft('');
    } finally {
      setSavingCredentials(false);
    }
  };

  const handleClearNotificationsToken = async () => {
    setSavingCredentials(true);
    setTestResult(null);
    try {
      await applyPatch({ notificationsToken: '' });
      setNotificationsTokenDraft('');
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
      const result = await api.testConnection('github', {
        apiBaseUrl: apiBaseUrlDraft.trim(),
        ...(tokenDraft.trim() ? { token: tokenDraft.trim() } : {}),
        ...(notificationsTokenDraft.trim()
          ? { notificationsToken: notificationsTokenDraft.trim() }
          : {}),
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
      onChannelsUpdate(await api.reconnect('github'));
    } finally {
      setReconnecting(false);
    }
  };

  const commitWatchRepos = async (next: string[]) => {
    latestWatchReposRef.current = next;
    setOptimisticWatchRepos(next);
    if (watchReposSavingRef.current) return;
    watchReposSavingRef.current = true;
    try {
      while (latestWatchReposRef.current !== null) {
        const target: string[] = latestWatchReposRef.current;
        await applyPatch({ watchRepos: target });
        if (latestWatchReposRef.current === target) {
          latestWatchReposRef.current = null;
          break;
        }
      }
    } finally {
      watchReposSavingRef.current = false;
      setOptimisticWatchRepos(null);
    }
  };

  const handleAddWatchRepo = async () => {
    const normalized = newWatchRepo
      .trim()
      .replace(/^https?:\/\/github\.com\//i, '')
      .replace(/^\/+|\/+$/g, '')
      .replace(/\.git$/i, '')
      .toLowerCase();
    if (!normalized || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(normalized)) return;
    setNewWatchRepo('');
    const current = latestWatchReposRef.current ?? effectiveWatchRepos;
    if (!current.includes(normalized)) {
      await commitWatchRepos([...current, normalized]);
    }
  };

  const handleToggleWatchRepo = async (fullName: string) => {
    const normalized = fullName.trim().toLowerCase();
    if (!normalized) return;
    const current = latestWatchReposRef.current ?? effectiveWatchRepos;
    const next = current.includes(normalized)
      ? current.filter((item) => item !== normalized)
      : [...current, normalized];
    await commitWatchRepos(next);
  };

  const handleRemoveWatchRepo = async (repo: string) => {
    const current = latestWatchReposRef.current ?? effectiveWatchRepos;
    await commitWatchRepos(current.filter((item) => item !== repo));
  };

  const handleFetchRepos = async () => {
    const api = window.opc?.channels;
    if (!api) return;
    setRepoPickerOpen(true);
    setLoadingRepos(true);
    setRepoLoadError(null);
    try {
      const result = await api.listGitHubRepos({
        apiBaseUrl: apiBaseUrlDraft.trim(),
        ...(tokenDraft.trim() ? { token: tokenDraft.trim() } : {}),
      });
      if (result.ok) {
        setFetchedRepos(result.repos);
        setReposHasMore(Boolean(result.hasMore));
      } else {
        setRepoLoadError(result.error ?? 'Unknown error');
      }
    } finally {
      setLoadingRepos(false);
    }
  };

  const selectedRepoSet = new Set(effectiveWatchRepos.map((item) => item.toLowerCase()));
  const trimmedRepoQuery = repoQuery.trim().toLowerCase();
  const visibleRepos = fetchedRepos.filter((repo) => {
    const isSelected = selectedRepoSet.has(repo.fullName.toLowerCase());
    if (onlySelectedRepos && !isSelected) return false;
    if (!trimmedRepoQuery) return true;
    return (
      repo.fullName.toLowerCase().includes(trimmedRepoQuery) ||
      (repo.description ?? '').toLowerCase().includes(trimmedRepoQuery)
    );
  });

  return (
    <div className="space-y-5">
      <Section
        title={t('settings.channels.github.title')}
        description={t('settings.channels.github.subtitle')}
        action={
          <div className="flex items-center gap-2.5">
            <StatusBadge
              tone={statusTone(github.status.state)}
              label={t(`settings.channels.state.${github.status.state}`)}
            />
            {github.settings.enabled ? (
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
              checked={github.settings.enabled}
              onChange={(enabled) => void applyPatch({ enabled })}
              label={t('settings.channels.github.enableToggle')}
            />
          </div>
        }
      >
        {github.status.lastError ? (
          <div className="border-b border-line px-4 py-3">
            <Note tone="warn">{github.status.lastError}</Note>
          </div>
        ) : null}

        {github.status.botName ? (
          <Row label={t('settings.channels.github.botIdentity')}>
            <code className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-2xs text-ink-secondary">
              {github.status.botName}
            </code>
          </Row>
        ) : null}

        {github.status.pollingMode ? (
          <Row
            label={t('settings.channels.github.pollingModeLabel')}
            hint={
              github.status.pollingMode === 'repos_only'
                ? t('settings.channels.github.pollingModeReposOnlyHint')
                : undefined
            }
          >
            <StatusBadge
              tone={github.status.pollingMode === 'notifications_and_repos' ? 'green' : 'blue'}
              label={t(`settings.channels.github.pollingMode.${github.status.pollingMode}`)}
            />
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
              {t('settings.channels.github.guideTitle')}
            </span>
            <span className="text-2xs text-ink-quaternary">
              {t('settings.channels.github.guideHint')}
            </span>
          </button>

          {guideOpen ? (
            <div className="space-y-3 border-t border-line bg-surface-muted/30 px-4 py-3 text-xs leading-relaxed text-ink-secondary">
              <ol className="list-decimal space-y-1.5 pl-4">
                <li>{t('settings.channels.github.step1')}</li>
                <li>{t('settings.channels.github.step2')}</li>
                <li>{t('settings.channels.github.step3')}</li>
                <li>{t('settings.channels.github.step4')}</li>
              </ol>
              <Note tone="info">{t('settings.channels.github.toolsTip')}</Note>
            </div>
          ) : null}
        </div>

        <Row
          label={t('settings.channels.github.token')}
          hint={
            github.settings.hasToken
              ? t('settings.channels.github.tokenSavedHint')
              : t('settings.channels.github.tokenEmptyHint')
          }
          stacked
        >
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <SecretField
                ariaLabel={t('settings.channels.github.token')}
                value={tokenDraft}
                onChange={setTokenDraft}
                placeholder={
                  github.settings.hasToken
                    ? t('settings.channels.github.tokenSavedPlaceholder')
                    : 'github_pat_... / ghp_...'
                }
              />
            </div>
            {github.settings.hasToken ? (
              <button
                type="button"
                disabled={savingCredentials}
                onClick={() => void handleClearToken()}
                className={buttonClass.danger}
              >
                {t('settings.channels.actions.clearSecret')}
              </button>
            ) : null}
          </div>
        </Row>

        <Row
          label={t('settings.channels.github.notificationsToken')}
          hint={
            github.settings.hasNotificationsToken
              ? t('settings.channels.github.notificationsTokenSavedHint')
              : t('settings.channels.github.notificationsTokenEmptyHint')
          }
          stacked
        >
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <SecretField
                ariaLabel={t('settings.channels.github.notificationsToken')}
                value={notificationsTokenDraft}
                onChange={setNotificationsTokenDraft}
                placeholder={
                  github.settings.hasNotificationsToken
                    ? t('settings.channels.github.notificationsTokenSavedPlaceholder')
                    : 'ghp_... (Classic PAT · notifications)'
                }
              />
            </div>
            {github.settings.hasNotificationsToken ? (
              <button
                type="button"
                disabled={savingCredentials}
                onClick={() => void handleClearNotificationsToken()}
                className={buttonClass.danger}
              >
                {t('settings.channels.actions.clearSecret')}
              </button>
            ) : null}
          </div>
        </Row>

        <Row
          label={t('settings.channels.github.apiBaseUrl')}
          hint={t('settings.channels.github.apiBaseUrlHint')}
          stacked
        >
          <TextField
            ariaLabel={t('settings.channels.github.apiBaseUrl')}
            value={apiBaseUrlDraft}
            onChange={setApiBaseUrlDraft}
            placeholder="https://api.github.com"
            mono
          />
        </Row>

        <Row
          label={t('settings.channels.github.pollInterval')}
          hint={t('settings.channels.github.pollIntervalHint')}
        >
          <TextField
            ariaLabel={t('settings.channels.github.pollInterval')}
            value={pollIntervalDraft}
            onChange={setPollIntervalDraft}
            onBlur={() => void commitPollInterval()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void commitPollInterval();
            }}
            placeholder="60"
            mono
          />
        </Row>

        <Row
          label={t('settings.channels.github.wakeWord')}
          hint={t('settings.channels.github.wakeWordHint')}
        >
          <TextField
            ariaLabel={t('settings.channels.github.wakeWord')}
            value={wakeWordDraft}
            onChange={setWakeWordDraft}
            onBlur={() => void commitWakeWord()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void commitWakeWord();
            }}
            placeholder="/buddy"
            mono
          />
        </Row>

        <ChannelSaveRow
          testing={testing}
          saving={savingCredentials}
          dirty={githubDirty}
          savedNotice={savedNotice}
          onTest={() => void handleTestConnection()}
          onSave={() => void handleSaveCredentials()}
        />

        {testResult ? (
          <div className="border-t border-line px-4 py-3">
            <Note tone={testResult.ok ? 'info' : 'warn'}>
              <div className="space-y-1">
                <div>
                  {testResult.ok
                    ? t('settings.channels.testSuccess', {
                        bot: testResult.botName ?? 'GitHub',
                        ms: testResult.latencyMs,
                      })
                    : t('settings.channels.testFailed', {
                        error: testResult.error ?? 'Unknown error',
                      })}
                </div>
                {testResult.detail ? (
                  <div className="text-2xs text-ink-tertiary">{testResult.detail}</div>
                ) : null}
              </div>
            </Note>
          </div>
        ) : null}
      </Section>

      <Section
        title={t('settings.channels.github.triggersTitle')}
        description={t('settings.channels.github.triggersDesc')}
      >
        <Row
          label={t('settings.channels.github.watchReposLabel')}
          hint={t('settings.channels.github.watchReposHint')}
          stacked
        >
          <div className="space-y-2.5">
            {effectiveWatchRepos.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {effectiveWatchRepos.map((repo) => (
                  <span
                    key={repo}
                    className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-muted px-2.5 py-0.5 font-mono text-2xs text-ink-secondary"
                  >
                    {repo}
                    <button
                      type="button"
                      onClick={() => void handleRemoveWatchRepo(repo)}
                      className="text-ink-quaternary hover:text-ink"
                      aria-label={t('settings.channels.actions.remove')}
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-2xs text-ink-quaternary">
                {t('settings.channels.github.watchReposEmpty')}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-[14rem] flex-1">
                <TextField
                  ariaLabel={t('settings.channels.github.watchReposLabel')}
                  value={newWatchRepo}
                  onChange={setNewWatchRepo}
                  placeholder="owner/repo"
                  mono
                />
              </div>
              <button
                type="button"
                onClick={() => void handleAddWatchRepo()}
                className={buttonClass.secondary}
              >
                <Plus className="size-3.5" />
                {t('settings.channels.actions.add')}
              </button>
              <button
                type="button"
                disabled={loadingRepos}
                onClick={() => void handleFetchRepos()}
                className={buttonClass.secondary}
              >
                <RefreshCw className={`size-3.5 ${loadingRepos ? 'animate-spin' : ''}`} />
                {loadingRepos
                  ? t('settings.channels.github.fetchingRepos')
                  : t('settings.channels.github.fetchRepos')}
              </button>
            </div>

            {repoPickerOpen ? (
              <div className="overflow-hidden rounded-lg border border-line bg-surface">
                <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-muted/40 px-3 py-2">
                  <div className="relative min-w-[12rem] flex-1">
                    <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-quaternary" />
                    <input
                      type="text"
                      aria-label={t('settings.channels.github.searchReposPlaceholder')}
                      value={repoQuery}
                      onChange={(event) => setRepoQuery(event.target.value)}
                      placeholder={t('settings.channels.github.searchReposPlaceholder')}
                      className="h-7 w-full rounded-md border border-line bg-surface pr-2.5 pl-8 text-xs text-ink outline-none placeholder:text-ink-quaternary focus:border-accent"
                    />
                  </div>
                  <div className="inline-flex rounded-md bg-surface-muted p-0.5 text-2xs">
                    <button
                      type="button"
                      onClick={() => setOnlySelectedRepos(false)}
                      className={`rounded px-2 py-1 transition-colors ${
                        !onlySelectedRepos
                          ? 'bg-surface font-medium text-ink shadow-xs'
                          : 'text-ink-tertiary hover:text-ink'
                      }`}
                    >
                      {t('settings.channels.github.filterAll')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setOnlySelectedRepos(true)}
                      className={`rounded px-2 py-1 transition-colors ${
                        onlySelectedRepos
                          ? 'bg-surface font-medium text-ink shadow-xs'
                          : 'text-ink-tertiary hover:text-ink'
                      }`}
                    >
                      {t('settings.channels.github.filterSelected')}
                    </button>
                  </div>
                  <button
                    type="button"
                    disabled={loadingRepos}
                    onClick={() => void handleFetchRepos()}
                    className="rounded-md px-2 py-1 text-2xs text-ink-secondary hover:bg-ink/5 hover:text-ink disabled:opacity-50"
                  >
                    {t('settings.channels.github.refreshRepos')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setRepoPickerOpen(false)}
                    className="rounded-md px-2 py-1 text-2xs text-ink-tertiary hover:bg-ink/5 hover:text-ink"
                  >
                    {t('settings.channels.github.closePicker')}
                  </button>
                </div>

                {repoLoadError ? (
                  <div className="border-b border-line p-3">
                    <Note tone="warn">{repoLoadError}</Note>
                  </div>
                ) : null}

                {loadingRepos && fetchedRepos.length === 0 ? (
                  <div className="px-4 py-6 text-center text-xs text-ink-tertiary">
                    {t('settings.channels.github.repoLoading')}
                  </div>
                ) : fetchedRepos.length === 0 ? (
                  !repoLoadError ? (
                    <div className="px-4 py-5 text-center text-xs text-ink-tertiary">
                      {t('settings.channels.github.repoListEmpty')}
                    </div>
                  ) : null
                ) : visibleRepos.length === 0 ? (
                  <div className="px-4 py-5 text-center text-xs text-ink-tertiary">
                    {t('settings.channels.github.repoListNoMatch')}
                  </div>
                ) : (
                  <div className="max-h-64 divide-y divide-line overflow-y-auto">
                    {visibleRepos.map((repo) => {
                      const checked = selectedRepoSet.has(repo.fullName.toLowerCase());
                      return (
                        <button
                          key={repo.fullName}
                          type="button"
                          role="checkbox"
                          aria-checked={checked}
                          onClick={() => void handleToggleWatchRepo(repo.fullName)}
                          className={`flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors ${
                            checked ? 'bg-accent/5 hover:bg-accent/10' : 'hover:bg-surface-muted/60'
                          }`}
                        >
                          <span
                            aria-hidden
                            className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border transition-colors ${
                              checked
                                ? 'border-accent bg-accent text-white'
                                : 'border-line-strong bg-surface text-transparent'
                            }`}
                          >
                            <Check className="size-3" strokeWidth={2.5} />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="truncate font-mono text-xs font-medium text-ink">
                                {repo.fullName}
                              </span>
                              {repo.private ? (
                                <span className="inline-flex items-center gap-0.5 rounded bg-surface-muted px-1.5 py-0.5 text-[10px] text-ink-tertiary">
                                  <Lock className="size-2.5" />
                                  {t('settings.channels.github.repoPrivate')}
                                </span>
                              ) : null}
                              {repo.archived ? (
                                <span className="rounded bg-surface-muted px-1.5 py-0.5 text-[10px] text-ink-quaternary">
                                  {t('settings.channels.github.repoArchived')}
                                </span>
                              ) : null}
                            </div>
                            {repo.description ? (
                              <p className="mt-0.5 truncate text-2xs text-ink-tertiary">
                                {repo.description}
                              </p>
                            ) : null}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-surface-muted/30 px-3 py-1.5 text-2xs text-ink-tertiary">
                  <span>
                    {t('settings.channels.github.repoListSummary', {
                      total: fetchedRepos.length,
                      selected: selectedRepoSet.size,
                    })}
                  </span>
                  {reposHasMore ? (
                    <span className="text-ink-quaternary">
                      {t('settings.channels.github.repoListHasMore')}
                    </span>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </Row>

        <Row
          label={t('settings.channels.github.eventMention')}
          hint={t('settings.channels.github.eventMentionHint')}
        >
          <Toggle
            checked={github.settings.events.mention}
            onChange={(mention) =>
              void applyPatch({ events: { ...github.settings.events, mention } })
            }
            label={t('settings.channels.github.eventMention')}
          />
        </Row>

        <Row
          label={t('settings.channels.github.eventReview')}
          hint={t('settings.channels.github.eventReviewHint')}
        >
          <Toggle
            checked={github.settings.events.reviewRequested}
            onChange={(reviewRequested) =>
              void applyPatch({ events: { ...github.settings.events, reviewRequested } })
            }
            label={t('settings.channels.github.eventReview')}
          />
        </Row>

        <Row
          label={t('settings.channels.github.eventAssigned')}
          hint={t('settings.channels.github.eventAssignedHint')}
        >
          <Toggle
            checked={github.settings.events.assigned}
            onChange={(assigned) =>
              void applyPatch({ events: { ...github.settings.events, assigned } })
            }
            label={t('settings.channels.github.eventAssigned')}
          />
        </Row>

        <Row
          label={t('settings.channels.github.eventRepoActivity')}
          hint={t('settings.channels.github.eventRepoActivityHint')}
        >
          <Toggle
            checked={github.settings.events.repoActivity}
            onChange={(repoActivity) =>
              void applyPatch({ events: { ...github.settings.events, repoActivity } })
            }
            label={t('settings.channels.github.eventRepoActivity')}
          />
        </Row>
      </Section>

      <ChannelAccessSection
        channelId="github"
        access={github.settings.access}
        pendingPairings={github.pendingPairings}
        knownTargets={github.knownTargets}
        dmPlaceholder={t('settings.channels.github.addDmPlaceholder')}
        groupPlaceholder={t('settings.channels.github.addGroupPlaceholder')}
        onPatchAccess={(access) => applyPatch({ access })}
      />

      <Section
        title={t('settings.channels.behavior.title')}
        description={t('settings.channels.behavior.desc')}
      >
        <Row
          label={t('settings.channels.github.autoReplyLabel')}
          hint={t('settings.channels.github.autoReplyHint')}
        >
          <Toggle
            checked={github.settings.autoReplyToGitHub}
            onChange={(autoReplyToGitHub) => void applyPatch({ autoReplyToGitHub })}
            label={t('settings.channels.github.autoReplyLabel')}
          />
        </Row>

        <Row
          label={t('settings.channels.behavior.mirrorLabel')}
          hint={t('settings.channels.github.mirrorHint')}
        >
          <Toggle
            checked={github.settings.mirrorToDesktop}
            onChange={(mirrorToDesktop) => void applyPatch({ mirrorToDesktop })}
            label={t('settings.channels.behavior.mirrorLabel')}
          />
        </Row>

        <Row
          label={t('settings.channels.github.thinkingLabel')}
          hint={t('settings.channels.github.thinkingHint')}
        >
          <Toggle
            checked={github.settings.thinkingReaction}
            onChange={(thinkingReaction) => void applyPatch({ thinkingReaction })}
            label={t('settings.channels.github.thinkingLabel')}
          />
        </Row>
      </Section>

      <ChannelTargetsSection
        channelId="github"
        targets={github.knownTargets}
        emptyText={t('settings.channels.github.targetsEmpty')}
      />
    </div>
  );
}

const CHANNEL_PAGE_LABEL_KEY: Record<ChannelView['id'], string> = {
  feishu: 'settings.page.channelFeishu',
  dingtalk: 'settings.page.channelDingtalk',
  slack: 'settings.page.channelSlack',
  wecom: 'settings.page.channelWecom',
  telegram: 'settings.page.channelTelegram',
  github: 'settings.page.channelGitHub',
};

export function ChannelsPage({
  channelId,
  channels: externalChannels,
  loading: externalLoading,
  onChannelsUpdate,
}: {
  channelId: ChannelView['id'];
  channels?: ChannelView[];
  loading?: boolean;
  onChannelsUpdate?: (next: ChannelView[]) => void;
}) {
  const { t } = useTranslation();
  const [internalChannels, setInternalChannels] = useState<ChannelView[]>([]);
  const [internalLoading, setInternalLoading] = useState(true);

  const controlled = externalChannels !== undefined;

  useEffect(() => {
    if (controlled) return;
    const api = window.opc?.channels;
    if (!api) {
      setInternalLoading(false);
      return;
    }

    let active = true;
    void api
      .list()
      .then((views) => {
        if (active) setInternalChannels(views);
      })
      .finally(() => {
        if (active) setInternalLoading(false);
      });

    const unsub = api.onChanged((views) => {
      if (active) setInternalChannels(views);
    });

    return () => {
      active = false;
      unsub();
    };
  }, [controlled]);

  const channels = controlled ? externalChannels : internalChannels;
  const loading = controlled ? Boolean(externalLoading) : internalLoading;
  const handleChannelsUpdate = (next: ChannelView[]) => {
    if (onChannelsUpdate) {
      onChannelsUpdate(next);
    } else {
      setInternalChannels(next);
    }
  };

  const pageTitle = t(CHANNEL_PAGE_LABEL_KEY[channelId]);
  const pageDesc = t(`settings.channels.${channelId}.subtitle`);

  if (loading && channels.length === 0) {
    return (
      <div>
        <PageHeader
          crumbs={[t('settings.title'), t('settings.group.channels'), pageTitle]}
          icon={<ChannelBrandIcon channelId={channelId} className="size-6 shrink-0" />}
          title={pageTitle}
          description={pageDesc}
        />
        <div className="rounded-xl border border-line bg-surface p-6 text-sm text-ink-tertiary">
          {t('common.loading')}
        </div>
      </div>
    );
  }

  const activeChannel = channels.find((item) => item.id === channelId);

  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={[t('settings.title'), t('settings.group.channels'), pageTitle]}
        icon={<ChannelBrandIcon channelId={channelId} className="size-6 shrink-0" />}
        title={pageTitle}
        description={pageDesc}
      />

      {activeChannel?.id === 'feishu' ? (
        <FeishuChannelDetail feishu={activeChannel} onChannelsUpdate={handleChannelsUpdate} />
      ) : null}

      {activeChannel?.id === 'dingtalk' ? (
        <DingTalkChannelDetail dingtalk={activeChannel} onChannelsUpdate={handleChannelsUpdate} />
      ) : null}

      {activeChannel?.id === 'slack' ? (
        <SlackChannelDetail slack={activeChannel} onChannelsUpdate={handleChannelsUpdate} />
      ) : null}

      {activeChannel?.id === 'wecom' ? (
        <WeComChannelDetail wecom={activeChannel} onChannelsUpdate={handleChannelsUpdate} />
      ) : null}

      {activeChannel?.id === 'telegram' ? (
        <TelegramChannelDetail telegram={activeChannel} onChannelsUpdate={handleChannelsUpdate} />
      ) : null}

      {activeChannel?.id === 'github' ? (
        <GitHubChannelDetail github={activeChannel} onChannelsUpdate={handleChannelsUpdate} />
      ) : null}
    </div>
  );
}
