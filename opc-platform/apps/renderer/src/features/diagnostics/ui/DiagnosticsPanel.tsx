import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DiagnosticsReport } from '@opc/shared/ipc';

/**
 * G0 gate, visible in the product: it proves the native modules, the SQLite
 * extension and the packaging state inside a real Electron runtime.
 */
export function DiagnosticsPanel() {
  const { t } = useTranslation();
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const bridge = window.opc;
      if (!bridge) throw new Error(t('desktopOnly.title'));
      setReport(await bridge.diagnostics.report());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRunning(false);
    }
  };

  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="space-y-3 border-t border-line pt-5">
      <div className="flex items-center justify-between">
        <h3 className="text-base-plus font-semibold text-ink">{t('diagnostics.title')}</h3>
        <button
          type="button"
          onClick={() => void run()}
          disabled={running}
          className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-secondary transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {running ? t('diagnostics.running') : t('diagnostics.run')}
        </button>
      </div>

      {report ? (
        <div className="space-y-2 rounded-xl border border-line bg-surface p-3">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-ink-secondary sm:grid-cols-4">
            <Info label="Electron" value={report.app.versions.electron} />
            <Info label="Node" value={report.app.versions.node} />
            <Info label="Chrome" value={report.app.versions.chrome} />
            <Info label="Platform" value={report.app.platform} />
          </dl>

          <ul className="divide-y divide-line">
            {report.probes.map((probe) => (
              <li key={probe.id} className="flex items-start gap-2 py-2">
                <span
                  aria-hidden
                  className={`mt-1.5 size-2 shrink-0 rounded-full ${
                    probe.status === 'ok'
                      ? 'bg-success'
                      : probe.status === 'failed'
                        ? 'bg-danger'
                        : 'bg-warning'
                  }`}
                />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-ink">{probe.title}</span>
                    {typeof probe.durationMs === 'number' ? (
                      <span className="font-mono text-2xs text-ink-quaternary">
                        {probe.durationMs}ms
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 font-mono text-xs break-all text-ink-tertiary">
                    {probe.detail}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="font-mono text-2xs text-ink-quaternary">
        renderer: require={typeof (window as { require?: unknown }).require} · process=
        {typeof (window as { process?: unknown }).process} · bridge={window.opc ? 'yes' : 'no'}
      </p>

      {error ? (
        <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-2xs text-ink-quaternary">{label}</dt>
      <dd className="font-mono text-ink">{value}</dd>
    </div>
  );
}
