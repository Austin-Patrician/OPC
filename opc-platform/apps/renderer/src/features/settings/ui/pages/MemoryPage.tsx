import { useEffect, useState } from 'react';
import { ChevronDown, History, RotateCcw, Route, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatAppDate } from '@/shared/lib/appTime';
import type { MemoryView, OrphanMemoryGroup } from '@opc/shared/ipc';
import { buttonClass, PageHeader, Section } from '../kit';
import { MemoryGraph } from './MemoryGraph';
import { entityTypeLabel, predicateLabel } from './ontologyLabels';

type OntologyEntityView = {
  id: string;
  entityType: string;
  canonicalName: string;
  description?: string;
  version?: number;
};

type OntologyAssertionView = {
  id: string;
  subjectEntityId: string;
  predicate: string;
  objectEntityId: string | null;
  objectValue: string | null;
  valueType: string;
  confidence: number;
  status: string;
  sourceEpisodeId: string;
  evidenceSpan: string | null;
  validFrom: number;
  validUntil: number | null;
};

function asEntity(value: unknown): OntologyEntityView | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string' && typeof item.canonicalName === 'string'
    ? { id: item.id, entityType: typeof item.entityType === 'string' ? item.entityType : 'Entity', canonicalName: item.canonicalName, description: typeof item.description === 'string' ? item.description : undefined, version: typeof item.version === 'number' ? item.version : undefined }
    : null;
}

function asAssertion(value: unknown): OntologyAssertionView | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string' && typeof item.subjectEntityId === 'string' && typeof item.predicate === 'string'
    ? { id: item.id, subjectEntityId: item.subjectEntityId, predicate: item.predicate, objectEntityId: typeof item.objectEntityId === 'string' ? item.objectEntityId : null, objectValue: typeof item.objectValue === 'string' ? item.objectValue : null, valueType: typeof item.valueType === 'string' ? item.valueType : 'text', confidence: typeof item.confidence === 'number' ? item.confidence : 0, status: typeof item.status === 'string' ? item.status : 'current', sourceEpisodeId: typeof item.sourceEpisodeId === 'string' ? item.sourceEpisodeId : '', evidenceSpan: typeof item.evidenceSpan === 'string' ? item.evidenceSpan : null, validFrom: typeof item.validFrom === 'number' ? item.validFrom : 0, validUntil: typeof item.validUntil === 'number' ? item.validUntil : null }
    : null;
}

/**
 * 设置 → 它记得什么。
 *
 * 这一页存在的理由不是功能，是**信任**。关于 A2 那条公理的反面：用户看不见助手记得
 * 什么，就不会信它——而一条记错的偏好会被它每一轮照着执行。
 *
 * 页面必须回答三个问题，顺序也是用户会问的顺序：
 *
 * 1. **它记住了我什么？** 两层分开列：常驻（每轮生效）/ 长期（命中才出现）。
 * 2. **记错了怎么改？** 常驻的撤掉，长期的改说法或撤掉。
 * 3. **它是从哪知道的？** 每一条都带来源与"被提过几次"——能追到来源才是可信的记忆。
 *
 * 「被提过几次」不是装饰：到了 3 次它会自己升进常驻层，用户看到 2 次就该知道下一条
 * 会开始每一轮生效。
 */
export function MemoryPage() {
  const { t } = useTranslation();
  const [items, setItems] = useState<MemoryView[] | null>(null);
  const [orphans, setOrphans] = useState<OrphanMemoryGroup[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [ontology, setOntology] = useState<{ entities: OntologyEntityView[]; assertions: OntologyAssertionView[]; profile: Record<string, unknown> } | null>(null);
  const [ontologyHistory, setOntologyHistory] = useState<OntologyAssertionView[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [ontologyError, setOntologyError] = useState<string | null>(null);
  /** 图里选中的实体；`null` = 不筛选，下方列出全部关系。 */
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>('ontology-user');

  const load = () =>
    Promise.all([
      window.opc!.memory.list().then(setItems).catch(() => setItems([])),
      window.opc!.memory.orphans().then(setOrphans).catch(() => setOrphans([])),
    ]).then(() => undefined);

  useEffect(() => {
    void load();
    void loadOntology();
  }, []);

  const loadOntology = async () => {
    try {
      const [context, history] = await Promise.all([
        window.opc!.ontology.context({ subjectEntityId: 'ontology-user', maxHops: 2, maxAssertions: 40 }),
        window.opc!.ontology.history({ subjectEntityId: 'ontology-user' }),
      ]);
      setOntology({
        entities: (context.entities ?? []).map(asEntity).filter((item): item is OntologyEntityView => Boolean(item)),
        assertions: (context.assertions ?? []).map(asAssertion).filter((item): item is OntologyAssertionView => Boolean(item)),
        profile: context.profile ?? {},
      });
      setOntologyHistory((history ?? []).map(asAssertion).filter((item): item is OntologyAssertionView => Boolean(item)));
      setOntologyError(null);
    } catch (error) {
      setOntologyError(error instanceof Error ? error.message : String(error));
    }
  };

  const retract = async (assertionId: string) => {
    setBusy(`ontology:${assertionId}`);
    try {
      await window.opc!.ontology.command({
        actor: 'user',
        objectType: 'User',
        objectId: 'ontology-user',
        action: 'retract_assertion',
        args: { assertionId },
        idempotencyKey: `retract:${assertionId}:${Date.now()}`,
      });
      await loadOntology();
    } finally {
      setBusy(null);
    }
  };

  const entityNames = new Map((ontology?.entities ?? []).map((entity) => [entity.id, entity.canonicalName]));
  const objectLabel = (assertion: OntologyAssertionView) => {
    if (assertion.objectEntityId) return entityNames.get(assertion.objectEntityId) ?? assertion.objectEntityId;
    if (assertion.objectValue === null) return '—';
    try {
      const parsed: unknown = JSON.parse(assertion.objectValue);
      return typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
    } catch {
      return assertion.objectValue;
    }
  };

  const selectedEntity = (ontology?.entities ?? []).find((entity) => entity.id === selectedEntityId) ?? null;
  // 选中的实体可能已经随新一轮数据消失：这时退回「全部关系」，而不是顶着一个空名字。
  const hasSelection = selectedEntity !== null;
  const relations = (ontology?.assertions ?? []).filter(
    (assertion) =>
      !selectedEntity ||
      assertion.subjectEntityId === selectedEntity.id ||
      assertion.objectEntityId === selectedEntity.id,
  );

  const settleOrphan = (ownerId: string, action: 'claim' | 'discard') => {
    setBusy(ownerId);
    void window
      .opc!.memory[action](ownerId)
      .then(() => load())
      .finally(() => setBusy(null));
  };

  const forget = (id: string) => {
    setBusy(id);
    void window.opc!.memory
      .forget(id)
      .then(() => load())
      .finally(() => setBusy(null));
  };

  const save = (id: string) => {
    setBusy(id);
    void window.opc!.memory
      .update(id, draft)
      .then(() => {
        setEditing(null);
        return load();
      })
      .finally(() => setBusy(null));
  };

  const standing = (items ?? []).filter((item) => item.tier === 'standing');
  const long = (items ?? []).filter((item) => item.tier === 'long');

  const row = (item: MemoryView) => (
    <li key={item.id} className="px-4 py-3" data-testid={`memory-${item.id}`}>
      {editing === item.id ? (
        <div className="space-y-2">
          <textarea
            aria-label={t('settings.memory.content')}
            value={draft}
            rows={3}
            onChange={(event) => setDraft(event.target.value)}
            className="w-full resize-y rounded-md border border-line bg-surface px-2.5 py-2 text-sm leading-relaxed text-ink outline-none focus:border-accent"
          />
          <div className="flex justify-end gap-2">
            <button type="button" className={buttonClass.secondary} onClick={() => setEditing(null)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className={buttonClass.primary}
              disabled={busy === item.id || draft.trim().length === 0}
              onClick={() => save(item.id)}
            >
              {t('common.save')}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm leading-relaxed text-ink">{item.content}</p>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-2xs text-ink-quaternary">
              <span>{item.kind}</span>
              {item.subject ? <span>· {item.subject}</span> : null}
              <span>· {formatAppDate(item.createdAt)}</span>
              <span>· {item.sourceType}</span>
              {item.observations > 1 ? (
                <span className="text-ink-tertiary">
                  · {t('settings.memory.observedTimes', { count: item.observations })}
                </span>
              ) : null}
            </p>
          </div>
          <div className="flex shrink-0 gap-1.5">
            <button
              type="button"
              className={buttonClass.secondary}
              data-testid={`memory-edit-${item.id}`}
              onClick={() => {
                setEditing(item.id);
                setDraft(item.content);
              }}
            >
              {t('common.edit')}
            </button>
            <button
              type="button"
              className={buttonClass.danger}
              data-testid={`memory-forget-${item.id}`}
              disabled={busy === item.id}
              onClick={() => forget(item.id)}
            >
              {t('settings.memory.forget')}
            </button>
          </div>
        </div>
      )}
    </li>
  );

  return (
    <>
      <PageHeader
        crumbs={[t('settings.group.behavior'), t('settings.memory.title')]}
        title={t('settings.memory.title')}
        description={t('settings.memory.desc')}
      />

      <div className="space-y-4">
        {orphans.length > 0 ? (
          <Section
            title={t('settings.memory.orphanTitle')}
            description={t('settings.memory.orphanDesc')}
          >
            <ul className="divide-y divide-line/60" data-testid="memory-orphans">
              {orphans.map((group) => (
                <li key={group.ownerId} className="space-y-2 px-4 py-3">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-2xs text-ink-quaternary">
                        {group.ownerId} · {t('settings.memory.orphanCount', { count: group.count })}
                      </p>
                      <ul className="mt-1 space-y-0.5">
                        {group.samples.map((sample, index) => (
                          <li key={index} className="truncate text-sm text-ink-secondary">
                            · {sample}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div className="flex shrink-0 gap-1.5">
                      <button
                        type="button"
                        className={buttonClass.primary}
                        data-testid={`memory-claim-${group.ownerId}`}
                        disabled={busy === group.ownerId}
                        onClick={() => settleOrphan(group.ownerId, 'claim')}
                      >
                        {t('settings.memory.claim')}
                      </button>
                      <button
                        type="button"
                        className={buttonClass.danger}
                        data-testid={`memory-discard-${group.ownerId}`}
                        disabled={busy === group.ownerId}
                        onClick={() => settleOrphan(group.ownerId, 'discard')}
                      >
                        {t('settings.memory.discard')}
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        <Section title={t('settings.memory.standingTitle')} description={t('settings.memory.standingDesc')}>
          {items === null ? (
            <p className="px-4 py-3 text-xs text-ink-quaternary">{t('common.loading')}</p>
          ) : standing.length === 0 ? (
            <p className="px-4 py-3 text-xs leading-relaxed text-ink-quaternary">
              {t('settings.memory.standingEmpty')}
            </p>
          ) : (
            <ul className="divide-y divide-line/60" data-testid="memory-standing">
              {standing.map(row)}
            </ul>
          )}
        </Section>

        <Section title={t('settings.memory.longTitle')} description={t('settings.memory.longDesc')}>
          {items === null ? (
            <p className="px-4 py-3 text-xs text-ink-quaternary">{t('common.loading')}</p>
          ) : long.length === 0 ? (
            <p className="px-4 py-3 text-xs leading-relaxed text-ink-quaternary">
              {t('settings.memory.longEmpty')}
            </p>
          ) : (
            <ul className="divide-y divide-line/60" data-testid="memory-long">
              {long.map(row)}
            </ul>
          )}
        </Section>

        <Section
          title={t('settings.memory.ontologyTitle')}
          description={t('settings.memory.ontologyDesc')}
          action={
            <button type="button" className={buttonClass.secondary} onClick={() => void loadOntology()} title={t('settings.memory.ontologyRefresh')}>
              <RotateCcw className="size-3.5" aria-hidden="true" />
              {t('settings.memory.ontologyRefresh')}
            </button>
          }
        >
          {ontologyError ? <p className="px-4 py-3 text-xs text-danger">{ontologyError}</p> : null}
          {!ontology ? (
            <p className="px-4 py-3 text-xs text-ink-quaternary">{t('common.loading')}</p>
          ) : ontology.assertions.length === 0 ? (
            <div className="px-4 py-5 text-sm text-ink-tertiary">
              <div className="flex items-center gap-2 font-medium text-ink"><Route className="size-4" />{t('settings.memory.ontologyEmpty')}</div>
              <p className="mt-1 text-xs text-ink-quaternary">{t('settings.memory.ontologyEmptyHint')}</p>
            </div>
          ) : (
            <>
              {Object.keys(ontology.profile).length > 0 ? (
                <div className="flex flex-wrap gap-2 border-b border-line px-4 py-3">
                  {Object.entries(ontology.profile).slice(0, 8).map(([key, value]) => (
                    <span key={key} className="inline-flex items-center gap-1 rounded-full bg-surface-muted px-2.5 py-1 text-2xs text-ink-secondary">
                      <span className="text-ink-quaternary">{predicateLabel(t, key)}</span><span>·</span><span>{typeof value === 'string' ? value : JSON.stringify(value)}</span>
                    </span>
                  ))}
                </div>
              ) : null}

              <div className="border-b border-line px-2 pt-2 pb-1">
                <MemoryGraph
                  entities={ontology.entities}
                  assertions={ontology.assertions}
                  selectedId={selectedEntityId}
                  onSelect={setSelectedEntityId}
                  ariaLabel={t('settings.memory.ontologyGraphAria', {
                    entities: ontology.entities.length,
                    relations: ontology.assertions.length,
                  })}
                />
                <p className="px-4 pb-2 text-center text-2xs text-ink-quaternary">
                  {t('settings.memory.ontologyGraphHint')}
                </p>
              </div>

              <div className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">
                    {hasSelection ? selectedEntity.canonicalName : t('settings.memory.ontologyAll')}
                  </p>
                  <p className="mt-0.5 text-2xs text-ink-quaternary">
                    {hasSelection ? `${entityTypeLabel(t, selectedEntity.entityType)} · ` : ''}
                    {t('settings.memory.ontologyRelationsCount', { count: relations.length })}
                  </p>
                </div>
                {hasSelection ? (
                  <button
                    type="button"
                    className={buttonClass.secondary}
                    onClick={() => setSelectedEntityId(null)}
                  >
                    {t('settings.memory.ontologyViewAll')}
                  </button>
                ) : null}
              </div>

              {relations.length === 0 ? (
                <p className="border-t border-line px-4 py-3 text-sm text-ink-tertiary">
                  {t('settings.memory.ontologyNoRelations')}
                </p>
              ) : (
                <ul className="divide-y divide-line/60 border-t border-line">
                  {relations.map((assertion) => (
                    <li key={assertion.id} className="flex items-start gap-3 px-4 py-3">
                      <ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm leading-relaxed text-ink">
                          <span className="text-ink-tertiary">{entityNames.get(assertion.subjectEntityId) ?? assertion.subjectEntityId}</span>{' '}
                          <span className="font-medium text-accent-ink" title={assertion.predicate}>{predicateLabel(t, assertion.predicate)}</span>{' '}
                          <span>{objectLabel(assertion)}</span>
                        </p>
                        <p className="mt-1 flex flex-wrap gap-x-2 gap-y-1 font-mono text-2xs text-ink-quaternary">
                          <span>{Math.round(assertion.confidence * 100)}%</span><span>· {assertion.sourceEpisodeId}</span>
                          {assertion.evidenceSpan ? <span>· {assertion.evidenceSpan}</span> : null}
                        </p>
                      </div>
                      <button type="button" className={buttonClass.danger} disabled={busy === `ontology:${assertion.id}`} onClick={() => void retract(assertion.id)}>
                        {t('settings.memory.ontologyRetract')}
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <button type="button" className="flex w-full items-center gap-2 border-t border-line px-4 py-2.5 text-xs text-ink-tertiary hover:text-ink" onClick={() => setShowHistory((value) => !value)}>
                <History className="size-3.5" />{t('settings.memory.ontologyHistory')}<ChevronDown className={`ml-auto size-3.5 transition-transform ${showHistory ? 'rotate-180' : ''}`} />
              </button>
              {showHistory ? <ul className="border-t border-line bg-surface-muted/30 px-4 py-2">{ontologyHistory.filter((item) => item.status !== 'current').slice(0, 20).map((item) => <li key={item.id} className="flex items-center gap-2 py-1.5 text-2xs text-ink-quaternary"><span className="font-mono">{item.status}</span><span title={item.predicate}>{predicateLabel(t, item.predicate)}</span><span>{objectLabel(item)}</span></li>)}</ul> : null}
            </>
          )}
        </Section>

        <p className="px-1 text-2xs leading-relaxed text-ink-quaternary">
          {t('settings.memory.footnote')}
        </p>
      </div>
    </>
  );
}
