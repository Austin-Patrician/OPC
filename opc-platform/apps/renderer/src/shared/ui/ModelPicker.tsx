import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, ChevronRight, Search, X } from 'lucide-react';
import type { CatalogProvider, ModelOption, ProviderConfig } from '@opc/shared/domain';
import type { ThinkingLevel } from '@/shared/providers/catalog';
import { THINKING_LEVELS } from '@/shared/providers/catalog';
import { thinkingLevelsFor } from '@/shared/providers/thinking';
import { cn } from '@/shared/lib/cn';

/**
 * 模型选择器：一个像 select 的触发器 + 屏幕中间的模态列表。
 *
 * 为什么不用原生 `<select>` / 下拉浮层：
 *
 * - 原生 select 的每一行只能是一段文字，放不下「这个模型支持哪些思考档位」；
 * - 下拉浮层在设置页的长表单里会被滚动容器裁掉，模态永远在视口中间；
 * - 模型列表按 **Provider 分组**，Provider 之下是扁平的模型行——没有树，也没有
 *   二级菜单。一个 Provider 下没有可用模型时整组不出现，而不是显示一个空标题。
 *
 * 思考档位不在每一行常驻：鼠标移到模型行上（或键盘聚焦）才出现一个"当前档位"
 * 按钮，点开是档位选项列表（默认 / 模型支持的每一档）。没选中思考能力的模型
 * 根本不会出现这个按钮。
 *
 * 组件本身不碰网络、不碰设置：它只接收已经筛好的分组，回报 `{ providerId,
 * modelId, thinking? }`。这样 LLM 页、事件调度页、以后别的地方可以用同一套交互，
 * 各自决定"选完存到哪"。
 */

export interface ModelPickerModel {
  modelId: string;
  modelName: string;
  /**
   * 这个模型支持的思考档位。空数组 = 不出现档位控件（模型不支持思考，
   * 或者这个位置本来就不选思考，例如分类模型）。
   */
  thinkingLevels: readonly ThinkingLevel[];
  /** 行内的小号说明，例如上下文长度。 */
  meta?: string;
}

export interface ModelPickerGroup {
  providerId: string;
  providerName: string;
  models: ModelPickerModel[];
}

export interface ModelPickerValue {
  providerId: string;
  modelId: string;
}

export interface ModelPickerSelection extends ModelPickerValue {
  /**
   * `undefined` = 只换了模型（不碰思考档位）；
   * `null` = 明确选了「默认」（清掉这一档的覆盖）；
   * 具体值 = 选了那个档位。
   */
  thinking?: ThinkingLevel | null;
}

/**
 * 把已配置的 Provider 收成选择器要的分组。
 *
 * 两条规则都指向"别给人看不能用的东西"：没有密钥的 Provider 不出现，筛完之后
 * 一个模型都不剩的 Provider 也不出现。`catalog` 用来取 pi 算好的思考档位——
 * 手填的模型不在目录里，会退回默认三档。
 */
export function pickerGroups(
  providers: readonly ProviderConfig[],
  pick: (model: ModelOption) => boolean,
  catalog: readonly CatalogProvider[] = [],
): ModelPickerGroup[] {
  const levelsById = new Map<string, readonly string[]>();
  for (const provider of catalog) {
    for (const model of provider.models) {
      if (model.thinkingLevels) {
        levelsById.set(`${provider.id}::${model.id}`, model.thinkingLevels);
      }
    }
  }

  return providers
    .filter((provider) => provider.hasKey)
    .map((provider) => ({
      providerId: provider.id,
      providerName: provider.name,
      models: provider.models
        .filter(pick)
        .map((model) => ({
          modelId: model.id,
          modelName: model.name,
          thinkingLevels: thinkingLevelsFor(
            model,
            levelsById.get(`${provider.id}::${model.id}`),
          ),
        })),
    }))
    .filter((group) => group.models.length > 0);
}

/** 档位按钮上的短标签；未知档位原样显示，不吞掉信息。 */
const levelLabel = (level: ThinkingLevel): string =>
  THINKING_LEVELS.find((entry) => entry.value === level)?.label ?? level;

const rowKey = (providerId: string, modelId: string): string => `${providerId}::${modelId}`;

export function ModelPicker({
  ariaLabel,
  title,
  groups,
  value,
  thinking,
  allowThinking = true,
  clearLabel,
  emptyLabel,
  disabled = false,
  className,
  testId,
  onSelect,
  onClear,
}: {
  ariaLabel: string;
  /** 模态的标题，同时作为对话框的无障碍名称。 */
  title: string;
  groups: readonly ModelPickerGroup[];
  value: ModelPickerValue | null;
  /** 当前生效的思考档位，用来在档位菜单里打勾。 */
  thinking?: string | null;
  /** false = 这个位置不选思考（分类、图片、语音模型）。 */
  allowThinking?: boolean;
  /** 顶部"跟随默认 / 自动选择"那一行；不传就不显示。 */
  clearLabel?: string;
  /** 触发器上在没选模型时显示的文字。 */
  emptyLabel?: string;
  disabled?: boolean;
  className?: string;
  /** 触发器上的 data-testid（smoke 用）。 */
  testId?: string;
  onSelect: (selection: ModelPickerSelection) => void;
  onClear?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  /** 哪一行的档位菜单是打开的，以及它的屏幕坐标（fixed，允许溢出模态）。 */
  const [levelMenu, setLevelMenu] = useState<{
    key: string;
    top: number;
    left: number;
  } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(() => {
    if (!value) return null;
    const group = groups.find((candidate) => candidate.providerId === value.providerId);
    const model = group?.models.find((candidate) => candidate.modelId === value.modelId);
    return model && group ? { group, model } : null;
  }, [groups, value]);

  // 每次打开都从空搜索、空菜单开始；按 Esc 关闭。监听器只在这个模态打开时存在。
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setLevelMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  const needle = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      groups
        .map((group) => ({
          ...group,
          models:
            !needle ||
            group.providerName.toLowerCase().includes(needle) ||
            group.providerId.toLowerCase().includes(needle)
              ? group.models
              : group.models.filter(
                  (model) =>
                    model.modelName.toLowerCase().includes(needle) ||
                    model.modelId.toLowerCase().includes(needle),
                ),
        }))
        .filter((group) => group.models.length > 0),
    [groups, needle],
  );

  const choose = (
    providerId: string,
    model: ModelPickerModel,
    level?: ThinkingLevel | null,
  ) => {
    onSelect({
      providerId,
      modelId: model.modelId,
      ...(level !== undefined ? { thinking: level } : {}),
    });
    setOpen(false);
  };

  const selectedLevelLabel =
    allowThinking && thinking && selected?.model.thinkingLevels.includes(thinking as ThinkingLevel)
      ? levelLabel(thinking as ThinkingLevel)
      : null;

  /**
   * 选中的模型可能不在候选里（Provider 被清了密钥、模型被停用）。这时展示原始
   * `provider/model` 而不是退回"未配置"——配置还在，只是暂时不可用，界面不能
   * 假装它不存在。
   */
  const triggerText =
    selected?.model.modelName ??
    (value ? `${value.providerId} / ${value.modelId}` : (emptyLabel ?? ''));

  return (
    <>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        {...(testId ? { 'data-testid': testId } : {})}
        onClick={() => setOpen(true)}
        className={cn(
          'flex h-[30px] w-full items-center gap-2 rounded-md border border-line bg-surface px-2 text-left text-sm text-ink outline-none transition-colors hover:border-line-strong focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
      >
        <span
          className={cn('min-w-0 flex-1 truncate', !selected && 'text-ink-tertiary')}
          title={selected ? `${selected.group.providerName} / ${selected.model.modelName}` : undefined}
        >
          {triggerText}
        </span>
        {selectedLevelLabel ? (
          <span className="shrink-0 rounded bg-surface-muted px-1 py-0.5 text-2xs text-ink-tertiary">
            {selectedLevelLabel}
          </span>
        ) : null}
        <ChevronDown className="size-3.5 shrink-0 text-ink-quaternary" />
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onMouseDown={() => setOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={title}
            data-testid="model-picker"
            className="flex max-h-[80vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-popover"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="flex items-center gap-2 border-b border-line px-3 py-2.5">
              <Search className="size-3.5 shrink-0 text-ink-quaternary" />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label={t('models.picker.search')}
                placeholder={t('models.picker.search')}
                spellCheck={false}
                className="h-7 min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-quaternary"
              />
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t('common.close')}
                title={t('common.close')}
                className="flex size-6 shrink-0 items-center justify-center rounded text-ink-tertiary transition-colors hover:bg-ink/5 hover:text-ink"
              >
                <X className="size-3.5" />
              </button>
            </header>

            <div
              className="min-h-0 flex-1 overflow-y-auto px-2 py-2"
              onScroll={() => setLevelMenu(null)}
            >
              {clearLabel && !needle ? (
                <button
                  type="button"
                  data-testid="model-picker-clear"
                  onClick={() => {
                    onClear?.();
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-ink/5"
                >
                  <span className="size-3.5 shrink-0">
                    {!value ? <Check className="size-3.5 text-accent" /> : null}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">{clearLabel}</span>
                </button>
              ) : null}

              {visible.map((group) => (
                <section key={group.providerId}>
                  {/* 和模型行同一套缩进：空出勾选位 + 同样的 gap，名称才会竖着对齐。 */}
                  <div className="flex items-center gap-2 px-2 pt-3 pb-1">
                    <span className="size-3.5 shrink-0" aria-hidden />
                    <span className="text-2xs font-medium tracking-wide text-ink-tertiary uppercase">
                      {group.providerName}
                    </span>
                  </div>
                  {group.models.map((model) => {
                    const current =
                      value?.providerId === group.providerId && value.modelId === model.modelId;
                    const levels = allowThinking ? model.thinkingLevels : [];
                    const activeLevel =
                      current && thinking && levels.includes(thinking as ThinkingLevel)
                        ? (thinking as ThinkingLevel)
                        : null;
                    const key = rowKey(group.providerId, model.modelId);
                    const menuOpen = levelMenu?.key === key;
                    return (
                      <div
                        key={model.modelId}
                        data-testid="model-picker-row"
                        onMouseLeave={() =>
                          setLevelMenu((previous) => (previous?.key === key ? null : previous))
                        }
                        className="group relative flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-ink/5"
                      >
                        <button
                          type="button"
                          onClick={() => choose(group.providerId, model)}
                          aria-current={current ? 'true' : undefined}
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        >
                          <span className="size-3.5 shrink-0">
                            {current ? <Check className="size-3.5 text-accent" /> : null}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-sm text-ink">
                            {model.modelName}
                          </span>
                          {model.meta ? (
                            <span className="shrink-0 font-mono text-2xs text-ink-quaternary">
                              {model.meta}
                            </span>
                          ) : null}
                        </button>

                        {levels.length > 0 ? (
                          <div
                            className={cn(
                              'relative shrink-0 transition-opacity',
                              menuOpen
                                ? 'opacity-100'
                                : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
                            )}
                          >
                            <button
                              type="button"
                              aria-label={t('models.picker.thinking')}
                              aria-haspopup="listbox"
                              aria-expanded={menuOpen}
                              onClick={(event) => {
                                if (menuOpen) {
                                  setLevelMenu(null);
                                  return;
                                }
                                // fixed + 视口坐标：菜单可以越过模态边界，也不被列表的
                                // overflow 裁掉。右侧放不下时翻到左侧。
                                const rect = event.currentTarget.getBoundingClientRect();
                                const width = 144;
                                const height = (levels.length + 1) * 32 + 8;
                                const right = rect.right + 6 + width <= window.innerWidth - 8;
                                setLevelMenu({
                                  key,
                                  top: Math.min(
                                    rect.top,
                                    Math.max(8, window.innerHeight - height - 8),
                                  ),
                                  left: right
                                    ? rect.right + 6
                                    : Math.max(8, rect.left - width - 6),
                                });
                              }}
                              className="flex h-6 items-center gap-0.5 rounded px-1.5 text-2xs text-ink-tertiary transition-colors hover:bg-ink/10 hover:text-ink"
                            >
                              {activeLevel ? levelLabel(activeLevel) : t('models.picker.defaultLevel')}
                              <ChevronRight className="size-3" />
                            </button>

                            {menuOpen && levelMenu ? (
                              <div
                                role="listbox"
                                aria-label={t('models.picker.thinking')}
                                data-testid="model-picker-levels"
                                style={{ top: levelMenu.top, left: levelMenu.left }}
                                className="fixed z-[60] w-36 rounded-lg border border-line bg-surface py-1 shadow-popover"
                              >
                                <LevelOption
                                  label={t('models.picker.defaultLevel')}
                                  checked={!activeLevel}
                                  onClick={() => choose(group.providerId, model, null)}
                                />
                                {levels.map((level) => (
                                  <LevelOption
                                    key={level}
                                    label={levelLabel(level)}
                                    checked={activeLevel === level}
                                    onClick={() => choose(group.providerId, model, level)}
                                  />
                                ))}
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </section>
              ))}

              {visible.length === 0 ? (
                <p className="px-3 py-8 text-center text-sm text-ink-tertiary">
                  {t('models.picker.empty')}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** 档位菜单的一行：左边名字，右边勾。菜单本身不是树，就是一层选项。 */
function LevelOption({
  label,
  checked,
  onClick,
}: {
  label: string;
  checked: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={checked}
      onClick={onClick}
      className="flex h-8 w-full items-center justify-between px-2.5 text-left text-sm text-ink transition-colors hover:bg-ink/5"
    >
      <span className="truncate">{label}</span>
      {checked ? <Check className="size-3.5 shrink-0 text-accent" /> : null}
    </button>
  );
}
