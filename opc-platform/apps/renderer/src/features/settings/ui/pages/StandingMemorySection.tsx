import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { StandingMemoryView } from '@opc/shared/ipc';
import { buttonClass, Section } from '../kit';

/**
 * 「它一直记着的几条」。
 *
 * 这一节存在的理由不是功能，是**信任**：常驻约束每一轮都在替你说话。用户看不见它，
 * 就等于把"助手怎么称呼我、说话什么语气、写东西守什么规矩"交给了一个黑箱。说错了他
 * 必须能当场改掉，而不是靠回忆自己什么时候说过。
 *
 * 撤销走的是归档（`is_archived = 1`），不是删除——**撤掉过什么**本身就是信息。
 */
export function StandingMemorySection() {
  const { t } = useTranslation();
  const [items, setItems] = useState<StandingMemoryView[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () =>
    window
      .opc!.memory.standing()
      .then(setItems)
      .catch(() => setItems([]));

  useEffect(() => {
    void load();
  }, []);

  const revoke = (id: string) => {
    setBusy(id);
    void window.opc!.memory
      .forget(id)
      .then(() => load())
      .finally(() => setBusy(null));
  };

  return (
    <Section title={t('settings.standing.title')} description={t('settings.standing.desc')}>
      {items === null ? (
        <p className="px-4 py-3 text-xs text-ink-quaternary">{t('common.loading')}</p>
      ) : items.length === 0 ? (
        <p className="px-4 py-3 text-xs leading-relaxed text-ink-quaternary">
          {t('settings.standing.empty')}
        </p>
      ) : (
        <ul className="divide-y divide-line/60" data-testid="standing-list">
          {items.map((item) => (
            <li key={item.id} className="flex items-start gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm leading-relaxed text-ink">{item.content}</p>
                <p className="mt-0.5 font-mono text-2xs text-ink-quaternary">
                  {new Date(item.createdAt).toISOString().slice(0, 10)} · {item.sourceType}
                </p>
              </div>
              <button
                type="button"
                data-testid={`standing-revoke-${item.id}`}
                disabled={busy === item.id}
                onClick={() => revoke(item.id)}
                className={buttonClass.danger}
              >
                {t('settings.standing.revoke')}
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="px-4 py-3 text-xs leading-relaxed text-ink-tertiary">
        {t('settings.standing.footnote')}
      </p>
    </Section>
  );
}
