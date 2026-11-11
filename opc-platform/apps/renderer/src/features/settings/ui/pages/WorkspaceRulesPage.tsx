import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FactView } from '@opc/shared/ipc';
import { formatAppDate } from '@/shared/lib/appTime';
import { cn } from '@/shared/lib/cn';
import { PageHeader, Section } from '../kit';

export function WorkspaceRulesPage() {
  const { t } = useTranslation();
  const [facts, setFacts] = useState<FactView[]>([]);
  const [subject, setSubject] = useState('');
  const [object, setObject] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void window
      .opc!.facts.list({})
      .then((rows) => {
        if (alive) setFacts(rows);
      })
      .catch(() => {
        if (alive) setFacts([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const save = async () => {
    if (!subject.trim() || !object.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      setFacts(
        await window.opc!.facts.write({
          scopeType: 'global',
          subject: subject.trim(),
          object: object.trim(),
        }),
      );
      setSubject('');
      setObject('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        crumbs={[t('settings.title'), t('settings.group.behavior')]}
        title={t('settings.page.workspaceRules')}
        description={t('settings.facts.desc')}
      />
      <Section title={`${t('settings.facts.title')} · ${facts.length}`}>
        {facts.length === 0 ? (
          <p className="px-4 py-5 text-sm text-ink-quaternary">{t('settings.facts.empty')}</p>
        ) : (
          <ul data-testid="facts">
            {facts.map((fact) => (
              <li
                key={fact.id}
                data-testid="fact-row"
                className="flex items-start gap-3 border-t border-line px-4 py-2.5 first:border-t-0"
              >
                <span className="mt-0.5 rounded bg-surface-muted px-1.5 py-0.5 font-mono text-3xs text-ink-tertiary">
                  {fact.subject}
                </span>
                <span className="min-w-0 flex-1 text-sm leading-relaxed text-ink">
                  {fact.object}
                </span>
                <span className="shrink-0 font-mono text-3xs text-ink-quaternary">
                  {formatAppDate(fact.validFrom)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-end gap-2 border-t border-line px-4 py-3">
          <input
            data-testid="fact-subject"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            placeholder={t('settings.facts.subject')}
            className="h-8 w-36 rounded-md border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-accent"
          />
          <input
            data-testid="fact-object"
            value={object}
            onChange={(event) => setObject(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void save();
            }}
            placeholder={t('settings.facts.object')}
            className="h-8 min-w-40 flex-1 rounded-md border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-accent"
          />
          <button
            type="button"
            data-testid="fact-save"
            disabled={busy || !subject.trim() || !object.trim()}
            onClick={() => void save()}
            className={cn(
              'h-8 rounded-md bg-accent px-3 text-sm font-medium text-white transition-colors hover:bg-accent-hover',
              (busy || !subject.trim() || !object.trim()) && 'opacity-40',
            )}
          >
            {t('settings.facts.save')}
          </button>
        </div>
        {error ? <p className="px-4 pb-3 text-xs text-danger">{error}</p> : null}
      </Section>
    </>
  );
}
