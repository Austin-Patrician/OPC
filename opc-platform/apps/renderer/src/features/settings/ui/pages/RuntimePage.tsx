import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type {
  RuntimeInspection,
  RuntimeKind,
  RuntimeProfile,
  RuntimeStatus,
} from '@opc/shared/domain';
import { cn } from '@/shared/lib/cn';
import { useRuntime } from '../../model/useRuntime';
import {
  buttonClass,
  Field,
  Note,
  PageHeader,
  Row,
  Section,
  Segmented,
  SelectField,
  StatusBadge,
  TextField,
} from '../kit';

const KINDS: readonly RuntimeKind[] = ['node', 'python'];

function statusTone(status: RuntimeStatus | undefined): 'green' | 'red' | 'gray' {
  if (!status) return 'gray';
  return status.available ? 'green' : 'red';
}

function binaryHint(profile: RuntimeProfile, status: RuntimeStatus | undefined): string {
  if (status?.binary) return status.binary;
  if (profile.binary) return profile.binary;
  return '';
}

/**
 * Settings → 通用 → 运行时.
 *
 * The environment is company-wide by design: one Node and one Python choice for
 * every employee, so a task never silently runs under a different interpreter
 * than the one the boss configured. Built-ins are detection strategies (system
 * PATH / Electron's bundled Node); custom profiles point at a venv or conda.
 */
export function RuntimePage() {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const snapshot = runtime.snapshot;

  const [customKind, setCustomKind] = useState<RuntimeKind>('node');
  const [customBinary, setCustomBinary] = useState('');
  const [customName, setCustomName] = useState('');
  const [inspection, setInspection] = useState<RuntimeInspection | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [saving, setSaving] = useState(false);

  const profilesOf = (kind: RuntimeKind) =>
    snapshot?.profiles.filter((profile) => profile.kind === kind) ?? [];
  const statusOf = (profileId: string) =>
    snapshot?.statuses.find((status) => status.profileId === profileId);

  const choose = async () => {
    setChoosing(true);
    try {
      const binary = await runtime.chooseBinary(customKind);
      if (!binary) return;
      setCustomBinary(binary);
      setInspection(await runtime.inspect(customKind, binary) ?? null);
    } finally {
      setChoosing(false);
    }
  };

  const switchKind = (kind: RuntimeKind) => {
    setCustomKind(kind);
    // The previous inspection belongs to the other interpreter type.
    setInspection(null);
    setCustomBinary('');
    setCustomName('');
  };

  const save = async () => {
    if (!inspection?.ok) return;
    setSaving(true);
    try {
      await runtime.saveProfile({
        name: customName,
        kind: customKind,
        binary: inspection.binary,
      });
      setCustomBinary('');
      setCustomName('');
      setInspection(null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader
        crumbs={[t('settings.title'), t('settings.group.general')]}
        title={t('settings.page.runtime')}
        description={t('settings.runtime.desc')}
        actions={
          <button
            type="button"
            className={buttonClass.secondary}
            onClick={() => void runtime.reload(true)}
            disabled={runtime.probing}
          >
            {runtime.probing ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            {runtime.probing ? t('settings.runtime.probing') : t('settings.runtime.refresh')}
          </button>
        }
      />

      {runtime.error ? (
        <div className="mb-4">
          <Note tone="warn">{runtime.error}</Note>
        </div>
      ) : null}

      <div className="mb-4">
        <Note tone="info">{t('settings.runtime.globalNote')}</Note>
      </div>

      <div className="space-y-4">
        {KINDS.map((kind) => {
          const profiles = profilesOf(kind);
          const activeId = snapshot?.active[kind] ?? '';
          return (
            <Section
              key={kind}
              title={t(kind === 'node' ? 'settings.runtime.nodeTitle' : 'settings.runtime.pythonTitle')}
              description={t(
                kind === 'node' ? 'settings.runtime.nodeDesc' : 'settings.runtime.pythonDesc',
              )}
              action={
                <SelectField
                  ariaLabel={t('settings.runtime.current')}
                  className="w-[13rem]"
                  value={activeId}
                  onChange={(next) => void runtime.setActive(kind, next || null)}
                >
                  <option value="">{t('settings.runtime.auto')}</option>
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </SelectField>
              }
            >
              {runtime.loading && !snapshot ? (
                <Row label={t('settings.runtime.loading')}>
                  <Loader2 className="size-4 animate-spin text-ink-tertiary" />
                </Row>
              ) : null}
              {profiles.map((profile) => {
                const status = statusOf(profile.id);
                const hint = binaryHint(profile, status);
                const current = profile.id === activeId;
                return (
                  <Row
                    key={profile.id}
                    label={
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className={cn(current && 'font-medium')}>{profile.name}</span>
                        {profile.isCustom ? (
                          <StatusBadge tone="blue" label={t('settings.runtime.custom')} />
                        ) : (
                          <StatusBadge tone="gray" label={t('settings.runtime.builtin')} />
                        )}
                        {status?.version ? (
                          <StatusBadge
                            tone={statusTone(status)}
                            label={t('settings.runtime.version', { version: status.version })}
                          />
                        ) : (
                          <StatusBadge
                            tone={statusTone(status)}
                            label={
                              status?.available
                                ? t('settings.runtime.available')
                                : t('settings.runtime.unavailable')
                            }
                          />
                        )}
                        {current ? (
                          <StatusBadge tone="green" label={t('settings.runtime.current')} />
                        ) : null}
                      </span>
                    }
                    hint={
                      hint || status?.detail || t('settings.runtime.autoHint')
                    }
                  >
                    {profile.isCustom ? (
                      <button
                        type="button"
                        className={buttonClass.danger}
                        onClick={() => void runtime.removeProfile(profile.id)}
                        aria-label={t('settings.runtime.remove')}
                      >
                        <Trash2 className="size-3.5" />
                        {t('settings.runtime.remove')}
                      </button>
                    ) : null}
                  </Row>
                );
              })}
              {profiles.length === 0 && !runtime.loading ? (
                <Row label={t('settings.runtime.noProfiles')} />
              ) : null}
            </Section>
          );
        })}

        <Section title={t('settings.runtime.addTitle')} description={t('settings.runtime.addDesc')}>
          <div className="space-y-3 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <Segmented
                label={t('settings.runtime.kind')}
                value={customKind}
                onChange={switchKind}
                options={[
                  { value: 'node', label: 'Node' },
                  { value: 'python', label: 'Python' },
                ]}
              />
              <span className="text-xs-plus text-ink-tertiary">
                {t('settings.runtime.kindHint')}
              </span>
            </div>

            <Field label={t('settings.runtime.binary')} hint={t('settings.runtime.binaryHint')}>
              <div className="flex gap-2">
                <TextField
                  ariaLabel={t('settings.runtime.binary')}
                  mono
                  value={customBinary}
                  onChange={(next) => {
                    setCustomBinary(next);
                    setInspection(null);
                  }}
                  placeholder={
                    customKind === 'node'
                      ? '/Users/me/.nvm/versions/node/v22.0.0/bin/node'
                      : '/Users/me/.venv/bin/python'
                  }
                />
                <button
                  type="button"
                  className={buttonClass.secondary}
                  onClick={() => void choose()}
                  disabled={choosing}
                >
                  {choosing ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Plus className="size-3.5" />
                  )}
                  {t('settings.runtime.choose')}
                </button>
              </div>
            </Field>

            <Field label={t('settings.runtime.name')} hint={t('settings.runtime.nameHint')}>
              <TextField
                ariaLabel={t('settings.runtime.name')}
                value={customName}
                onChange={setCustomName}
                placeholder={t('settings.runtime.namePlaceholder')}
              />
            </Field>

            {inspection ? (
              <div
                className={cn(
                  'rounded-lg px-3 py-2 text-xs leading-relaxed',
                  inspection.ok ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger',
                )}
              >
                <div>
                  {inspection.ok
                    ? t('settings.runtime.inspectOk', { version: inspection.version ?? '?' })
                    : t('settings.runtime.inspectFail', {
                        detail: inspection.detail ?? t('settings.runtime.unavailable'),
                      })}
                </div>
                {inspection.binDirs.length > 0 ? (
                  <div className="mt-1 font-mono text-2xs break-all opacity-80">
                    {inspection.binDirs.join(' : ')}
                  </div>
                ) : null}
                {Object.keys(inspection.env).length > 0 ? (
                  <div className="mt-1 font-mono text-2xs break-all opacity-80">
                    {Object.entries(inspection.env)
                      .map(([key, value]) => `${key}=${value}`)
                      .join('  ')}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="flex items-center justify-end">
              <button
                type="button"
                className={buttonClass.primary}
                onClick={() => void save()}
                disabled={!inspection?.ok || saving}
              >
                {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {t('settings.runtime.save')}
              </button>
            </div>
          </div>
        </Section>
      </div>
    </>
  );
}
