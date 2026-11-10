import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  WatchdogActionView,
  WatchdogAskResult,
  WatchdogIncidentView,
  WatchdogPolicyView,
} from '@opc/shared/ipc';
import { cn } from '@/shared/lib/cn';
import { isChatModelEnabled } from '@opc/shared/domain';
import { useModels } from '@/features/models/model/useModels';
import { useCatalog } from '@/features/models/model/useCatalog';
import { ModelPicker, pickerGroups, type ModelPickerValue } from '@/shared/ui/ModelPicker';
import { PageHeader, Row, Section, Toggle, buttonClass } from '../kit';

/**
 * 设置 → 进展监督（`docs/v2/11-watchdog-spec.md` W7）。
 *
 * 这一页只有两件事：**看**（它在看什么、它做过什么、问它一句）与**调规则**。
 * 没有"修"——修复由它按白名单自己发起，而且永远不含杀任务。界面能代劳的只有
 * "把阈值改成你会满意的样子"，那必须是一次明确的保存。
 */

/** 界面上用分钟/秒，库里是毫秒。转换只在这里发生。 */
interface Draft {
  enabled: boolean;
  idleMinutes: number;
  repeatFailure: number;
  staleSeconds: number;
  recheckMinutes: number;
  escalateMinutes: number;
  judgeMinutes: number;
  actionMinutes: number;
}

const MINUTE = 60_000;

function toDraft(policy: WatchdogPolicyView): Draft {
  return {
    enabled: policy.enabled,
    idleMinutes: Math.round(policy.idleTaskMs / MINUTE),
    repeatFailure: policy.repeatFailure,
    staleSeconds: Math.round(policy.staleMainMs / 1000),
    recheckMinutes: Math.round(policy.recheckAfterMs / MINUTE),
    escalateMinutes: Math.round(policy.escalateAfterMs / MINUTE),
    judgeMinutes: Math.round(policy.judgeCooldownMs / MINUTE),
    actionMinutes: Math.round(policy.actionCooldownMs / MINUTE),
  };
}

function toPatch(draft: Draft) {
  return {
    enabled: draft.enabled,
    idleTaskMs: draft.idleMinutes * MINUTE,
    repeatFailure: draft.repeatFailure,
    staleMainMs: draft.staleSeconds * 1000,
    recheckAfterMs: draft.recheckMinutes * MINUTE,
    escalateAfterMs: draft.escalateMinutes * MINUTE,
    judgeCooldownMs: draft.judgeMinutes * MINUTE,
    actionCooldownMs: draft.actionMinutes * MINUTE,
  };
}

const STATE_STYLE: Record<WatchdogIncidentView['state'], string> = {
  active: 'bg-amber-500/10 text-amber-600',
  rechecking: 'bg-sky-500/10 text-sky-600',
  escalated: 'bg-red-500/10 text-red-600',
  resolved: 'bg-emerald-500/10 text-emerald-600',
};

export function WatchdogPage() {
  const { t } = useTranslation();
  const models = useModels();
  const { catalog } = useCatalog();
  const [incidents, setIncidents] = useState<WatchdogIncidentView[]>([]);
  const [actions, setActions] = useState<WatchdogActionView[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  /** 上次从库里读到的样子，用来判断"有没有改动"。 */
  const [baseline, setBaseline] = useState<Draft | null>(null);
  /** 它自己的模型；null = 跟随默认 LLM。 */
  const [modelRef, setModelRef] = useState<ModelPickerValue | null>(null);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<WatchdogAskResult | null>(null);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');

  /** 只刷新观察区；规则是草稿，不能被定时刷新覆盖。 */
  const refreshActivity = useCallback(async () => {
    const bridge = window.opc?.watchdog;
    if (!bridge) return;
    const [nextIncidents, nextActions] = await Promise.all([
      bridge.incidents(),
      bridge.actions(),
    ]);
    setIncidents(nextIncidents);
    setActions(nextActions);
  }, []);

  const loadPolicy = useCallback(async () => {
    const bridge = window.opc?.watchdog;
    if (!bridge) return;
    const [nextPolicy, nextModel] = await Promise.all([bridge.getPolicy(), bridge.getModel()]);
    const next = toDraft(nextPolicy);
    setDraft(next);
    setBaseline(next);
    setModelRef(nextModel ?? null);
  }, []);

  // 可选项来自 LLM 页：这里只挑已经启用的 chat 模型，不在这里启用新模型。
  const modelGroups = pickerGroups(
    models.providers,
    (model) => model.capability === 'chat' && isChatModelEnabled(model),
    catalog,
  );

  useEffect(() => {
    void loadPolicy();
    void refreshActivity();
    // 它自己会变（状态机按时间推进），所以观察区按分钟刷新一次。
    const timer = setInterval(() => void refreshActivity(), 60_000);
    return () => clearInterval(timer);
  }, [loadPolicy, refreshActivity]);

  const ask = async () => {
    const bridge = window.opc?.watchdog;
    if (!bridge || !question.trim()) return;
    setAsking(true);
    setAnswer(null);
    try {
      setAnswer(await bridge.ask(question));
    } finally {
      setAsking(false);
    }
  };

  const save = async () => {
    const bridge = window.opc?.watchdog;
    if (!bridge || !draft) return;
    const next = await bridge.savePolicy(toPatch(draft));
    const savedDraft = toDraft(next);
    setDraft(savedDraft);
    setBaseline(savedDraft);
    setNote(t('settings.watchdog.saved'));
  };

  /** 改任何一项都先清掉"已保存"，避免提示和当前内容对不上。 */
  const update = (patch: Partial<Draft>) => {
    setDraft((previous) => (previous ? { ...previous, ...patch } : previous));
    setNote('');
  };

  const dirty = draft !== null && baseline !== null && JSON.stringify(draft) !== JSON.stringify(baseline);

  return (
    <div className="space-y-4">
      <PageHeader
        crumbs={[t('settings.group.behavior'), t('settings.page.watchdog')]}
        title={t('settings.page.watchdog')}
        description={t('settings.watchdog.desc')}
      />

      <Section title={t('settings.watchdog.incidents')}>
        {incidents.length === 0 ? (
          <p className="px-4 py-3 text-sm-plus text-ink-tertiary">{t('settings.watchdog.empty')}</p>
        ) : (
          <div className="divide-y divide-line">
            {incidents.map((incident) => (
              <div key={incident.id} className="flex items-start gap-3 px-4 py-3">
                <span
                  className={cn(
                    'mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-xxs font-medium',
                    STATE_STYLE[incident.state],
                  )}
                >
                  {incident.state}
                </span>
                <div className="min-w-0">
                  <div className="text-sm-plus text-ink">{incident.summary}</div>
                  {incident.verdict ? (
                    <div className="mt-1 text-xs-plus text-ink-secondary">
                      Watchdog：{incident.verdict}（{Math.round((incident.verdictConfidence ?? 0) * 100)}%）
                      {incident.verdictReason ? ` · ${incident.verdictReason}` : ''}
                    </div>
                  ) : null}
                  <div className="mt-0.5 text-xs-plus text-ink-tertiary">
                    {incident.kind}
                    {incident.subjectId ? ` · ${incident.subjectId}` : ''}
                    {incident.reopenCount > 0 ? ` · 复发 ${incident.reopenCount} 次` : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title={t('settings.watchdog.ask')}>
        <div className="space-y-3 px-4 py-3">
          <div className="flex items-center gap-2">
            <input
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void ask();
              }}
              placeholder={t('settings.watchdog.askPlaceholder')}
              className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-sm-plus text-ink outline-none focus:border-ink-tertiary"
            />
            <button
              type="button"
              onClick={() => void ask()}
              disabled={asking || !question.trim()}
              className="h-9 shrink-0 rounded-lg bg-ink px-3 text-sm-plus font-medium text-surface disabled:opacity-40"
            >
              {asking ? t('settings.watchdog.asking') : t('settings.watchdog.askButton')}
            </button>
          </div>

          {answer ? (
            <div className="rounded-lg bg-surface-sunken px-3 py-2 text-sm-plus leading-relaxed text-ink">
              {answer.ok ? answer.answer : `（${answer.error ?? '没有回答'}）`}
              {answer.evidence && answer.evidence.length > 0 ? (
                <div className="mt-2 text-xs-plus text-ink-tertiary">
                  {t('settings.watchdog.evidence')}：{answer.evidence.join('、')}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </Section>

      <Section title={t('settings.watchdog.actions')}>
        {actions.length === 0 ? (
          <p className="px-4 py-3 text-sm-plus text-ink-tertiary">{t('settings.watchdog.noActions')}</p>
        ) : (
          <div className="divide-y divide-line">
            {actions.map((action) => (
              <div key={`${action.incidentId}:${action.at}`} className="px-4 py-2.5">
                <div className="text-sm-plus text-ink">
                  {action.action} · {action.status}
                </div>
                <div className="mt-0.5 text-xs-plus text-ink-tertiary">{action.result}</div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {draft ? (
        <Section
          title={t('settings.watchdog.policy')}
          action={
            <>
              <span aria-live="polite" className={cn('text-2xs', dirty ? 'text-warning' : 'text-success')}>
                {dirty ? t('settings.watchdog.unsaved') : note}
              </span>
              <button
                type="button"
                onClick={() => void save()}
                disabled={!dirty}
                className={buttonClass.primary}
              >
                {t('settings.watchdog.save')}
              </button>
            </>
          }
        >
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
                onClear={() => {
                  setModelRef(null);
                  void window.opc?.watchdog.setModel(null);
                }}
                onSelect={(selection) => {
                  const next = { providerId: selection.providerId, modelId: selection.modelId };
                  setModelRef(next);
                  void window.opc?.watchdog.setModel(next);
                }}
              />
            </div>
          </Row>

          <Row label={t('settings.watchdog.enabled')} hint={t('settings.watchdog.enabledHint')}>
            <Toggle
              checked={draft.enabled}
              label={t('settings.watchdog.enabled')}
              onChange={(enabled) => update({ enabled })}
            />
          </Row>

          <Row label={t('settings.watchdog.idle')} hint={t('settings.watchdog.idleHint')}>
            <NumberInput
              value={draft.idleMinutes}
              min={5}
              max={1440}
              unit={t('settings.watchdog.unitMinutes')}
              onChange={(idleMinutes) => update({ idleMinutes })}
            />
          </Row>
          <Row label={t('settings.watchdog.repeat')} hint={t('settings.watchdog.repeatHint')}>
            <NumberInput
              value={draft.repeatFailure}
              min={2}
              max={20}
              onChange={(repeatFailure) => update({ repeatFailure })}
            />
          </Row>
          <Row label={t('settings.watchdog.stale')} hint={t('settings.watchdog.staleHint')}>
            <NumberInput
              value={draft.staleSeconds}
              min={30}
              max={1800}
              unit={t('settings.watchdog.unitSeconds')}
              onChange={(staleSeconds) => update({ staleSeconds })}
            />
          </Row>

          <Row label={t('settings.watchdog.recheck')} hint={t('settings.watchdog.recheckHint')}>
            <NumberInput
              value={draft.recheckMinutes}
              min={1}
              max={360}
              unit={t('settings.watchdog.unitMinutes')}
              onChange={(recheckMinutes) => update({ recheckMinutes })}
            />
          </Row>
          <Row label={t('settings.watchdog.escalate')} hint={t('settings.watchdog.escalateHint')}>
            <NumberInput
              value={draft.escalateMinutes}
              min={2}
              max={1440}
              unit={t('settings.watchdog.unitMinutes')}
              onChange={(escalateMinutes) => update({ escalateMinutes })}
            />
          </Row>

          <Row label={t('settings.watchdog.judge')} hint={t('settings.watchdog.judgeHint')}>
            <NumberInput
              value={draft.judgeMinutes}
              min={1}
              max={1440}
              unit={t('settings.watchdog.unitMinutes')}
              onChange={(judgeMinutes) => update({ judgeMinutes })}
            />
          </Row>
          <Row
            label={t('settings.watchdog.actionCooldown')}
            hint={t('settings.watchdog.actionCooldownHint')}
          >
            <NumberInput
              value={draft.actionMinutes}
              min={1}
              max={1440}
              unit={t('settings.watchdog.unitMinutes')}
              onChange={(actionMinutes) => update({ actionMinutes })}
            />
          </Row>
        </Section>
      ) : null}
    </div>
  );
}

function NumberInput({
  value,
  min,
  max,
  unit,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  unit?: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          if (Number.isFinite(parsed)) onChange(parsed);
        }}
        className="h-[26px] w-16 rounded-md border border-line bg-surface px-2 text-right font-mono text-sm text-ink outline-none focus:border-accent"
      />
      {unit ? <span className="text-2xs text-ink-quaternary">{unit}</span> : null}
    </div>
  );
}
