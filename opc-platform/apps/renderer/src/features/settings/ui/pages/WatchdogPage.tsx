import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertCircle,
  AlertOctagon,
  CheckCircle2,
  ChevronDown,
  Cpu,
  Eye,
  GitBranch,
  PauseCircle,
  Power,
  RotateCcw,
  RotateCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Unplug,
  Wrench,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  WatchdogActionView,
  WatchdogAskResult,
  WatchdogIncidentView,
} from '@opc/shared/ipc';
import { isChatModelEnabled } from '@opc/shared/domain';
import { useCatalog } from '@/features/models/model/useCatalog';
import { useModels } from '@/features/models/model/useModels';
import { appTimeZone, formatAppTime, formatDurationCompact, formatRelativeAge } from '@/shared/lib/appTime';
import { cn } from '@/shared/lib/cn';
import { ModelPicker, pickerGroups, type ModelPickerValue } from '@/shared/ui/ModelPicker';
import { buttonClass, Note, Row, Section, Segmented, Toggle } from '../kit';
import {
  areWatchdogDraftsEqual,
  DEFAULT_WATCHDOG_DRAFT,
  formatIncidentDetail,
  formatShortSubjectId,
  hasOpenInfraIncident,
  indexLatestActionByIncident,
  resolveActionInfo,
  resolveIncidentKindKey,
  resolveJudgedByKey,
  resolveSubjectTypeKey,
  resolveVerdictInfo,
  splitWatchdogIncidents,
  summarizeWatchdogActions,
  toWatchdogDraft,
  toWatchdogPatch,
  WATCHDOG_POLICY_RANGES,
  type IncidentKindKey,
  type IncidentViewFilter,
  type SemanticTone,
  type WatchdogPolicyDraft,
  type WatchdogTab,
} from './watchdogModel';

const STATE_VISUALS: Record<
  WatchdogIncidentView['state'],
  { Icon: typeof AlertOctagon; badgeClass: string; rowAccentClass: string }
> = {
  escalated: {
    Icon: AlertOctagon,
    badgeClass: 'bg-danger/12 text-danger ring-1 ring-danger/25 font-medium',
    rowAccentClass: 'border-l-[3px] border-l-danger bg-danger/[0.025]',
  },
  rechecking: {
    Icon: Eye,
    badgeClass:
      "bg-sky-500/12 text-sky-700 ring-1 ring-sky-500/25 font-medium [[data-theme='dark']_&]:text-sky-300",
    rowAccentClass: 'border-l-[3px] border-l-sky-500/80',
  },
  active: {
    Icon: AlertCircle,
    badgeClass:
      "bg-amber-500/12 text-amber-700 ring-1 ring-amber-500/25 font-medium [[data-theme='dark']_&]:text-amber-300",
    rowAccentClass: 'border-l-[3px] border-l-amber-500/80',
  },
  resolved: {
    Icon: CheckCircle2,
    badgeClass: 'border border-line bg-surface-muted/55 text-ink-tertiary',
    rowAccentClass: 'border-l-[3px] border-l-transparent',
  },
};

const SEMANTIC_BADGE_CLASS: Record<SemanticTone, string> = {
  green: 'bg-success/12 text-success ring-1 ring-success/25 font-medium',
  amber:
    "bg-amber-500/12 text-amber-700 ring-1 ring-amber-500/25 font-medium [[data-theme='dark']_&]:text-amber-300",
  red: 'bg-danger/12 text-danger ring-1 ring-danger/25 font-medium',
  blue:
    "bg-sky-500/12 text-sky-700 ring-1 ring-sky-500/25 font-medium [[data-theme='dark']_&]:text-sky-300",
  gray: 'border border-line bg-surface-muted/55 text-ink-tertiary',
};

const SEMANTIC_TEXT_CLASS: Record<SemanticTone, string> = {
  green: 'text-success font-medium',
  amber: "text-amber-700 font-medium [[data-theme='dark']_&]:text-amber-300",
  red: 'text-danger font-medium',
  blue: "text-sky-700 font-medium [[data-theme='dark']_&]:text-sky-300",
  gray: 'text-ink-secondary font-medium',
};

const KIND_ICONS: Record<IncidentKindKey, typeof RotateCw> = {
  repeatFailure: RotateCw,
  noProgress: PauseCircle,
  mainUnresponsive: Activity,
  mcpConnectFailed: Unplug,
  routerSessionFailed: GitBranch,
  processUncleanExit: Power,
  watchdogUnresponsive: ShieldAlert,
  watchdogSpawnFailed: ShieldAlert,
  watchdogDbUnavailable: ShieldAlert,
  watchdogExited: ShieldAlert,
  watchdogProcess: ShieldAlert,
  other: AlertCircle,
};

function formatClock(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: appTimeZone(),
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(timestamp);
}

function resolveModelLabel(
  providers: ReturnType<typeof useModels>['providers'],
  ref: ModelPickerValue | null,
  fallback: string,
): string {
  if (!ref) return fallback;
  const provider = providers.find((entry) => entry.id === ref.providerId);
  const model = provider?.models.find((entry) => entry.id === ref.modelId);
  return model?.name ?? ref.modelId;
}

/**
 * 设置 → 运行时 → 进展监督（`docs/v2/11-watchdog-spec.md` W7）。
 *
 * 将「实时监控与排查」和「规则与阈值」拆成双 Tab：日常打开专注查看未决异常、
 * 自愈处置和证据排查问答；需要调整停滞/打转或底层冷却阈值时再切到规则页。
 */
export function WatchdogPage() {
  const { t, i18n } = useTranslation();
  const models = useModels();
  const { catalog } = useCatalog();

  const [tab, setTab] = useState<WatchdogTab>('monitor');
  const [incidents, setIncidents] = useState<WatchdogIncidentView[]>([]);
  const [actions, setActions] = useState<WatchdogActionView[]>([]);
  const [draft, setDraft] = useState<WatchdogPolicyDraft | null>(null);
  const [baseline, setBaseline] = useState<WatchdogPolicyDraft | null>(null);
  const [modelRef, setModelRef] = useState<ModelPickerValue | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<WatchdogAskResult | null>(null);
  const [asking, setAsking] = useState(false);

  const [saving, setSaving] = useState(false);
  const [policyNote, setPolicyNote] = useState('');
  const [policyError, setPolicyError] = useState('');

  const refreshActivity = useCallback(async () => {
    const bridge = window.opc?.watchdog;
    if (!bridge) return;
    try {
      const [nextIncidents, nextActions] = await Promise.all([
        bridge.incidents(),
        bridge.actions(),
      ]);
      setIncidents(nextIncidents);
      setActions(nextActions);
      setNow(Date.now());
    } catch {
      // Keep last snapshot if a background poll transiently fails.
    }
  }, []);

  const loadPolicy = useCallback(async () => {
    const bridge = window.opc?.watchdog;
    if (!bridge) return;
    try {
      const [nextPolicy, nextModel] = await Promise.all([bridge.getPolicy(), bridge.getModel()]);
      const next = toWatchdogDraft(nextPolicy);
      setDraft(next);
      setBaseline(next);
      setModelRef(nextModel ?? null);
    } catch {
      // Preserve loading placeholder if IPC read is unavailable.
    }
  }, []);

  useEffect(() => {
    void loadPolicy();
    void refreshActivity();
    const timer = window.setInterval(() => {
      void refreshActivity();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [loadPolicy, refreshActivity]);

  const modelGroups = useMemo(
    () =>
      pickerGroups(
        models.providers,
        (model) => model.capability === 'chat' && isChatModelEnabled(model),
        catalog,
      ),
    [catalog, models.providers],
  );

  const incidentSplit = useMemo(() => splitWatchdogIncidents(incidents), [incidents]);
  const actionStats = useMemo(() => summarizeWatchdogActions(actions), [actions]);
  const latestActionByIncident = useMemo(
    () => indexLatestActionByIncident(actions),
    [actions],
  );
  const infraIssueOpen = useMemo(() => hasOpenInfraIncident(incidents), [incidents]);
  const dirty = draft !== null && baseline !== null && !areWatchdogDraftsEqual(draft, baseline);

  const configuredModelLabel = resolveModelLabel(
    models.providers,
    modelRef,
    t('settings.watchdog.modelDefault'),
  );

  const askQuestion = async (raw: string) => {
    const bridge = window.opc?.watchdog;
    const trimmed = raw.trim();
    if (!bridge || !trimmed || asking) return;
    setQuestion(trimmed);
    setAsking(true);
    setAnswer(null);
    try {
      setAnswer(await bridge.ask(trimmed));
    } catch (error) {
      setAnswer({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setAsking(false);
    }
  };

  const updateDraft = (patch: Partial<WatchdogPolicyDraft>) => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
    setPolicyNote('');
    setPolicyError('');
  };

  const resetDefaults = () => {
    setDraft({ ...DEFAULT_WATCHDOG_DRAFT });
    setPolicyNote('');
    setPolicyError('');
  };

  const savePolicy = async () => {
    const bridge = window.opc?.watchdog;
    if (!bridge || !draft || saving) return;
    setSaving(true);
    setPolicyError('');
    try {
      const saved = await bridge.savePolicy(toWatchdogPatch(draft));
      const next = toWatchdogDraft(saved);
      setDraft(next);
      setBaseline(next);
      setPolicyNote(t('settings.watchdog.saved'));
    } catch (error) {
      setPolicyError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const selectModel = async (next: ModelPickerValue | null) => {
    const bridge = window.opc?.watchdog;
    setModelRef(next);
    setPolicyError('');
    if (!bridge) return;
    try {
      const stored = await bridge.setModel(next);
      setModelRef(stored ?? null);
      setPolicyNote(t('settings.watchdog.modelChangedNote'));
    } catch (error) {
      setPolicyError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="space-y-4">
      <header className="mb-1">
        <div className="flex items-center gap-1 text-xs-plus text-ink-tertiary">
          <span>{t('settings.title')}</span>
          <span className="text-ink-quaternary">›</span>
          <span>{t('settings.group.runtime')}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl leading-tight font-bold tracking-tight text-ink">
            {t('settings.page.watchdog')}
          </h2>
          <Segmented<WatchdogTab>
            label={t('settings.page.watchdog')}
            value={tab}
            onChange={setTab}
            options={[
              {
                value: 'monitor',
                label: (
                  <span className="inline-flex items-center gap-1.5">
                    <span>{t('settings.watchdog.tabs.monitor')}</span>
                    {incidentSplit.counts.open > 0 ? (
                      <span
                        className={cn(
                          'inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-mono text-[10px] font-semibold tabular-nums',
                          incidentSplit.counts.escalated > 0
                            ? 'bg-danger text-white'
                            : 'bg-warning/20 text-warning',
                        )}
                      >
                        {incidentSplit.counts.open}
                      </span>
                    ) : null}
                  </span>
                ),
              },
              {
                value: 'rules',
                label: (
                  <span className="inline-flex items-center gap-1.5">
                    <span>{t('settings.watchdog.tabs.rules')}</span>
                    {dirty ? <span className="size-1.5 rounded-full bg-warning" /> : null}
                  </span>
                ),
              },
            ]}
          />
        </div>
        <p className="mt-1.5 max-w-[44rem] text-sm-plus leading-relaxed text-ink-tertiary">
          {t('settings.watchdog.desc')}
        </p>
      </header>

      {tab === 'monitor' ? (
        <WatchdogMonitorTab
          now={now}
          locale={i18n.language}
          policy={baseline ?? draft}
          infraIssueOpen={infraIssueOpen}
          incidentSplit={incidentSplit}
          actions={actions}
          actionStats={actionStats}
          latestActionByIncident={latestActionByIncident}
          modelLabel={configuredModelLabel}
          onOpenRules={() => setTab('rules')}
          question={question}
          onQuestionChange={setQuestion}
          answer={answer}
          onClearAnswer={() => setAnswer(null)}
          asking={asking}
          onAsk={askQuestion}
        />
      ) : (
        <WatchdogPolicyTab
          draft={draft}
          dirty={dirty}
          saving={saving}
          note={policyNote}
          error={policyError}
          modelRef={modelRef}
          modelGroups={modelGroups}
          onUpdate={updateDraft}
          onResetDefaults={resetDefaults}
          onSave={() => void savePolicy()}
          onSelectModel={(selection) => void selectModel(selection)}
        />
      )}
    </div>
  );
}

function WatchdogMonitorTab({
  now,
  locale,
  policy,
  infraIssueOpen,
  incidentSplit,
  actions,
  actionStats,
  latestActionByIncident,
  modelLabel,
  onOpenRules,
  question,
  onQuestionChange,
  answer,
  onClearAnswer,
  asking,
  onAsk,
}: {
  now: number;
  locale: string;
  policy: WatchdogPolicyDraft | null;
  infraIssueOpen: boolean;
  incidentSplit: ReturnType<typeof splitWatchdogIncidents>;
  actions: readonly WatchdogActionView[];
  actionStats: ReturnType<typeof summarizeWatchdogActions>;
  latestActionByIncident: Record<string, WatchdogActionView>;
  modelLabel: string;
  onOpenRules: () => void;
  question: string;
  onQuestionChange: (next: string) => void;
  answer: WatchdogAskResult | null;
  onClearAnswer: () => void;
  asking: boolean;
  onAsk: (question: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [incidentFilter, setIncidentFilter] = useState<IncidentViewFilter>('open');
  const [expandedIncidents, setExpandedIncidents] = useState<Record<string, boolean>>({});
  const [showAllActions, setShowAllActions] = useState(false);

  const { counts } = incidentSplit;
  const shownIncidents = incidentFilter === 'open' ? incidentSplit.open : incidentSplit.resolved;
  const visibleActions = showAllActions ? actions : actions.slice(0, 5);
  const rawQuickQuestions = t('settings.watchdog.quickQuestions', { returnObjects: true });
  const quickQuestions = Array.isArray(rawQuickQuestions)
    ? rawQuickQuestions.filter((item): item is string => typeof item === 'string')
    : [];

  const guardTitle = infraIssueOpen
    ? t('settings.watchdog.overview.guardIssue')
    : policy?.enabled === false
      ? t('settings.watchdog.overview.guardMuted')
      : t('settings.watchdog.overview.guardActive');

  const guardSubtext = infraIssueOpen
    ? t('settings.watchdog.overview.guardIssueHint', {
        count: incidentSplit.open.filter(
          (item) => item.kind === 'main_unresponsive' || item.kind.startsWith('watchdog.'),
        ).length,
      })
    : policy?.enabled === false
      ? t('settings.watchdog.overview.guardMutedHint')
      : policy
        ? t('settings.watchdog.overview.guardThresholdHint', {
            idle: policy.idleMinutes,
            repeat: policy.repeatFailure,
          })
        : '—';

  const watchingCount = counts.rechecking + counts.active;

  return (
    <div className="space-y-4">
      {/* 4-card Watchdog health strip */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <div
          className={cn(
            'rounded-xl border px-3.5 py-3 transition-colors',
            infraIssueOpen
              ? 'border-danger/35 bg-danger/[0.06]'
              : policy?.enabled === false
                ? 'border-line bg-surface-muted/40'
                : 'border-line bg-surface',
          )}
        >
          <div className="flex items-center justify-between gap-2 text-xs text-ink-tertiary">
            <span>{t('settings.watchdog.overview.guardStatus')}</span>
            <span
              className={cn(
                'size-2 rounded-full',
                infraIssueOpen
                  ? 'bg-danger observatory-dot-pulse'
                  : policy?.enabled === false
                    ? 'bg-ink-quaternary'
                    : 'bg-success observatory-dot-pulse',
              )}
            />
          </div>
          <div className="mt-1 truncate text-sm-plus font-semibold text-ink">{guardTitle}</div>
          <div
            className={cn(
              'mt-0.5 truncate text-2xs',
              infraIssueOpen ? 'text-danger' : 'text-ink-quaternary',
            )}
          >
            {guardSubtext}
          </div>
        </div>

        <div
          className={cn(
            'rounded-xl border px-3.5 py-3 transition-colors',
            counts.escalated > 0
              ? 'border-danger/35 bg-danger/[0.06]'
              : counts.open > 0
                ? 'border-warning/35 bg-warning/[0.06]'
                : 'border-line bg-surface',
          )}
        >
          <div className="flex items-center justify-between gap-2 text-xs text-ink-tertiary">
            <span>{t('settings.watchdog.overview.openIssues')}</span>
            {counts.open > 0 ? (
              <span
                className={cn(
                  'size-2 rounded-full observatory-dot-pulse',
                  counts.escalated > 0 ? 'bg-danger' : 'bg-warning',
                )}
              />
            ) : null}
          </div>
          <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-ink">
            {counts.open}
          </div>
          <div
            className={cn(
              'mt-0.5 truncate text-2xs',
              counts.escalated > 0
                ? 'text-danger'
                : counts.open > 0
                  ? 'text-warning'
                  : 'text-success',
            )}
          >
            {counts.open > 0
              ? t('settings.watchdog.overview.openBreakdown', {
                  escalated: counts.escalated,
                  watching: watchingCount,
                })
              : t('settings.watchdog.overview.openClear')}
          </div>
        </div>

        <div className="rounded-xl border border-line bg-surface px-3.5 py-3">
          <div className="text-xs text-ink-tertiary">
            {t('settings.watchdog.overview.actionsCard')}
          </div>
          <div className="mt-1 flex items-baseline gap-1 font-mono tabular-nums">
            <span className="text-lg font-semibold text-ink">{actionStats.done}</span>
            <span className="text-xs text-ink-quaternary">/ {actionStats.total}</span>
          </div>
          <div className="mt-0.5 truncate text-2xs text-ink-quaternary">
            {actionStats.total === 0
              ? t('settings.watchdog.overview.actionsNone')
              : actionStats.pending > 0
                ? t('settings.watchdog.overview.actionsPending', { count: actionStats.pending })
                : t('settings.watchdog.overview.actionsSummary', {
                    done: actionStats.done,
                    failed: actionStats.failed,
                  })}
          </div>
        </div>

        <button
          type="button"
          onClick={onOpenRules}
          className="group rounded-xl border border-line bg-surface px-3.5 py-3 text-left transition hover:border-line-strong hover:bg-surface-hover/50"
        >
          <div className="flex items-center justify-between gap-1 text-xs text-ink-tertiary">
            <span>{t('settings.watchdog.overview.modelCard')}</span>
            <Cpu className="size-3.5 text-ink-quaternary" />
          </div>
          <div className="mt-1 truncate text-sm-plus font-semibold text-ink">{modelLabel}</div>
          <div className="mt-1 truncate text-2xs font-medium text-accent-ink group-hover:underline">
            {t('settings.watchdog.overview.modelJump')}
          </div>
        </button>
      </div>

      {/* Incidents section: Active focus separated from Resolved history */}
      <Section
        title={`${
          incidentFilter === 'open'
            ? t('settings.watchdog.incidentsSection.openTitle')
            : t('settings.watchdog.incidentsSection.resolvedTitle')
        } · ${shownIncidents.length}`}
        action={
          <Segmented<IncidentViewFilter>
            label={t('settings.watchdog.incidents')}
            value={incidentFilter}
            onChange={setIncidentFilter}
            options={[
              {
                value: 'open',
                label: t('settings.watchdog.incidentsSection.tabOpen', { count: counts.open }),
              },
              {
                value: 'resolved',
                label: t('settings.watchdog.incidentsSection.tabResolved', {
                  count: counts.resolved,
                }),
              },
            ]}
          />
        }
      >
        {shownIncidents.length === 0 ? (
          incidentFilter === 'open' ? (
            <div className="flex flex-col items-center justify-center px-6 py-9 text-center">
              <div className="flex size-10 items-center justify-center rounded-2xl bg-success/12 text-success">
                <ShieldCheck className="size-5" />
              </div>
              <p className="mt-2.5 text-sm-plus font-medium text-ink">
                {t('settings.watchdog.incidentsSection.healthyTitle')}
              </p>
              <p className="mt-1 max-w-md text-xs leading-relaxed text-ink-tertiary">
                {t('settings.watchdog.incidentsSection.healthyDesc')}
              </p>
              {counts.resolved > 0 ? (
                <button
                  type="button"
                  onClick={() => setIncidentFilter('resolved')}
                  className="mt-3 text-xs font-medium text-accent-ink hover:underline"
                >
                  {t('settings.watchdog.incidentsSection.healthyViewResolved', {
                    count: counts.resolved,
                  })}
                </button>
              ) : null}
            </div>
          ) : (
            <p className="px-4 py-8 text-center text-sm-plus text-ink-tertiary">
              {t('settings.watchdog.incidentsSection.resolvedEmpty')}
            </p>
          )
        ) : (
          <ul className="divide-y divide-line" data-testid="watchdog-incident-list">
            {shownIncidents.map((incident) => (
              <WatchdogIncidentRow
                key={incident.id}
                incident={incident}
                latestAction={latestActionByIncident[incident.id]}
                now={now}
                locale={locale}
                expanded={Boolean(expandedIncidents[incident.id])}
                onToggle={() =>
                  setExpandedIncidents((prev) => ({
                    ...prev,
                    [incident.id]: !prev[incident.id],
                  }))
                }
              />
            ))}
          </ul>
        )}
      </Section>

      {/* Evidence-grounded Q&A */}
      <WatchdogAskCard
        question={question}
        onQuestionChange={onQuestionChange}
        quickQuestions={quickQuestions}
        answer={answer}
        onClearAnswer={onClearAnswer}
        asking={asking}
        onAsk={onAsk}
      />

      {/* Self-healing audit ledger */}
      <Section
        title={`${t('settings.watchdog.actions')} · ${actions.length}`}
        description={t('settings.watchdog.actionsDesc')}
        action={
          actions.length > 5 ? (
            <button
              type="button"
              onClick={() => setShowAllActions((prev) => !prev)}
              className="text-xs font-medium text-accent-ink hover:underline"
            >
              {showAllActions
                ? t('settings.watchdog.collapseActions')
                : t('settings.watchdog.showAllActions', { count: actions.length })}
            </button>
          ) : undefined
        }
      >
        {actions.length === 0 ? (
          <p className="px-4 py-3 text-sm-plus text-ink-tertiary">
            {t('settings.watchdog.noActions')}
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {visibleActions.map((item) => {
              const info = resolveActionInfo(item.action, item.status);
              return (
                <li
                  key={`${item.incidentId}:${item.at}`}
                  className="flex items-start justify-between gap-3 px-4 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          'inline-flex h-5 items-center gap-1 rounded-full px-2 text-2xs whitespace-nowrap',
                          SEMANTIC_BADGE_CLASS[info.tone],
                        )}
                      >
                        <Wrench className="size-2.5" />
                        {t(`settings.watchdog.actionStatus.${item.status}`)}
                      </span>
                      <span className="text-sm font-medium text-ink">
                        {t(`settings.watchdog.actionNames.${info.nameKey}`)}
                      </span>
                    </div>
                    {item.result ? (
                      <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
                        {item.result}
                      </p>
                    ) : null}
                  </div>
                  <span
                    title={new Date(item.at).toLocaleString()}
                    className="shrink-0 pt-0.5 font-mono text-[11px] tabular-nums text-ink-quaternary"
                  >
                    {formatAppTime(item.at, locale)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </div>
  );
}

function WatchdogIncidentRow({
  incident,
  latestAction,
  now,
  locale,
  expanded,
  onToggle,
}: {
  incident: WatchdogIncidentView;
  latestAction?: WatchdogActionView;
  now: number;
  locale: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const stateVisual = STATE_VISUALS[incident.state];
  const StateIcon = stateVisual.Icon;
  const kindKey = resolveIncidentKindKey(incident.kind);
  const KindIcon = KIND_ICONS[kindKey];
  const subjectTypeKey = resolveSubjectTypeKey(incident.subjectType);
  const shortSubject = formatShortSubjectId(incident.subjectType, incident.subjectId);
  const verdictInfo = incident.verdict ? resolveVerdictInfo(incident.verdict) : null;
  const judgedByKey = resolveJudgedByKey(incident.judgedBy);
  const actionInfo = latestAction
    ? resolveActionInfo(latestAction.action, latestAction.status)
    : null;
  const parsedDetail = useMemo(() => formatIncidentDetail(incident.detail), [incident.detail]);

  const isResolved = incident.state === 'resolved';
  const durationMs = isResolved
    ? Math.max(0, (incident.resolvedAt ?? incident.lastSeenAt) - incident.firstAt)
    : Math.max(0, now - incident.firstAt);
  const anchorTime = isResolved ? (incident.resolvedAt ?? incident.lastSeenAt) : incident.lastSeenAt;
  const relativeAge = formatRelativeAge(anchorTime, now, {
    justNow: t('settings.watchdog.age.justNow'),
    minutesAgo: (count) => t('settings.watchdog.age.minutesAgo', { count }),
    hoursAgo: (count) => t('settings.watchdog.age.hoursAgo', { count }),
    daysAgo: (count) => t('settings.watchdog.age.daysAgo', { count }),
  });

  return (
    <li
      data-testid="watchdog-incident-row"
      className={cn(
        'px-4 py-3 transition-colors hover:bg-surface-hover/35',
        stateVisual.rowAccentClass,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <span
            className={cn(
              'inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full px-2 text-2xs whitespace-nowrap',
              stateVisual.badgeClass,
            )}
          >
            <StateIcon className="size-3 shrink-0" strokeWidth={2.2} />
            <span>{t(`settings.watchdog.states.${incident.state}`)}</span>
          </span>

          <span className="inline-flex h-[22px] shrink-0 items-center gap-1 rounded-md border border-line bg-surface-muted/45 px-2 text-2xs font-medium whitespace-nowrap text-ink-secondary">
            <KindIcon className="size-3 shrink-0 text-ink-tertiary" strokeWidth={2} />
            <span>{t(`settings.watchdog.kinds.${kindKey}`)}</span>
          </span>

          {shortSubject ? (
            <span className="inline-flex h-[22px] items-center rounded-md bg-surface-muted px-2 font-mono text-[11px] text-ink-tertiary">
              {t(`settings.watchdog.subjects.${subjectTypeKey}`)} · {shortSubject}
            </span>
          ) : null}

          {incident.reopenCount > 0 ? (
            <span
              className={cn(
                'inline-flex h-[22px] items-center rounded-md px-2 text-2xs whitespace-nowrap',
                SEMANTIC_BADGE_CLASS.amber,
              )}
            >
              {t('settings.watchdog.incidentsSection.reopenCount', {
                count: incident.reopenCount,
              })}
            </span>
          ) : null}
        </div>

        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-ink-quaternary transition hover:bg-surface-hover hover:text-ink-secondary"
        >
          <span>
            {isResolved
              ? t('settings.watchdog.incidentsSection.durationResolved', {
                  duration: formatDurationCompact(durationMs),
                })
              : t('settings.watchdog.incidentsSection.durationOngoing', {
                  duration: formatDurationCompact(durationMs),
                })}
          </span>
          <span className="opacity-40">·</span>
          <span>{relativeAge}</span>
          <ChevronDown
            className={cn(
              'size-3.5 transition-transform',
              expanded && 'rotate-180 text-ink-secondary',
            )}
          />
        </button>
      </div>

      <p
        className={cn(
          'mt-2 text-sm leading-snug',
          isResolved ? 'text-ink-secondary' : 'font-medium text-ink',
        )}
      >
        {incident.summary}
      </p>

      {verdictInfo ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-line/75 bg-surface-muted/45 px-2.5 py-1.5 text-xs leading-relaxed">
          <span className="inline-flex items-center gap-1 text-ink-tertiary">
            <Sparkles className="size-3 text-accent-ink" />
            <span>{t('settings.watchdog.incidentsSection.verdictPrefix')}：</span>
          </span>
          <span className={SEMANTIC_TEXT_CLASS[verdictInfo.tone]}>
            {verdictInfo.key === 'other' && incident.verdict
              ? incident.verdict
              : t(`settings.watchdog.verdicts.${verdictInfo.key}`)}
          </span>
          {typeof incident.verdictConfidence === 'number' && incident.verdictConfidence > 0 ? (
            <span className="rounded bg-surface px-1.5 py-px font-mono text-[10px] text-ink-tertiary ring-1 ring-line">
              {t('settings.watchdog.incidentsSection.confidence', {
                pct: Math.round(incident.verdictConfidence * 100),
              })}
            </span>
          ) : null}
          {incident.verdictReason ? (
            <span className="text-ink-secondary">· {incident.verdictReason}</span>
          ) : null}
        </div>
      ) : null}

      {latestAction && actionInfo ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-ink-tertiary">
            {t('settings.watchdog.incidentsSection.linkedAction')}：
          </span>
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs',
              SEMANTIC_BADGE_CLASS[actionInfo.tone],
            )}
          >
            <Wrench className="size-2.5" />
            {t(`settings.watchdog.actionNames.${actionInfo.nameKey}`)} ·{' '}
            {t(`settings.watchdog.actionStatus.${latestAction.status}`)}
          </span>
          <span className="font-mono text-[11px] text-ink-quaternary">
            {formatAppTime(latestAction.at, locale)}
          </span>
        </div>
      ) : null}

      {expanded ? (
        <div className="mt-2.5 space-y-1.5 rounded-lg border border-line/70 bg-surface-muted/45 px-3 py-2 text-[11px] text-ink-tertiary">
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono">
            <span>
              {t('settings.watchdog.incidentsSection.details.incidentId')}:{' '}
              <span className="text-ink-secondary select-text">{incident.id}</span>
            </span>
            <span>
              {t('settings.watchdog.incidentsSection.details.rawKind')}:{' '}
              <span className="text-ink-secondary select-text">{incident.kind}</span>
            </span>
            {incident.subjectId ? (
              <span>
                {t('settings.watchdog.incidentsSection.details.subject')}:{' '}
                <span className="text-ink-secondary select-text">
                  {incident.subjectType}/{incident.subjectId}
                </span>
              </span>
            ) : null}
            <span>
              {t('settings.watchdog.incidentsSection.details.timeline')}:{' '}
              <span className="text-ink-secondary">
                {formatClock(incident.firstAt)} → {formatClock(incident.lastSeenAt)}
              </span>
            </span>
            {incident.resolvedAt ? (
              <span>
                {t('settings.watchdog.incidentsSection.details.recovered')}:{' '}
                <span className="text-ink-secondary">{formatClock(incident.resolvedAt)}</span>
              </span>
            ) : null}
            {judgedByKey ? (
              <span>
                {t('settings.watchdog.incidentsSection.details.judgeSource')}:{' '}
                <span className="text-ink-secondary">
                  {t(`settings.watchdog.judgedBy.${judgedByKey}`)}
                </span>
              </span>
            ) : null}
          </div>
          {parsedDetail ? (
            <div className="pt-1">
              <div className="mb-0.5 text-[10px] font-medium text-ink-quaternary">
                {t('settings.watchdog.incidentsSection.details.context')}
              </div>
              <pre className="max-h-36 overflow-auto rounded border border-line/60 bg-surface px-2 py-1.5 font-mono text-[11px] leading-snug text-ink-secondary select-text">
                {parsedDetail}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function WatchdogAskCard({
  question,
  onQuestionChange,
  quickQuestions,
  answer,
  onClearAnswer,
  asking,
  onAsk,
}: {
  question: string;
  onQuestionChange: (next: string) => void;
  quickQuestions: readonly string[];
  answer: WatchdogAskResult | null;
  onClearAnswer: () => void;
  asking: boolean;
  onAsk: (question: string) => Promise<void>;
}) {
  const { t } = useTranslation();

  return (
    <Section title={t('settings.watchdog.ask')} description={t('settings.watchdog.askDesc')}>
      <div className="space-y-3 px-4 py-3">
        {quickQuestions.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {quickQuestions.map((preset) => (
              <button
                key={preset}
                type="button"
                disabled={asking}
                onClick={() => void onAsk(preset)}
                className="inline-flex items-center rounded-full border border-line bg-surface-muted/50 px-2.5 py-1 text-xs text-ink-secondary transition hover:border-line-strong hover:bg-surface-hover hover:text-ink disabled:opacity-50"
              >
                {preset}
              </button>
            ))}
          </div>
        ) : null}

        <div className="flex items-center gap-2">
          <input
            value={question}
            onChange={(event) => onQuestionChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void onAsk(question);
            }}
            placeholder={t('settings.watchdog.askPlaceholder')}
            className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-sm-plus text-ink outline-none placeholder:text-ink-quaternary focus:border-accent"
          />
          <button
            type="button"
            onClick={() => void onAsk(question)}
            disabled={asking || !question.trim()}
            className={cn(buttonClass.primary, 'h-9 px-3.5')}
          >
            <Sparkles className={cn('size-3.5', asking && 'animate-pulse')} />
            {asking ? t('settings.watchdog.asking') : t('settings.watchdog.askButton')}
          </button>
        </div>

        {answer ? (
          <div
            className={cn(
              'relative rounded-lg border px-3.5 py-2.5 text-sm-plus leading-relaxed',
              answer.ok
                ? 'border-line bg-surface-sunken text-ink'
                : 'border-danger/30 bg-danger/[0.06] text-danger',
            )}
          >
            <button
              type="button"
              onClick={onClearAnswer}
              aria-label={t('common.close')}
              className="absolute top-2 right-2 rounded p-1 text-ink-quaternary hover:bg-surface-hover hover:text-ink"
            >
              <X className="size-3.5" />
            </button>
            <div className="pr-6">
              {answer.ok
                ? answer.answer
                : answer.error || t('settings.watchdog.askNoAnswer')}
            </div>
            {(answer.citations && answer.citations.length > 0) ||
            (answer.evidence && answer.evidence.length > 0) ||
            answer.model ? (
              <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-line/60 pt-2 text-[11px] text-ink-tertiary">
                {answer.evidence && answer.evidence.length > 0 ? (
                  <>
                    <span>{t('settings.watchdog.evidence')}：</span>
                    {(answer.citations && answer.citations.length > 0
                      ? answer.citations
                      : answer.evidence
                    ).map((refId) => (
                      <code
                        key={refId}
                        className="rounded bg-surface px-1.5 py-px font-mono text-[10px] text-ink-secondary ring-1 ring-line"
                      >
                        [{refId}]
                      </code>
                    ))}
                  </>
                ) : null}
                {answer.model ? (
                  <span className="ml-auto font-mono text-[10px] text-ink-quaternary">
                    {t('settings.watchdog.askModelAttr')}: {answer.model}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </Section>
  );
}

function WatchdogPolicyTab({
  draft,
  dirty,
  saving,
  note,
  error,
  modelRef,
  modelGroups,
  onUpdate,
  onResetDefaults,
  onSave,
  onSelectModel,
}: {
  draft: WatchdogPolicyDraft | null;
  dirty: boolean;
  saving: boolean;
  note: string;
  error: string;
  modelRef: ModelPickerValue | null;
  modelGroups: ReturnType<typeof pickerGroups>;
  onUpdate: (patch: Partial<WatchdogPolicyDraft>) => void;
  onResetDefaults: () => void;
  onSave: () => void;
  onSelectModel: (next: ModelPickerValue | null) => void;
}) {
  const { t } = useTranslation();
  const [advancedOpen, setAdvancedOpen] = useState(false);

  if (!draft) {
    return (
      <Section title={t('settings.watchdog.policy')}>
        <p className="px-4 py-6 text-sm-plus text-ink-tertiary">…</p>
      </Section>
    );
  }

  const isDefaultDraft = areWatchdogDraftsEqual(draft, DEFAULT_WATCHDOG_DRAFT);

  return (
    <div className="space-y-4">
      {error ? <Note tone="warn">{error}</Note> : null}

      <Section
        title={t('settings.watchdog.policy')}
        description={t('settings.watchdog.policyDesc')}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {dirty || note ? (
              <span
                aria-live="polite"
                className={cn('text-2xs', dirty ? 'text-warning' : 'text-success')}
              >
                {dirty ? t('settings.watchdog.unsaved') : note}
              </span>
            ) : null}
            <button
              type="button"
              onClick={onResetDefaults}
              disabled={isDefaultDraft || saving}
              className={buttonClass.secondary}
            >
              <RotateCcw className="size-3.5" />
              {t('settings.watchdog.resetDefaults')}
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={!dirty || saving}
              className={buttonClass.primary}
            >
              {t('settings.watchdog.save')}
            </button>
          </div>
        }
      >
        <Row label={t('settings.watchdog.enabled')} hint={t('settings.watchdog.enabledHint')}>
          <Toggle
            checked={draft.enabled}
            label={t('settings.watchdog.enabled')}
            onChange={(enabled) => onUpdate({ enabled })}
          />
        </Row>

        <Row label={t('settings.watchdog.model')} hint={t('settings.watchdog.modelHint')}>
          <div className="w-[22rem] max-w-full">
            <ModelPicker
              ariaLabel={t('settings.watchdog.model')}
              title={t('settings.watchdog.model')}
              testId="watchdog-model"
              groups={modelGroups}
              value={modelRef}
              allowThinking={false}
              clearLabel={t('settings.watchdog.modelDefault')}
              emptyLabel={t('settings.watchdog.modelDefault')}
              onClear={() => onSelectModel(null)}
              onSelect={(selection) =>
                onSelectModel({ providerId: selection.providerId, modelId: selection.modelId })
              }
            />
          </div>
        </Row>

        <Row label={t('settings.watchdog.idle')} hint={t('settings.watchdog.idleHint')}>
          <NumberInput
            ariaLabel={t('settings.watchdog.idle')}
            value={draft.idleMinutes}
            min={WATCHDOG_POLICY_RANGES.idleMinutes.min}
            max={WATCHDOG_POLICY_RANGES.idleMinutes.max}
            unit={t('settings.watchdog.unitMinutes')}
            onChange={(idleMinutes) => onUpdate({ idleMinutes })}
          />
        </Row>

        <Row label={t('settings.watchdog.repeat')} hint={t('settings.watchdog.repeatHint')}>
          <NumberInput
            ariaLabel={t('settings.watchdog.repeat')}
            value={draft.repeatFailure}
            min={WATCHDOG_POLICY_RANGES.repeatFailure.min}
            max={WATCHDOG_POLICY_RANGES.repeatFailure.max}
            unit={t('settings.watchdog.unitTimes')}
            onChange={(repeatFailure) => onUpdate({ repeatFailure })}
          />
        </Row>
      </Section>

      {/* Collapsible low-level heartbeat & cooldown tuning */}
      <section className="overflow-hidden rounded-xl border border-line bg-surface">
        <button
          type="button"
          onClick={() => setAdvancedOpen((prev) => !prev)}
          aria-expanded={advancedOpen}
          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-surface-hover/40"
        >
          <div className="min-w-0 flex-1">
            <h3 className="text-base-plus leading-snug font-semibold text-ink">
              {t('settings.watchdog.advancedTitle')}
            </h3>
            <p className="mt-0.5 text-xs-plus leading-relaxed text-ink-tertiary">
              {advancedOpen
                ? t('settings.watchdog.advancedDesc')
                : t('settings.watchdog.advancedSummary', {
                    stale: draft.staleSeconds,
                    recheck: draft.recheckMinutes,
                    escalate: draft.escalateMinutes,
                    judge: draft.judgeMinutes,
                  })}
            </p>
          </div>
          <ChevronDown
            className={cn(
              'size-4 shrink-0 text-ink-tertiary transition-transform',
              advancedOpen && 'rotate-180 text-ink',
            )}
          />
        </button>

        {advancedOpen ? (
          <div className="border-t border-line">
            <Row label={t('settings.watchdog.stale')} hint={t('settings.watchdog.staleHint')}>
              <NumberInput
                ariaLabel={t('settings.watchdog.stale')}
                value={draft.staleSeconds}
                min={WATCHDOG_POLICY_RANGES.staleSeconds.min}
                max={WATCHDOG_POLICY_RANGES.staleSeconds.max}
                unit={t('settings.watchdog.unitSeconds')}
                onChange={(staleSeconds) => onUpdate({ staleSeconds })}
              />
            </Row>

            <Row label={t('settings.watchdog.recheck')} hint={t('settings.watchdog.recheckHint')}>
              <NumberInput
                ariaLabel={t('settings.watchdog.recheck')}
                value={draft.recheckMinutes}
                min={WATCHDOG_POLICY_RANGES.recheckMinutes.min}
                max={WATCHDOG_POLICY_RANGES.recheckMinutes.max}
                unit={t('settings.watchdog.unitMinutes')}
                onChange={(recheckMinutes) => onUpdate({ recheckMinutes })}
              />
            </Row>

            <Row label={t('settings.watchdog.escalate')} hint={t('settings.watchdog.escalateHint')}>
              <NumberInput
                ariaLabel={t('settings.watchdog.escalate')}
                value={draft.escalateMinutes}
                min={WATCHDOG_POLICY_RANGES.escalateMinutes.min}
                max={WATCHDOG_POLICY_RANGES.escalateMinutes.max}
                unit={t('settings.watchdog.unitMinutes')}
                onChange={(escalateMinutes) => onUpdate({ escalateMinutes })}
              />
            </Row>

            <Row label={t('settings.watchdog.judge')} hint={t('settings.watchdog.judgeHint')}>
              <NumberInput
                ariaLabel={t('settings.watchdog.judge')}
                value={draft.judgeMinutes}
                min={WATCHDOG_POLICY_RANGES.judgeMinutes.min}
                max={WATCHDOG_POLICY_RANGES.judgeMinutes.max}
                unit={t('settings.watchdog.unitMinutes')}
                onChange={(judgeMinutes) => onUpdate({ judgeMinutes })}
              />
            </Row>

            <Row
              label={t('settings.watchdog.actionCooldown')}
              hint={t('settings.watchdog.actionCooldownHint')}
            >
              <NumberInput
                ariaLabel={t('settings.watchdog.actionCooldown')}
                value={draft.actionMinutes}
                min={WATCHDOG_POLICY_RANGES.actionMinutes.min}
                max={WATCHDOG_POLICY_RANGES.actionMinutes.max}
                unit={t('settings.watchdog.unitMinutes')}
                onChange={(actionMinutes) => onUpdate({ actionMinutes })}
              />
            </Row>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function NumberInput({
  ariaLabel,
  value,
  min,
  max,
  unit,
  onChange,
}: {
  ariaLabel: string;
  value: number;
  min: number;
  max: number;
  unit?: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        aria-label={ariaLabel}
        value={value}
        min={min}
        max={max}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          if (Number.isFinite(parsed)) onChange(parsed);
        }}
        className="h-[28px] w-16 rounded-md border border-line bg-surface px-2 text-right font-mono text-sm text-ink outline-none focus:border-accent"
      />
      {unit ? <span className="w-7 text-2xs text-ink-quaternary">{unit}</span> : null}
    </div>
  );
}
