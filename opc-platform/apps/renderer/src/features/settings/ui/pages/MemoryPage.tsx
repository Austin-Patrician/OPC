import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MemoryView, OrphanMemoryGroup } from '@opc/shared/ipc';
import { buttonClass, PageHeader, Section } from '../kit';

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

  const load = () =>
    Promise.all([
      window.opc!.memory.list().then(setItems).catch(() => setItems([])),
      window.opc!.memory.orphans().then(setOrphans).catch(() => setOrphans([])),
    ]).then(() => undefined);

  useEffect(() => {
    void load();
  }, []);

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
              <span>· {new Date(item.createdAt).toISOString().slice(0, 10)}</span>
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
        crumbs={[t('settings.title'), t('settings.group.general')]}
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

        <p className="px-1 text-2xs leading-relaxed text-ink-quaternary">
          {t('settings.memory.footnote')}
        </p>
      </div>
    </>
  );
}
