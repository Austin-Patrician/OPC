import { useMemo, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  PiSkillCatalog,
  PiSkillView,
  SkillPackCatalogView,
  SkillPackProgress,
  SkillPackView,
} from '@opc/shared/ipc';
import { buttonClass, Note, Toggle } from '@/features/settings/ui/kit';
import { cn } from '@/shared/lib/cn';
import { FilterPills, FilterToolbar } from './CapabilityPrimitives';
import { SkillIconTile } from './SkillIcon';

type SkillFilterTab = 'all' | 'enabled' | 'builtin' | 'local';

type UnifiedSkillItem =
  | {
      kind: 'builtin';
      id: string;
      iconKey: string;
      title: string;
      description: string;
      enabled: boolean;
      busy: boolean;
      sourceLabel: string;
      tooltip?: string;
      pack: SkillPackView;
    }
  | {
      kind: 'local';
      id: string;
      iconKey: string;
      title: string;
      description: string;
      enabled: boolean;
      busy: boolean;
      sourceLabel: string;
      tooltip?: string;
      entry: PiSkillView;
    };

export function SkillsSection({
  skillPacks,
  skillPackProgress,
  busySkillPack,
  skillPackEnvBusy,
  skillPackError,
  skills,
  busySkill,
  skillError,
  onTogglePack,
  onToggleSkill,
}: {
  skillPacks: SkillPackCatalogView | null;
  skillPackProgress: SkillPackProgress | null;
  busySkillPack: string;
  skillPackEnvBusy: boolean;
  skillPackError: string;
  skills: PiSkillCatalog | null;
  busySkill: string;
  skillError: string;
  onTogglePack: (pack: SkillPackView, next: boolean) => void;
  onToggleSkill: (entry: PiSkillView, next: boolean) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<SkillFilterTab>('all');

  const isInstalling = skillPacks?.env.state === 'installing' || skillPackEnvBusy;
  const displayError = skillPackError || skillPacks?.env.error || skillError;
  const localRoots = useMemo(() => skills?.roots ?? [], [skills]);

  const items = useMemo<UnifiedSkillItem[]>(() => {
    const builtinItems: UnifiedSkillItem[] = (skillPacks?.packs ?? []).map((pack) => ({
      kind: 'builtin',
      id: pack.id,
      iconKey: pack.id,
      title: pack.title,
      description: pack.description,
      enabled: pack.enabled,
      busy: isInstalling || busySkillPack === pack.id,
      sourceLabel: t('capabilities.skills.sourceBuiltin'),
      pack,
    }));

    const localItems: UnifiedSkillItem[] = (skills?.entries ?? [])
      .filter((entry) => entry.scope !== 'managed')
      .map((entry) => ({
        kind: 'local',
        id: entry.id,
        iconKey: entry.name,
        title: entry.name,
        description: entry.description,
        enabled: entry.enabled,
        busy: busySkill === entry.id,
        sourceLabel:
          entry.scope === 'project'
            ? t('capabilities.external.scope.project')
            : t('capabilities.skills.sourceLocal'),
        tooltip: entry.dir,
        entry,
      }));

    return [...builtinItems, ...localItems];
  }, [busySkill, busySkillPack, isInstalling, skillPacks, skills, t]);

  const { allCount, enabledCount, builtinCount, localCount } = useMemo(() => {
    let enabled = 0;
    let builtin = 0;
    let local = 0;
    for (const item of items) {
      if (item.enabled) enabled += 1;
      if (item.kind === 'builtin') builtin += 1;
      else local += 1;
    }
    return {
      allCount: items.length,
      enabledCount: enabled,
      builtinCount: builtin,
      localCount: local,
    };
  }, [items]);

  const q = query.trim().toLowerCase();

  const filtered = useMemo(() => {
    return items.filter((item) => {
      if (tab === 'enabled' && !item.enabled) return false;
      if (tab === 'builtin' && item.kind !== 'builtin') return false;
      if (tab === 'local' && item.kind !== 'local') return false;
      if (!q) return true;
      return (
        item.title.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q)
      );
    });
  }, [items, q, tab]);

  const handleToggleItem = (item: UnifiedSkillItem, next: boolean) => {
    if (item.kind === 'builtin') {
      onTogglePack(item.pack, next);
      return;
    }
    onToggleSkill(item.entry, next);
  };

  return (
    <div className="space-y-5">
      {displayError ? (
        <p className="rounded-2xl border border-danger/30 bg-danger/5 px-4 py-2.5 text-xs text-danger">
          {displayError}
        </p>
      ) : null}

      {skillPackProgress ? (
        <div className="rounded-2xl border border-line bg-surface px-4 py-3 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="font-medium text-ink">{skillPackProgress.message}</span>
            <span className="font-mono text-2xs text-ink-tertiary tabular-nums">
              {skillPackProgress.percent}%
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-muted">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-300"
              style={{ width: `${Math.max(4, Math.min(100, skillPackProgress.percent))}%` }}
            />
          </div>
        </div>
      ) : null}

      {skillPacks?.env.sandboxBackend === 'none' ? (
        <Note tone="warn">
          {t('capabilities.skillPacks.sandboxUnavailable', {
            detail: skillPacks.env.sandboxDetail,
          })}
        </Note>
      ) : null}

      <FilterToolbar
        query={query}
        onQueryChange={setQuery}
        placeholder={t('capabilities.ui.searchSkills')}
        rightSlot={
          <FilterPills<SkillFilterTab>
            label={t('capabilities.ui.filterScopeLabel')}
            value={tab}
            onChange={setTab}
            options={[
              { value: 'all', label: t('capabilities.ui.filterAll'), count: allCount },
              { value: 'enabled', label: t('capabilities.ui.filterEnabled'), count: enabledCount },
              {
                value: 'builtin',
                label: t('capabilities.ui.filterBuiltinSkills'),
                count: builtinCount,
              },
              {
                value: 'local',
                label: t('capabilities.ui.filterLocalSkills'),
                count: localCount,
              },
            ]}
          />
        }
      />

      {filtered.length > 0 ? (
        <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
          {filtered.map((item) => (
            <UnifiedSkillCard
              key={`${item.kind}:${item.id}`}
              item={item}
              onToggle={handleToggleItem}
            />
          ))}
        </div>
      ) : tab === 'local' && localCount === 0 && !q ? (
        <div className="rounded-2xl border border-dashed border-line bg-surface/50 px-6 py-9 text-center">
          <div className="mx-auto mb-3 grid size-10 place-items-center rounded-xl border border-line bg-surface text-ink-tertiary">
            <FolderOpen className="size-4.5" />
          </div>
          <p className="text-sm font-medium text-ink">{t('capabilities.skills.emptyLocalTitle')}</p>
          <p className="mx-auto mt-1.5 max-w-[30rem] text-xs leading-relaxed text-ink-tertiary">
            {t('capabilities.skills.emptyLocalHint')}
          </p>
          {localRoots.length > 0 ? (
            <ul className="mt-4 flex flex-wrap justify-center gap-1.5">
              {localRoots.map((root) => (
                <li
                  key={root}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-3xs text-ink-tertiary"
                >
                  <FolderOpen className="size-3 shrink-0 text-ink-quaternary" />
                  <code className="truncate font-mono">{root}</code>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <div className="rounded-2xl border border-line/80 bg-surface/50 px-6 py-10 text-center">
          <p className="text-sm text-ink-tertiary">{t('capabilities.ui.noMatches')}</p>
          {q || tab !== 'all' ? (
            <button
              type="button"
              className={cn(buttonClass.secondary, 'mt-3')}
              onClick={() => {
                setQuery('');
                setTab('all');
              }}
            >
              {t('capabilities.ui.clearFilters')}
            </button>
          ) : null}
        </div>
      )}

      {allCount > 0 ? (
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line/60 pt-3.5 text-xs text-ink-quaternary">
          <span className="tabular-nums">
            {t('capabilities.skills.enabledSummary', {
              enabled: enabledCount,
              total: allCount,
            })}
          </span>
          {localRoots.length > 0 ? (
            <span
              className="inline-flex max-w-full items-center gap-1.5"
              title={localRoots.join('\n')}
            >
              <FolderOpen className="size-3 shrink-0" />
              <span>{t('capabilities.skills.localDirHint')}</span>
              <code className="truncate font-mono text-ink-tertiary">{localRoots[0]}</code>
            </span>
          ) : null}
        </footer>
      ) : null}
    </div>
  );
}

function UnifiedSkillCard({
  item,
  onToggle,
}: {
  item: UnifiedSkillItem;
  onToggle: (item: UnifiedSkillItem, next: boolean) => void;
}) {
  const { t } = useTranslation();

  return (
    <article
      data-testid={item.kind === 'builtin' ? `skill-pack-${item.id}` : `skill-local-${item.id}`}
      title={item.tooltip}
      className={cn(
        'group flex items-start gap-3.5 rounded-2xl border p-4 transition-all duration-150',
        item.enabled
          ? 'border-line bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.03)] hover:border-line-strong hover:shadow-[0_6px_18px_-6px_rgba(0,0,0,0.08)]'
          : 'border-line/75 bg-surface/65 hover:border-line-strong hover:bg-surface',
      )}
    >
      <SkillIconTile name={item.iconKey} active={item.enabled} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <h4 className="truncate text-[14px] font-semibold tracking-[-0.01em] text-ink">
              {item.title}
            </h4>
            <span className="shrink-0 rounded-md bg-surface-muted px-1.5 py-0.5 text-[10px] leading-none font-medium text-ink-tertiary">
              {item.sourceLabel}
            </span>
          </div>
          <Toggle
            checked={item.enabled}
            disabled={item.busy}
            onChange={(next) => onToggle(item, next)}
            label={item.title}
            title={item.busy ? t('capabilities.external.working') : undefined}
          />
        </div>
        {item.description ? (
          <p className="mt-1.5 line-clamp-2 text-[12.5px] leading-[1.55] text-ink-tertiary">
            {item.description}
          </p>
        ) : null}
      </div>
    </article>
  );
}
