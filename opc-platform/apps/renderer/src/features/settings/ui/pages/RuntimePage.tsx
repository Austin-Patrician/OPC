import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type {
  BundledRuntime,
  RuntimeInspection,
  RuntimeKind,
  RuntimeProfile,
  RuntimeStatus,
  WindowsShellMode,
} from '@opc/shared/domain';
import type { OcrSettings } from '@opc/shared/ocr';
import { cn } from '@/shared/lib/cn';
import { useRuntime } from '../../model/useRuntime';
import {
  buttonClass,
  Field,
  Note,
  Row,
  Section,
  Segmented,
  SelectField,
  StatusBadge,
  TextField,
  Toggle,
} from '../kit';
import {
  binaryPathPlaceholder,
  summarizeInterpreter,
  summarizeOcrCard,
  summarizeShellCard,
  type OverviewTone,
  type RuntimeTab,
} from './runtimeModel';

interface AddProfileDraft {
  binary: string;
  name: string;
  inspection: RuntimeInspection | null;
}

const EMPTY_DRAFT: AddProfileDraft = { binary: '', name: '', inspection: null };

const TONE_DOT: Record<OverviewTone, string> = {
  green: 'bg-success',
  amber: 'bg-warning',
  red: 'bg-danger',
  gray: 'bg-ink-quaternary',
};

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
 * Settings → 运行时 → 环境与权限.
 *
 * The environment is workspace-wide by design: one Node and one Python choice
 * plus built-in OCR and shell execution boundaries, organized into four focused
 * tabs with compact status dots in the tab bar.
 */
export function RuntimePage() {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const snapshot = runtime.snapshot;
  const ocr = runtime.ocr;
  const engine = runtime.bundled?.[0];

  const [tab, setTab] = useState<RuntimeTab>('node');
  const [drafts, setDrafts] = useState<Record<RuntimeKind, AddProfileDraft>>({
    node: EMPTY_DRAFT,
    python: EMPTY_DRAFT,
  });
  const [choosingKind, setChoosingKind] = useState<RuntimeKind | null>(null);
  const [savingKind, setSavingKind] = useState<RuntimeKind | null>(null);

  const nodeSummary = useMemo(() => summarizeInterpreter(snapshot, 'node'), [snapshot]);
  const pythonSummary = useMemo(() => summarizeInterpreter(snapshot, 'python'), [snapshot]);
  const ocrSummary = useMemo(() => summarizeOcrCard(runtime.bundled, ocr), [ocr, runtime.bundled]);
  const shellSummary = useMemo(
    () => summarizeShellCard(runtime.shellExecution),
    [runtime.shellExecution],
  );

  const updateDraft = (kind: RuntimeKind, patch: Partial<AddProfileDraft>) => {
    setDrafts((previous) => ({ ...previous, [kind]: { ...previous[kind], ...patch } }));
  };

  const choose = async (kind: RuntimeKind) => {
    setChoosingKind(kind);
    try {
      const binary = await runtime.chooseBinary(kind);
      if (!binary) return;
      const inspection = (await runtime.inspect(kind, binary)) ?? null;
      updateDraft(kind, { binary, inspection });
    } finally {
      setChoosingKind((current) => (current === kind ? null : current));
    }
  };

  const save = async (kind: RuntimeKind) => {
    const draft = drafts[kind];
    if (!draft.inspection?.ok) return;
    setSavingKind(kind);
    try {
      const saved = await runtime.saveProfile({
        name: draft.name,
        kind,
        binary: draft.inspection.binary,
      });
      if (saved) {
        updateDraft(kind, EMPTY_DRAFT);
      }
    } finally {
      setSavingKind((current) => (current === kind ? null : current));
    }
  };

  const nodeTone: OverviewTone =
    runtime.loading && !snapshot ? 'gray' : nodeSummary.available ? 'green' : 'red';
  const pythonTone: OverviewTone =
    runtime.loading && !snapshot ? 'gray' : pythonSummary.available ? 'green' : 'red';

  const tabLabel = (label: string, tone: OverviewTone) => (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('size-1.5 shrink-0 rounded-full', TONE_DOT[tone])} />
      <span>{label}</span>
    </span>
  );

  return (
    <div className="space-y-4">
      <header className="mb-1">
        <div className="flex items-center gap-1 text-xs-plus text-ink-tertiary">
          <span>{t('settings.title')}</span>
          <span className="text-ink-quaternary">›</span>
          <span>{t('settings.group.runtime')}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl leading-tight font-bold tracking-tight text-ink">
            {t('settings.page.runtime')}
          </h2>
          <Segmented<RuntimeTab>
            label={t('settings.page.runtime')}
            value={tab}
            onChange={setTab}
            options={[
              { value: 'node', label: tabLabel(t('settings.runtime.tabs.node'), nodeTone) },
              { value: 'python', label: tabLabel(t('settings.runtime.tabs.python'), pythonTone) },
              { value: 'ocr', label: tabLabel(t('settings.runtime.tabs.ocr'), ocrSummary.tone) },
              {
                value: 'shell',
                label: tabLabel(t('settings.runtime.tabs.shell'), shellSummary.tone),
              },
            ]}
          />
        </div>
        <p className="mt-1.5 max-w-[44rem] text-sm-plus leading-relaxed text-ink-tertiary">
          {t('settings.runtime.desc')}
        </p>
      </header>

      {runtime.error ? <Note tone="warn">{runtime.error}</Note> : null}

      {tab === 'node' || tab === 'python' ? (
        <InterpreterTab
          kind={tab}
          summary={tab === 'node' ? nodeSummary : pythonSummary}
          snapshot={snapshot}
          loading={runtime.loading}
          probing={runtime.probing}
          platform={runtime.shellExecution?.platform}
          draft={drafts[tab]}
          choosing={choosingKind === tab}
          saving={savingKind === tab}
          onReload={() => void runtime.reload(true)}
          onSetActive={(profileId) => void runtime.setActive(tab, profileId)}
          onRemove={(profileId) => void runtime.removeProfile(profileId)}
          onChangeDraft={(patch) => updateDraft(tab, patch)}
          onChoose={() => void choose(tab)}
          onSave={() => void save(tab)}
        />
      ) : null}

      {tab === 'ocr' ? (
        <Section title={t('settings.runtime.ocrTitle')} description={t('settings.runtime.ocrDesc')}>
          {ocr === null ? (
            <Row label={t('settings.runtime.loading')}>
              <Loader2 className="size-4 animate-spin text-ink-tertiary" />
            </Row>
          ) : engine === undefined ? (
            <Row label={t('settings.runtime.bundledEmpty')} />
          ) : (
            <OcrEngineControls
              engine={engine}
              settings={ocr}
              saving={runtime.savingOcr}
              onChange={(patch) => void runtime.setOcr({ ...ocr, ...patch })}
            />
          )}
        </Section>
      ) : null}

      {tab === 'shell' ? (
        <Section
          title={t('settings.runtime.shellTitle')}
          description={t('settings.runtime.shellDesc')}
        >
          {runtime.shellExecution === null ? (
            <Row label={t('settings.runtime.loading')}>
              <Loader2 className="size-4 animate-spin text-ink-tertiary" />
            </Row>
          ) : runtime.shellExecution.sandboxBackend === 'windows-guarded' ? (
            <>
              <Row
                label={t('settings.runtime.shellModeLabel')}
                hint={t('settings.runtime.shellModeHint')}
              >
                <Segmented<WindowsShellMode>
                  label={t('settings.runtime.shellModeLabel')}
                  value={runtime.shellExecution.settings.windowsMode}
                  onChange={(windowsMode) => {
                    if (!runtime.savingShellExecution) {
                      void runtime.setShellExecution({ windowsMode });
                    }
                  }}
                  options={[
                    { value: 'ask', label: t('settings.runtime.shellModeAsk') },
                    { value: 'auto', label: t('settings.runtime.shellModeAuto') },
                    { value: 'disabled', label: t('settings.runtime.shellModeDisabled') },
                  ]}
                />
              </Row>
              <div className="border-t border-line px-4 py-3">
                <Note tone="info">{t('settings.runtime.shellWindowsNote')}</Note>
              </div>
            </>
          ) : runtime.shellExecution.sandboxBackend === 'none' ? (
            <div className="p-4">
              <Note tone="warn">{runtime.shellExecution.sandboxDetail}</Note>
            </div>
          ) : (
            <Row
              label={
                <span className="flex flex-wrap items-center gap-2">
                  {t('settings.runtime.shellSandboxLabel')}
                  <StatusBadge tone="green" label={t('settings.runtime.shellSandboxActive')} />
                </span>
              }
              hint={runtime.shellExecution.sandboxDetail}
            />
          )}
        </Section>
      ) : null}
    </div>
  );
}

function InterpreterTab({
  kind,
  summary,
  snapshot,
  loading,
  probing,
  platform,
  draft,
  choosing,
  saving,
  onReload,
  onSetActive,
  onRemove,
  onChangeDraft,
  onChoose,
  onSave,
}: {
  kind: RuntimeKind;
  summary: ReturnType<typeof summarizeInterpreter>;
  snapshot: ReturnType<typeof useRuntime>['snapshot'];
  loading: boolean;
  probing: boolean;
  platform?: string;
  draft: AddProfileDraft;
  choosing: boolean;
  saving: boolean;
  onReload: () => void;
  onSetActive: (profileId: string | null) => void;
  onRemove: (profileId: string) => void;
  onChangeDraft: (patch: Partial<AddProfileDraft>) => void;
  onChoose: () => void;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  const profiles = snapshot?.profiles.filter((entry) => entry.kind === kind) ?? [];
  const activeId = snapshot?.active[kind] ?? '';
  const statusOf = (profileId: string) =>
    snapshot?.statuses.find((entry) => entry.profileId === profileId);

  return (
    <div className="space-y-4">
      <Note tone="info">{t('settings.runtime.globalNote')}</Note>

      <Section
        title={t(kind === 'node' ? 'settings.runtime.nodeTitle' : 'settings.runtime.pythonTitle')}
        description={t(
          kind === 'node' ? 'settings.runtime.nodeDesc' : 'settings.runtime.pythonDesc',
        )}
        action={
          <div className="flex items-center gap-2">
            <div className="w-[11rem] shrink-0">
              <SelectField
                ariaLabel={t('settings.runtime.current')}
                value={activeId}
                onChange={(next) => onSetActive(next || null)}
              >
                <option value="">{t('settings.runtime.auto')}</option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </SelectField>
            </div>
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={onReload}
              disabled={probing}
            >
              {probing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              {probing ? t('settings.runtime.probing') : t('settings.runtime.refresh')}
            </button>
          </div>
        }
      >
        {loading && !snapshot ? (
          <Row label={t('settings.runtime.loading')}>
            <Loader2 className="size-4 animate-spin text-ink-tertiary" />
          </Row>
        ) : null}

        {profiles.map((profile) => {
          const status = statusOf(profile.id);
          const hint = binaryHint(profile, status);
          const isExplicit = profile.id === activeId;
          const isEffectiveAuto = !activeId && summary.profile?.id === profile.id;
          return (
            <Row
              key={profile.id}
              label={
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className={cn((isExplicit || isEffectiveAuto) && 'font-medium')}>
                    {profile.name}
                  </span>
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
                  {isExplicit ? (
                    <StatusBadge tone="green" label={t('settings.runtime.current')} />
                  ) : isEffectiveAuto ? (
                    <StatusBadge tone="green" label={t('settings.runtime.currentAuto')} />
                  ) : null}
                </span>
              }
              hint={hint || status?.detail || t('settings.runtime.autoHint')}
            >
              <div className="flex items-center gap-2">
                {!isExplicit && status?.available ? (
                  <button
                    type="button"
                    className={buttonClass.secondary}
                    onClick={() => onSetActive(profile.id)}
                  >
                    {t('settings.runtime.setActive')}
                  </button>
                ) : null}
                {profile.isCustom ? (
                  <button
                    type="button"
                    className={buttonClass.danger}
                    onClick={() => onRemove(profile.id)}
                    aria-label={t('settings.runtime.remove')}
                  >
                    <Trash2 className="size-3.5" />
                    {t('settings.runtime.remove')}
                  </button>
                ) : null}
              </div>
            </Row>
          );
        })}

        {profiles.length === 0 && !loading ? (
          <Row label={t('settings.runtime.noProfiles')} />
        ) : null}
      </Section>

      <Section
        title={t(
          kind === 'node' ? 'settings.runtime.addNodeTitle' : 'settings.runtime.addPythonTitle',
        )}
        description={t(
          kind === 'node' ? 'settings.runtime.addNodeDesc' : 'settings.runtime.addPythonDesc',
        )}
      >
        <div className="space-y-3 p-4">
          <Field label={t('settings.runtime.binary')} hint={t('settings.runtime.binaryHint')}>
            <div className="flex gap-2">
              <TextField
                ariaLabel={t('settings.runtime.binary')}
                mono
                value={draft.binary}
                onChange={(binary) => onChangeDraft({ binary, inspection: null })}
                placeholder={binaryPathPlaceholder(kind, platform)}
              />
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={onChoose}
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
              value={draft.name}
              onChange={(name) => onChangeDraft({ name })}
              placeholder={t(
                kind === 'node'
                  ? 'settings.runtime.namePlaceholderNode'
                  : 'settings.runtime.namePlaceholder',
              )}
            />
          </Field>

          {draft.inspection ? (
            <div
              className={cn(
                'rounded-lg px-3 py-2 text-xs leading-relaxed',
                draft.inspection.ok
                  ? 'bg-success/10 text-success'
                  : 'bg-danger/10 text-danger',
              )}
            >
              <div>
                {draft.inspection.ok
                  ? t('settings.runtime.inspectOk', {
                      version: draft.inspection.version ?? '?',
                    })
                  : t('settings.runtime.inspectFail', {
                      detail: draft.inspection.detail ?? t('settings.runtime.unavailable'),
                    })}
              </div>
              {draft.inspection.binDirs.length > 0 ? (
                <div className="mt-1 font-mono text-2xs break-all opacity-80">
                  {draft.inspection.binDirs.join(' : ')}
                </div>
              ) : null}
              {Object.keys(draft.inspection.env).length > 0 ? (
                <div className="mt-1 font-mono text-2xs break-all opacity-80">
                  {Object.entries(draft.inspection.env)
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
              onClick={onSave}
              disabled={!draft.inspection?.ok || saving}
            >
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t('settings.runtime.save')}
            </button>
          </div>
        </div>
      </Section>
    </div>
  );
}

function OcrEngineControls({
  engine,
  settings,
  saving,
  onChange,
}: {
  engine: BundledRuntime;
  settings: OcrSettings;
  saving: boolean;
  onChange: (patch: Partial<OcrSettings>) => void;
}) {
  const { t } = useTranslation();
  const ready = engine.state === 'ok';
  const on = ready && settings.enabled;

  return (
    <>
      <Row
        label={
          <span className="flex flex-wrap items-center gap-2">
            {engine.name}
            <code className="font-mono text-2xs font-normal text-ink-quaternary">
              {engine.version}
            </code>
            <code className="font-mono text-2xs font-normal text-ink-quaternary">
              {engine.engine}
            </code>
            <StatusBadge
              tone={ready ? (on ? 'green' : 'gray') : 'red'}
              label={
                ready
                  ? on
                    ? t('settings.runtime.ocrOn')
                    : t('settings.runtime.ocrOff')
                  : t('settings.runtime.ocrUnavailable')
              }
            />
          </span>
        }
        hint={
          ready
            ? t('settings.runtime.ocrEnableHint')
            : t('settings.runtime.ocrBroken', { count: engine.broken })
        }
      >
        <Toggle
          checked={settings.enabled}
          onChange={(next) => onChange({ enabled: next })}
          label={t('settings.runtime.ocrEnable')}
          disabled={!ready || saving}
        />
      </Row>

      <Row label={t('settings.runtime.ocrDetail')} hint={t('settings.runtime.ocrDetailHint')}>
        <Segmented
          label={t('settings.runtime.ocrDetail')}
          value={settings.detail}
          onChange={(detail) => onChange({ detail })}
          options={[
            { value: 'text', label: t('settings.runtime.ocrDetailText') },
            { value: 'lines', label: t('settings.runtime.ocrDetailLines') },
          ]}
        />
      </Row>
    </>
  );
}
