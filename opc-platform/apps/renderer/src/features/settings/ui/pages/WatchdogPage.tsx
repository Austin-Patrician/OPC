import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { PageHeader, Row, Section } from '../kit';

/**
 * 设置 → 进展监督（`docs/v2/11-watchdog-spec.md` W7）。
 *
 * 这一页只有两件事：**看**（它在看什么、它做过什么、问它一句）与**调规则**。
 * 没有"修"——修复由它按白名单自己发起，而且永远不含杀任务。界面能代劳的只有
 * "把阈值改成你会满意的样子"，那必须是一次明确的保存。
 *
 * 保留上一版是刻意的：回退不是"恢复默认"，是"回到我改之前"。默认值只在从没
 * 改过的时候才是对的。
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
  const [incidents, setIncidents] = useState<WatchdogIncidentView[]>([]);
  const [actions, setActions] = useState<WatchdogActionView[]>([]);
  const [policy, setPolicy] = useState<WatchdogPolicyView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  /** 它自己的模型；空字符串 = 跟随默认 LLM。 */
  const [modelRef, setModelRef] = useState('');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<WatchdogAskResult | null>(null);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');

  const refresh = useCallback(async () => {
    const bridge = window.opc?.watchdog;
    if (!bridge) return;
    const [nextIncidents, nextActions, nextPolicy] = await Promise.all([
      bridge.incidents(),
      bridge.actions(),
      bridge.getPolicy(),
    ]);
    const nextModel = (await bridge.getModel()) ?? null;
    setIncidents(nextIncidents);
    setActions(nextActions);
    setPolicy(nextPolicy);
    setDraft(toDraft(nextPolicy));
    setModelRef(nextModel ? `${nextModel.providerId}\u0000${nextModel.modelId}` : '');
  }, []);

  // 可选项来自 LLM 页：这里只挑已经启用的 chat 模型，不在这里启用新模型。
  const options = useMemo(() => {
    const list: { value: string; label: string }[] = [];
    for (const provider of models.providers) {
      for (const model of provider.models) {
        if (model.capability !== 'chat' || !isChatModelEnabled(model)) continue;
        list.push({
          value: `${provider.id}\u0000${model.id}`,
          label: `${provider.name ?? provider.id} · ${model.name ?? model.id}`,
        });
      }
    }
    return list;
  }, [models.providers]);

  useEffect(() => {
    void refresh();
    // 它自己会变（状态机按时间推进），所以这一页也按分钟刷新一次。
    const timer = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(timer);
  }, [refresh]);

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
    setPolicy(next);
    setDraft(toDraft(next));
    setNote(t('settings.watchdog.saved'));
  };

  const rollback = async () => {
    const bridge = window.opc?.watchdog;
    if (!bridge) return;
    const next = await bridge.rollbackPolicy();
    setPolicy(next);
    setDraft(toDraft(next));
    setNote(t('settings.watchdog.rolledBack'));
  };

  return (
    <div className="space-y-4">
      <PageHeader
        crumbs={[t('settings.group.general'), t('settings.page.watchdog')]}
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
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void rollback()}
                disabled={!policy?.hasPrevious}
                className="h-8 rounded-lg border border-line px-2.5 text-xs-plus text-ink-secondary disabled:opacity-40"
              >
                {t('settings.watchdog.rollback')}
              </button>
              <button
                type="button"
                onClick={() => void save()}
                className="h-8 rounded-lg bg-ink px-3 text-xs-plus font-medium text-surface"
              >
                {t('settings.watchdog.save')}
              </button>
            </div>
          }
        >
          <div className="divide-y divide-line">
            <Row label={t('settings.watchdog.model')} hint={t('settings.watchdog.modelHint')}>
              <select
                value={modelRef}
                onChange={(event) => {
                  const value = event.target.value;
                  setModelRef(value);
                  const [providerId, modelId] = value.split('\u0000');
                  void window.opc?.watchdog.setModel(
                    value ? { providerId: providerId!, modelId: modelId! } : null,
                  );
                }}
                className="h-8 max-w-56 rounded-lg border border-line bg-surface px-2 text-sm-plus text-ink outline-none focus:border-ink-tertiary"
              >
                <option value="">{t('settings.watchdog.modelDefault')}</option>
                {options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </Row>
            <Row label={t('settings.watchdog.enabled')}>
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                className="size-4 accent-ink"
              />
            </Row>
            <Row label={t('settings.watchdog.idle')}>
              <NumberInput
                value={draft.idleMinutes}
                min={5}
                max={1440}
                onChange={(idleMinutes) => setDraft({ ...draft, idleMinutes })}
              />
            </Row>
            <Row label={t('settings.watchdog.repeat')}>
              <NumberInput
                value={draft.repeatFailure}
                min={2}
                max={20}
                onChange={(repeatFailure) => setDraft({ ...draft, repeatFailure })}
              />
            </Row>
            <Row label={t('settings.watchdog.stale')}>
              <NumberInput
                value={draft.staleSeconds}
                min={30}
                max={1800}
                onChange={(staleSeconds) => setDraft({ ...draft, staleSeconds })}
              />
            </Row>
            <Row label={t('settings.watchdog.recheck')}>
              <NumberInput
                value={draft.recheckMinutes}
                min={1}
                max={360}
                onChange={(recheckMinutes) => setDraft({ ...draft, recheckMinutes })}
              />
            </Row>
            <Row label={t('settings.watchdog.escalate')}>
              <NumberInput
                value={draft.escalateMinutes}
                min={2}
                max={1440}
                onChange={(escalateMinutes) => setDraft({ ...draft, escalateMinutes })}
              />
            </Row>
            <Row label={t('settings.watchdog.judge')}>
              <NumberInput
                value={draft.judgeMinutes}
                min={1}
                max={1440}
                onChange={(judgeMinutes) => setDraft({ ...draft, judgeMinutes })}
              />
            </Row>
            <Row label={t('settings.watchdog.actionCooldown')}>
              <NumberInput
                value={draft.actionMinutes}
                min={1}
                max={1440}
                onChange={(actionMinutes) => setDraft({ ...draft, actionMinutes })}
              />
            </Row>
          </div>
          {note ? <div className="px-4 py-2 text-xs-plus text-ink-tertiary">{note}</div> : null}
        </Section>
      ) : null}
    </div>
  );
}

function NumberInput({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      onChange={(event) => {
        const parsed = Number(event.target.value);
        if (Number.isFinite(parsed)) onChange(parsed);
      }}
      className="h-8 w-20 rounded-lg border border-line bg-surface px-2 text-right text-sm-plus text-ink outline-none focus:border-ink-tertiary"
    />
  );
}
