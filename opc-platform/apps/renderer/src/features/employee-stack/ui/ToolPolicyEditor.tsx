import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';
import type { EmployeeStackView, EmployeeToolExtensionView } from '@opc/shared/ipc';
import { cn } from '@/shared/lib/cn';
import { extensionDescriptionKey, extensionTitleKey } from '../model/extensionCopy';

const REASON_KEY: Record<string, string> = {
  'no-image-provider': 'org.stackReasonNoImage',
  'no-speech-model': 'org.stackReasonNoSpeech',
  'ocr-models-missing': 'org.stackReasonOcr',
  'memory-disabled': 'org.stackReasonMemory',
  'comm-disabled': 'org.stackReasonComm',
  'no-subordinates': 'org.stackReasonNoSubordinates',
};

function Switch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={cn(
        'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors disabled:opacity-40',
        checked ? 'bg-accent' : 'bg-line-strong',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'absolute left-0.5 size-3 rounded-full bg-white shadow-sm transition-transform',
          checked ? 'translate-x-3' : 'translate-x-0',
        )}
      />
    </button>
  );
}

/**
 * One extension, one switch. Descriptions are tooltips here: the dossier panel
 * is narrow, and the callable-tools block below is the place for detail.
 */
function ExtensionRow({
  extension,
  disabled,
  onToggleExtension,
}: {
  extension: EmployeeToolExtensionView;
  disabled?: boolean;
  onToggleExtension: () => void;
}) {
  const { t } = useTranslation();
  const titleKey = extensionTitleKey(extension.name);
  const descriptionKey = extensionDescriptionKey(extension.name);
  const title = titleKey ? t(titleKey) : extension.name;
  const description = descriptionKey ? t(descriptionKey) : '';
  const reason = extension.reason ? REASON_KEY[extension.reason] : undefined;

  return (
    <li className="flex items-center gap-3 rounded-lg border border-line bg-surface px-2.5 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span
            title={description || undefined}
            className={cn(
              'truncate text-xs font-medium',
              extension.available ? 'text-ink' : 'text-ink-tertiary',
            )}
          >
            {title}
          </span>
          {extension.essential ? (
            <span className="shrink-0 rounded bg-surface-muted px-1 py-px text-3xs text-ink-tertiary">
              {t('org.stackCore')}
            </span>
          ) : null}
        </div>
        {!extension.available ? (
          <p className="mt-0.5 truncate text-3xs text-warning" title={reason ? t(reason) : undefined}>
            {reason ? t(reason) : t('org.stackUnavailable')}
          </p>
        ) : null}
      </div>
      {extension.available && !extension.essential ? (
        <Switch
          checked={extension.enabled}
          disabled={disabled}
          label={t('org.stackToggleExtension', { name: title })}
          onChange={onToggleExtension}
        />
      ) : null}
    </li>
  );
}

/**
 * The pure tool editor: no IO, no knowledge of employees. It receives a stack
 * view and emits the next policy, so any other entry point can mount it.
 *
 * Tools are shown as removable chips and added from a checkbox list, because a
 * 320px dossier panel cannot afford a switch per tool.
 */
export function ToolPolicyEditor({
  view,
  disabled,
  onChange,
}: {
  view: EmployeeStackView;
  disabled?: boolean;
  onChange: (policy: EmployeeStackView['policy']) => void;
}) {
  const { t } = useTranslation();
  const { policy } = view;
  const [pickerOpen, setPickerOpen] = useState(false);

  const toggleExtension = (extension: EmployeeToolExtensionView) => {
    if (extension.essential) return;
    const off = policy.disabledExtensions.includes(extension.name);
    onChange({
      ...policy,
      disabledExtensions: off
        ? policy.disabledExtensions.filter((name) => name !== extension.name)
        : [...policy.disabledExtensions, extension.name],
    });
  };

  const toggleTool = (toolName: string) => {
    const off = policy.disabledTools.includes(toolName);
    onChange({
      ...policy,
      disabledTools: off
        ? policy.disabledTools.filter((name) => name !== toolName)
        : [...policy.disabledTools, toolName],
    });
  };

  // Only installed extensions can contribute tools; a switched-off or
  // unavailable one would be a lie in this list.
  const activeExtensions = view.extensions.filter((extension) => extension.available && extension.enabled);
  const extensionTitle = (name: string) => {
    const key = extensionTitleKey(name);
    return key ? t(key) : name;
  };
  const activeTools = activeExtensions.flatMap((extension) =>
    extension.tools.filter((tool) => tool.available).map((tool) => ({ name: tool.name, enabled: tool.enabled })),
  );
  const enabledTools = activeTools.filter((tool) => tool.enabled);
  const addableGroups = activeExtensions
    .map((extension) => ({
      name: extension.name,
      title: extensionTitle(extension.name),
      tools: extension.tools.filter((tool) => tool.available && !tool.enabled),
    }))
    .filter((group) => group.tools.length > 0);
  const addableCount = addableGroups.reduce((sum, group) => sum + group.tools.length, 0);

  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-center justify-between">
          <span className="text-2xs font-semibold text-ink-secondary">{t('org.stackExtensions')}</span>
          <span className="text-3xs text-ink-quaternary">
            {t('org.stackEnabledExtensions', {
              enabled: view.extensions.filter((extension) => extension.enabled).length,
              total: view.extensions.length,
            })}
          </span>
        </div>
        <ul className="mt-1.5 space-y-1">
          {view.extensions.map((extension) => (
            <ExtensionRow
              key={extension.name}
              extension={extension}
              disabled={disabled}
              onToggleExtension={() => toggleExtension(extension)}
            />
          ))}
        </ul>
      </div>

      <div>
        <div className="flex items-center justify-between">
          <span className="text-2xs font-semibold text-ink-secondary">{t('org.stackTools')}</span>
          {activeTools.length > 0 ? (
            <span className="text-3xs text-ink-quaternary">
              {t('org.stackToolCount', { enabled: enabledTools.length, total: activeTools.length })}
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 text-3xs leading-relaxed text-ink-quaternary">{t('org.stackToolsHint')}</p>

        <div className="mt-2 flex flex-wrap items-center gap-1.5 pt-0.5">
          {enabledTools.length === 0 ? (
            <span className="text-3xs text-ink-quaternary">{t('org.stackNoTools')}</span>
          ) : (
            enabledTools.map((tool) => (
              <span
                key={tool.name}
                className="relative inline-flex h-6 items-center rounded-md border border-line bg-surface pl-2 pr-2.5 font-mono text-3xs text-ink-secondary"
              >
                {tool.name}
                <button
                  type="button"
                  aria-label={t('org.stackRemoveTool', { name: tool.name })}
                  disabled={disabled}
                  onClick={() => toggleTool(tool.name)}
                  className="absolute -right-1 -top-1 flex size-3.5 items-center justify-center rounded-full border border-line bg-surface text-ink-quaternary shadow-sm hover:border-danger/40 hover:text-danger disabled:opacity-40"
                >
                  <X className="size-2" />
                </button>
              </span>
            ))
          )}

          <button
            type="button"
            aria-expanded={pickerOpen}
            aria-label={t('org.stackAddTool')}
            disabled={disabled || (addableCount === 0 && !pickerOpen)}
            onClick={() => setPickerOpen((open) => !open)}
            className={cn(
              'inline-flex h-6 items-center gap-0.5 rounded-md border border-dashed px-1.5 text-3xs transition-colors disabled:opacity-40',
              pickerOpen
                ? 'border-accent bg-accent-soft text-accent-ink'
                : 'border-line text-ink-tertiary hover:border-accent hover:text-accent-ink',
            )}
          >
            <Plus className="size-3" aria-hidden />
            {t('org.stackAddTool')}
          </button>
        </div>

        {pickerOpen ? (
          <div className="mt-2 rounded-lg border border-line bg-surface p-2">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-3xs text-ink-tertiary">{t('org.stackPickTools')}</span>
              <button
                type="button"
                onClick={() => setPickerOpen(false)}
                className="rounded px-1 text-3xs text-ink-tertiary hover:bg-surface-hover hover:text-ink"
              >
                {t('org.stackDone')}
              </button>
            </div>
            {addableGroups.length === 0 ? (
              <p className="text-3xs text-ink-quaternary">{t('org.stackNoAddableTools')}</p>
            ) : (
              <div className="space-y-1.5">
                {addableGroups.map((group) => (
                  <div key={group.name}>
                    <div className="mb-1 text-3xs text-ink-quaternary">{group.title}</div>
                    <div className="flex flex-wrap gap-1">
                      {group.tools.map((tool) => (
                        <label
                          key={tool.name}
                          className="flex cursor-pointer items-center gap-1 rounded border border-line px-1.5 py-0.5 font-mono text-3xs text-ink-secondary hover:border-accent/50"
                        >
                          <input
                            type="checkbox"
                            checked={false}
                            disabled={disabled}
                            onChange={() => toggleTool(tool.name)}
                            className="size-2.5 accent-[var(--accent)]"
                          />
                          {tool.name}
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
