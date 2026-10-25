import { useEffect, useState } from 'react';
import { KeyRound, LogOut, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AuthPromptRequest } from '@opc/shared/ipc';
import { buttonClass } from '../kit';

/**
 * OAuth / API-key login for one provider.
 *
 * pi owns the flow (PKCE, device codes, token exchange); this component only
 * answers its prompts and shows progress. Credentials land in
 * `userData/credentials.json` via pi's `Models.login()`.
 */
export function AuthLoginPanel({ providerId }: { providerId: string }) {
  const { t } = useTranslation();
  const [promptRequest, setPromptRequest] = useState<AuthPromptRequest | null>(null);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; url?: string } | null>(null);
  const [loggedIn, setLoggedIn] = useState(false);

  useEffect(() => {
    const bridge = window.opc?.auth;
    if (!bridge) return;

    const offPrompt = bridge.onPrompt((request) => {
      setPromptRequest(request);
      setAnswer('');
    });
    const offNotify = bridge.onNotify((event) => setNotice(event));

    void bridge.status().then((items) => {
      setLoggedIn(items.some((entry) => entry.providerId === providerId));
    });

    return () => {
      offPrompt();
      offNotify();
    };
  }, [providerId]);

  const run = async (type: 'oauth' | 'apiKey') => {
    setBusy(true);
    setMessage(null);
    setNotice(null);
    try {
      const result = await window.opc!.auth.login(providerId, type);
      setMessage(result.message);
      setLoggedIn(result.ok);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-line px-3 py-2.5">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-sm font-medium text-ink-secondary">
          <ShieldCheck className="size-3.5 text-ink-tertiary" />
          {t('settings.auth.title')}
        </span>
        {loggedIn ? (
          <span className="text-2xs font-medium text-success">{t('settings.auth.loggedIn')}</span>
        ) : null}
      </div>

      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => void run('oauth')} className={buttonClass.primary}>
          <KeyRound className="size-3.5" />
          {busy ? t('settings.auth.working') : t('settings.auth.oauth')}
        </button>
        <button type="button" disabled={busy} onClick={() => void run('apiKey')} className={buttonClass.secondary}>
          {t('settings.auth.apiKey')}
        </button>
        {loggedIn ? (
          <button
            type="button"
            onClick={async () => {
              await window.opc!.auth.logout(providerId);
              setLoggedIn(false);
              setMessage(t('settings.auth.loggedOut'));
            }}
            className={buttonClass.danger}
          >
            <LogOut className="size-3.5" />
            {t('settings.auth.logout')}
          </button>
        ) : null}
      </div>

      <p className="mt-1.5 text-2xs leading-relaxed text-ink-quaternary">{t('settings.auth.hint')}</p>

      {notice ? (
        <p className="mt-2 rounded bg-accent-soft px-2 py-1 text-2xs text-accent-ink">
          {notice.text}
          {notice.url ? (
            <>
              {' '}
              <a href={notice.url} target="_blank" rel="noreferrer" className="underline">
                {notice.url}
              </a>
            </>
          ) : null}
        </p>
      ) : null}

      {message ? <p className="mt-2 text-2xs text-ink-secondary">{message}</p> : null}

      {promptRequest ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void window.opc!.auth.answer(promptRequest.id, answer);
              setPromptRequest(null);
            }}
            className="w-full max-w-md space-y-3 rounded-xl border border-line bg-surface px-4 py-4 shadow-popover"
          >
            <p className="text-sm text-ink">{promptRequest.message}</p>
            {promptRequest.kind === 'select' && promptRequest.options ? (
              <select
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                className="h-[30px] w-full rounded-md border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-accent"
              >
                <option value="">…</option>
                {promptRequest.options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                autoFocus
                type={promptRequest.kind === 'secret' ? 'password' : 'text'}
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                placeholder={promptRequest.placeholder}
                className="h-[30px] w-full rounded-md border border-line bg-surface px-2.5 font-mono text-sm text-ink outline-none focus:border-accent"
              />
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  void window.opc!.auth.answer(promptRequest.id, null);
                  setPromptRequest(null);
                }}
                className={buttonClass.secondary}
              >
                {t('common.cancel')}
              </button>
              <button type="submit" className={buttonClass.primary}>
                {t('settings.auth.submit')}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
