import { useTranslation } from 'react-i18next';
import type { Deliverable } from '../model/types';

interface DeliverableCardProps {
  deliverable: Deliverable;
}

/**
 * The signature "work delivered" card from the design: a compact, scannable
 * spec sheet rather than a chat bubble.
 */
export function DeliverableCard({ deliverable }: DeliverableCardProps) {
  const { t } = useTranslation();
  const { meta } = deliverable;

  return (
    <article
      className="w-full max-w-[30.625rem] rounded-[0.625rem] border border-line/60 bg-surface px-5 pt-2.5 pb-3 text-ink shadow-card"
      aria-label={t('chat.deliverable')}
    >
      <p className="mb-2 text-3xs leading-none text-ink-quaternary select-none">
        {t('chat.thinkingDone')}
      </p>

      <p className="mb-2 text-2xs leading-normal text-ink-secondary">{deliverable.intro}</p>

      <h3 className="mb-1.5 text-xs font-bold text-ink">{deliverable.title}</h3>

      <div className="space-y-0.5 text-3xs leading-[1.6] text-ink-secondary">
        <p>
          {t('chat.workId')}{' '}
          <code className="rounded bg-surface-muted px-1 py-px font-mono text-ink">
            {meta.workId}
          </code>{' '}
          {t('chat.account')}「{meta.accountName}」 {t('chat.status')}{' '}
          <code className="rounded bg-surface-muted px-1 py-px font-mono">{meta.status}</code>
        </p>
        <p>
          {t('chat.campaigns')}：{meta.campaigns}
        </p>
        <p>
          {t('chat.link')}：
          <a
            href={meta.link}
            target="_blank"
            rel="noreferrer noopener"
            className="break-all text-accent-ink hover:underline"
          >
            {meta.link}
          </a>
        </p>
      </div>

      <h4 className="mt-2.5 mb-1 text-xs font-bold text-ink">{meta.specsTitle}</h4>
      <ul className="list-disc space-y-1 pl-3 text-3xs leading-[1.55] text-ink-secondary">
        {meta.specs.map((spec) => (
          <li key={spec}>{spec}</li>
        ))}
      </ul>

      <h4 className="mt-3 mb-1 text-xs font-bold text-ink">{meta.pitfallsTitle}</h4>
      <ol className="list-decimal space-y-1.5 pl-3.5 text-[0.6125rem] leading-[1.58] text-ink-secondary">
        {meta.pitfalls.map((pitfall) => (
          <li key={pitfall}>{pitfall}</li>
        ))}
      </ol>
    </article>
  );
}
