import { useMemo, useState } from 'react';
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

type SkillFilterTab = 'all' | 'enabled' | 'office' | 'creative';
type SkillCategory = 'office' | 'creative';

type UnifiedSkillItem =
  | {
      kind: 'builtin';
      category: 'office';
      id: string;
      iconKey: string;
      title: string;
      description: string;
      enabled: boolean;
      busy: boolean;
      categoryLabel: string;
      error?: string;
      tooltip?: string;
      pack: SkillPackView;
    }
  | {
      kind: 'bundled';
      category: SkillCategory;
      id: string;
      iconKey: string;
      title: string;
      description: string;
      enabled: boolean;
      busy: boolean;
      categoryLabel: string;
      error?: string;
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

  const items = useMemo<UnifiedSkillItem[]>(() => {
    const officeLabel = t('capabilities.ui.filterOfficeSkills');
    const creativeLabel = t('capabilities.ui.filterCreativeSkills');

    const packItems: UnifiedSkillItem[] = (skillPacks?.packs ?? []).map((pack) => ({
      kind: 'builtin',
      category: 'office',
      id: pack.id,
      iconKey: pack.id,
      title: pack.title,
      description: pack.description,
      enabled: pack.enabled,
      busy: isInstalling || busySkillPack === pack.id,
      categoryLabel: officeLabel,
      ...(pack.error ? { error: pack.error } : {}),
      pack,
    }));

    const bundledItems: UnifiedSkillItem[] = (skills?.entries ?? [])
      .filter((entry) => entry.scope === 'bundled')
      .map((entry) => {
        const category: SkillCategory = entry.category === 'office' ? 'office' : 'creative';
        return {
          kind: 'bundled',
          category,
          id: entry.id,
          iconKey: entry.name,
          title: entry.title || entry.name,
          description: entry.summary || entry.description,
          enabled: entry.enabled,
          busy: busySkill === entry.id,
          categoryLabel: category === 'office' ? officeLabel : creativeLabel,
          tooltip: entry.dir,
          entry,
        };
      });

    return [...packItems, ...bundledItems];
  }, [busySkill, busySkillPack, isInstalling, skillPacks, skills, t]);

  const { allCount, enabledCount, officeCount, creativeCount } = useMemo(() => {
    let enabled = 0;
    let office = 0;
    let creative = 0;
    for (const item of items) {
      if (item.enabled) enabled += 1;
      if (item.category === 'office') office += 1;
      else creative += 1;
    }
    return {
      allCount: items.length,
      enabledCount: enabled,
      officeCount: office,
      creativeCount: creative,
    };
  }, [items]);

  const q = query.trim().toLowerCase();

  const filtered = useMemo(() => {
    return items.filter((item) => {
      if (tab === 'enabled' && !item.enabled) return false;
      if (tab === 'office' && item.category !== 'office') return false;
      if (tab === 'creative' && item.category !== 'creative') return false;
      if (!q) return true;
      return (
        item.title.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        item.id.toLowerCase().includes(q)
      );
    });
  }, [items, q, tab]);

  const officeFiltered = useMemo(
    () => filtered.filter((item) => item.category === 'office'),
    [filtered],
  );
  const creativeFiltered = useMemo(
    () => filtered.filter((item) => item.category === 'creative'),
    [filtered],
  );

  const handleToggleItem = (item: UnifiedSkillItem, next: boolean) => {
    if (item.kind === 'builtin') {
      onTogglePack(item.pack, next);
      return;
    }
    onToggleSkill(item.entry, next);
  };

  const renderGrid = (list: UnifiedSkillItem[]) => (
    <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
      {list.map((item) => (
        <UnifiedSkillCard
          key={`${item.kind}:${item.id}`}
          item={item}
          onToggle={handleToggleItem}
        />
      ))}
    </div>
  );

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
                value: 'office',
                label: t('capabilities.ui.filterOfficeSkills'),
                count: officeCount,
              },
              {
                value: 'creative',
                label: t('capabilities.ui.filterCreativeSkills'),
                count: creativeCount,
              },
            ]}
          />
        }
      />

      {filtered.length > 0 ? (
        tab === 'all' || tab === 'enabled' ? (
          <div className="space-y-6">
            {officeFiltered.length > 0 ? (
              <SkillCategorySection
                title={t('capabilities.skills.sectionOffice')}
                count={officeFiltered.length}
              >
                {renderGrid(officeFiltered)}
              </SkillCategorySection>
            ) : null}
            {creativeFiltered.length > 0 ? (
              <SkillCategorySection
                title={t('capabilities.skills.sectionCreative')}
                count={creativeFiltered.length}
              >
                {renderGrid(creativeFiltered)}
              </SkillCategorySection>
            ) : null}
          </div>
        ) : (
          renderGrid(filtered)
        )
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
        </footer>
      ) : null}
    </div>
  );
}

function SkillCategorySection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-ink-secondary">{title}</h3>
        <span className="rounded-md bg-surface-muted px-1.5 py-0.5 font-mono text-[10px] leading-none text-ink-tertiary tabular-nums">
          {count}
        </span>
      </div>
      {children}
    </section>
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
      data-testid={item.kind === 'builtin' ? `skill-pack-${item.id}` : `skill-bundled-${item.entry.name}`}
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
              {item.categoryLabel}
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
        {item.error ? (
          <p className="mt-1.5 line-clamp-2 text-xs text-danger">{item.error}</p>
        ) : null}
      </div>
    </article>
  );
}
