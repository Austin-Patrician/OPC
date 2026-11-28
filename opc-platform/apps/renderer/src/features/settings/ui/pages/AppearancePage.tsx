import { useState, type DragEvent } from 'react';
import { Check, Film, ImagePlus, RefreshCw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { WallpaperAsset } from '@opc/shared/domain';
import { LOCALES, type Locale } from '@/shared/i18n/types';
import { useUiPrefs } from '@/shared/prefs/useUiPrefs';
import { FONT_FAMILIES, FONT_SCALES } from '@/shared/theme/presets';
import {
  MAX_WALLPAPER_IMAGE_MB,
  MAX_WALLPAPER_VIDEO_MB,
  type BuddySizeId,
  type FontFamilyId,
  type FontScaleId,
  type ThemeMode,
} from '@/shared/theme/types';
import { wallpaperAssetUrl } from '@/shared/ui/wallpaperPlayback';
import { extractWallpaperPosterAndMeta } from '@/shared/ui/wallpaperPoster';
import { cn } from '@/shared/lib/cn';
import { buttonClass, PageHeader, Row, Section, Segmented, SelectField, Toggle } from '../kit';

const BUDDY_SIZES: readonly BuddySizeId[] = ['sm', 'md', 'lg'];

const THEMES: { value: ThemeMode; labelKey: string }[] = [
  { value: 'system', labelKey: 'settings.theme.system' },
  { value: 'light', labelKey: 'settings.theme.light' },
  { value: 'dark', labelKey: 'settings.theme.dark' },
];

function formatAssetBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatExtBadge(asset: WallpaperAsset): string {
  const dot = asset.filename.lastIndexOf('.');
  return dot >= 0 ? asset.filename.slice(dot + 1).toUpperCase() : asset.mediaKind.toUpperCase();
}

/** Miniature window used by the theme cards, matching the design's preview. */
export function ThemePreview({ mode }: { mode: ThemeMode }) {
  const pane = (dark: boolean) => (
    <div className={cn('flex flex-1', dark ? 'bg-[#2C2C2E]' : 'bg-white')}>
      <div
        className={cn(
          'w-[22%] border-r',
          dark ? 'border-[#3A3A3C] bg-[#1C1C1E]' : 'border-[#E5E5E7] bg-[#F2F2F3]',
        )}
      />
      <div className="flex-1 space-y-1 p-1.5">
        <div className={cn('h-1.5 w-3/4 rounded-full', dark ? 'bg-[#48484A]' : 'bg-[#E5E5EA]')} />
        <div className={cn('h-1.5 w-1/2 rounded-full', dark ? 'bg-[#3A3A3C]' : 'bg-[#EFEFF1]')} />
        <div className="ml-auto h-1.5 w-2/5 rounded-full bg-accent/70" />
      </div>
    </div>
  );

  return (
    <div className="flex h-[58px] overflow-hidden rounded-lg border border-black/[0.08]">
      {mode === 'system' ? (
        <>
          {pane(false)}
          {pane(true)}
        </>
      ) : (
        pane(mode === 'dark')
      )}
    </div>
  );
}

/** Settings → 通用 → 外观与语言 */
export function AppearancePage() {
  const { t } = useTranslation();
  const prefs = useUiPrefs();
  const [importing, setImporting] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const activeAsset = prefs.background.kind === 'custom' ? prefs.background.asset : null;

  const finalizeImport = async (imported: WallpaperAsset) => {
    const bridge = window.opc?.wallpaper;
    try {
      const meta = await extractWallpaperPosterAndMeta(imported);
      const updated = bridge
        ? await bridge.savePoster({
            filename: imported.filename,
            dataUrl: meta.dataUrl,
            ...(meta.width !== undefined ? { width: meta.width } : {}),
            ...(meta.height !== undefined ? { height: meta.height } : {}),
            ...(meta.durationSec !== undefined ? { durationSec: meta.durationSec } : {}),
          })
        : null;
      prefs.updateBackground({ kind: 'custom', asset: updated ?? imported });
      setImportError(null);
    } catch (error) {
      await bridge?.clear().catch(() => undefined);
      setImportError(
        error instanceof Error ? error.message : t('settings.backgroundImportFailed'),
      );
    }
  };

  const handleChoose = async () => {
    const bridge = window.opc?.wallpaper;
    if (!bridge || importing) return;
    setImporting(true);
    setImportError(null);
    try {
      const result = await bridge.choose();
      if (!result.ok) {
        if (!result.canceled) {
          setImportError(result.error ?? t('settings.backgroundImportFailed'));
        }
        return;
      }
      if (result.asset) await finalizeImport(result.asset);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : t('settings.backgroundImportFailed'));
    } finally {
      setImporting(false);
    }
  };

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    const bridge = window.opc?.wallpaper;
    const file = event.dataTransfer.files[0];
    if (!bridge || !file || importing) return;

    setImporting(true);
    setImportError(null);
    try {
      const result = await bridge.importDroppedFile(file);
      if (!result.ok) {
        setImportError(result.error ?? t('settings.backgroundImportFailed'));
        return;
      }
      if (result.asset) await finalizeImport(result.asset);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : t('settings.backgroundImportFailed'));
    } finally {
      setImporting(false);
    }
  };

  const handleClear = async () => {
    setImportError(null);
    await window.opc?.wallpaper.clear().catch(() => undefined);
    prefs.updateBackground({ kind: 'none', asset: null });
  };

  const handleReset = () => {
    setImportError(null);
    void window.opc?.wallpaper.clear().catch(() => undefined);
    prefs.resetAppearance();
  };

  const previewUrl = activeAsset
    ? wallpaperAssetUrl(activeAsset.posterFilename ?? activeAsset.filename)
    : '';

  return (
    <>
      <PageHeader
        crumbs={[t('settings.group.general'), t('settings.page.appearance')]}
        title={t('settings.page.appearance')}
        description={t('settings.subtitle')}
      />

      <div className="space-y-4">
        <Section title={t('settings.appearance')} description={t('settings.appearanceDesc')}>
          <div className="flex gap-3 px-4 py-4">
            {THEMES.map((theme) => {
              const active = prefs.themeMode === theme.value;
              return (
                <button
                  key={theme.value}
                  type="button"
                  onClick={() => prefs.setThemeMode(theme.value)}
                  aria-pressed={active}
                  className="group w-[8.25rem] cursor-pointer text-left"
                >
                  <div
                    className={cn(
                      'rounded-[10px] p-1 transition-shadow',
                      active
                        ? 'ring-2 ring-accent'
                        : 'ring-1 ring-transparent group-hover:ring-line-strong',
                    )}
                  >
                    <ThemePreview mode={theme.value} />
                  </div>
                  <div className="mt-1.5 flex items-center gap-1.5 text-sm">
                    <span
                      className={cn(
                        'flex size-3.5 items-center justify-center rounded-full',
                        active ? 'bg-accent text-white' : 'border border-line-strong',
                      )}
                    >
                      {active ? <Check className="size-2.5" strokeWidth={3} /> : null}
                    </span>
                    <span className={active ? 'font-medium text-ink' : 'text-ink-secondary'}>
                      {t(theme.labelKey)}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>

          <Row label={t('settings.fontSize')} hint={t('settings.fontSizeHint')}>
            <Segmented<FontScaleId>
              label={t('settings.fontSize')}
              value={prefs.fontScale}
              onChange={prefs.setFontScale}
              options={FONT_SCALES.map((scale) => ({
                value: scale.id,
                label: t(`settings.scale.${scale.id}`),
              }))}
            />
          </Row>

          <Row label={t('settings.font')} hint={t('settings.fontHint')}>
            <SelectField
              ariaLabel={t('settings.font')}
              value={prefs.fontFamilyId}
              onChange={(next) => prefs.setFontFamily(next as FontFamilyId)}
              className="w-[12.5rem]"
            >
              {FONT_FAMILIES.map((font) => (
                <option key={font.id} value={font.id}>
                  {t(font.labelKey)}
                </option>
              ))}
            </SelectField>
          </Row>
        </Section>

        <Section
          title={t('settings.background')}
          description={t('settings.backgroundHint', {
            imageMb: MAX_WALLPAPER_IMAGE_MB,
            videoMb: MAX_WALLPAPER_VIDEO_MB,
          })}
        >
          <div
            onDragOver={(event) => {
              event.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={(event) => void handleDrop(event)}
            className="px-4 py-3.5"
          >
            {activeAsset ? (
              <div
                className={cn(
                  'flex items-center gap-3.5 rounded-xl border p-2.5 transition-colors',
                  dragActive
                    ? 'border-accent bg-accent-soft/40'
                    : 'border-line bg-surface-muted/45',
                )}
              >
                <div className="relative h-20 w-36 shrink-0 overflow-hidden rounded-lg border border-line bg-surface-muted">
                  <img
                    src={previewUrl}
                    alt={activeAsset.originalName}
                    className="size-full object-cover"
                  />
                  <div
                    className="pointer-events-none absolute inset-0"
                    style={{
                      background: `rgb(0 0 0 / ${(prefs.background.scrimOpacity * 0.65).toFixed(2)})`,
                    }}
                  />
                  <span className="absolute bottom-1.5 left-1.5 inline-flex items-center gap-1 rounded bg-black/65 px-1.5 py-0.5 font-mono text-[10px] font-medium text-white backdrop-blur-xs">
                    {activeAsset.mediaKind === 'video' ? <Film className="size-2.5" /> : null}
                    {formatExtBadge(activeAsset)}
                  </span>
                </div>

                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-ink">
                    {activeAsset.originalName}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-2xs tabular-nums text-ink-tertiary">
                    <span>{t(`settings.backgroundKind.${activeAsset.mediaKind}`)}</span>
                    <span>·</span>
                    <span>{formatAssetBytes(activeAsset.bytes)}</span>
                    {activeAsset.width && activeAsset.height ? (
                      <>
                        <span>·</span>
                        <span>
                          {activeAsset.width}×{activeAsset.height}
                        </span>
                      </>
                    ) : null}
                    {activeAsset.durationSec ? (
                      <>
                        <span>·</span>
                        <span>{activeAsset.durationSec}s</span>
                      </>
                    ) : null}
                  </div>
                  <div className="mt-2.5 flex items-center gap-2">
                    <button
                      type="button"
                      disabled={importing}
                      onClick={() => void handleChoose()}
                      className={cn(buttonClass.secondary, 'inline-flex items-center gap-1.5')}
                    >
                      <RefreshCw className={cn('size-3.5', importing && 'animate-spin')} />
                      <span>
                        {importing ? t('settings.backgroundImporting') : t('settings.backgroundReplace')}
                      </span>
                    </button>
                    <button
                      type="button"
                      disabled={importing}
                      onClick={() => void handleClear()}
                      className="inline-flex h-[30px] items-center gap-1.5 rounded-lg border border-line px-2.5 text-sm text-ink-tertiary transition-colors hover:border-danger/50 hover:text-danger disabled:opacity-50"
                    >
                      <Trash2 className="size-3.5" />
                      <span>{t('settings.backgroundClear')}</span>
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div
                onClick={() => void handleChoose()}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    void handleChoose();
                  }
                }}
                className={cn(
                  'flex cursor-pointer items-center justify-between gap-4 rounded-xl border border-dashed px-4 py-3.5 transition-colors',
                  dragActive
                    ? 'border-accent bg-accent-soft/45'
                    : 'border-line-strong/80 bg-surface-muted/35 hover:border-accent/60 hover:bg-surface-muted/60',
                )}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-accent-ink">
                    <ImagePlus className="size-4.5" />
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-ink">
                      {importing ? t('settings.backgroundImporting') : t('settings.backgroundDropTitle')}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-ink-tertiary">
                      {t('settings.backgroundFormats', {
                        imageMb: MAX_WALLPAPER_IMAGE_MB,
                        videoMb: MAX_WALLPAPER_VIDEO_MB,
                      })}
                    </div>
                  </div>
                </div>
                <span className={cn(buttonClass.secondary, 'shrink-0')}>
                  {t('settings.backgroundChoose')}
                </span>
              </div>
            )}

            {importError ? (
              <div className="mt-2 rounded-lg border border-danger/30 bg-danger/8 px-3 py-1.5 text-xs text-danger">
                {importError}
              </div>
            ) : null}
          </div>

          {activeAsset ? (
            <>
              <Row label={t('settings.backgroundScrim')} hint={t('settings.backgroundScrimHint')}>
                <div className="flex items-center gap-2.5">
                  <input
                    type="range"
                    min={0}
                    max={70}
                    step={2}
                    aria-label={t('settings.backgroundScrim')}
                    value={Math.round(prefs.background.scrimOpacity * 100)}
                    onChange={(event) =>
                      prefs.updateBackground({ scrimOpacity: Number(event.target.value) / 100 })
                    }
                    className="h-1.5 w-28 accent-[var(--accent)]"
                  />
                  <span className="w-9 text-right font-mono text-xs tabular-nums text-ink-secondary">
                    {Math.round(prefs.background.scrimOpacity * 100)}%
                  </span>
                </div>
              </Row>

              <Row label={t('settings.backgroundBlur')} hint={t('settings.backgroundBlurHint')}>
                <div className="flex items-center gap-2.5">
                  <input
                    type="range"
                    min={0}
                    max={12}
                    step={1}
                    aria-label={t('settings.backgroundBlur')}
                    value={prefs.background.blurPx}
                    onChange={(event) =>
                      prefs.updateBackground({ blurPx: Number(event.target.value) })
                    }
                    className="h-1.5 w-28 accent-[var(--accent)]"
                  />
                  <span className="w-9 text-right font-mono text-xs tabular-nums text-ink-secondary">
                    {prefs.background.blurPx === 0
                      ? t('settings.backgroundBlurNative')
                      : `${prefs.background.blurPx}px`}
                  </span>
                </div>
              </Row>

              <Row
                label={t('settings.backgroundCardOpacity')}
                hint={t('settings.backgroundCardOpacityHint')}
              >
                <div className="flex items-center gap-2.5">
                  <input
                    type="range"
                    min={0}
                    max={95}
                    step={5}
                    aria-label={t('settings.backgroundCardOpacity')}
                    value={Math.round(prefs.background.cardOpacity * 100)}
                    onChange={(event) =>
                      prefs.updateBackground({ cardOpacity: Number(event.target.value) / 100 })
                    }
                    className="h-1.5 w-28 accent-[var(--accent)]"
                  />
                  <span className="w-11 text-right font-mono text-xs tabular-nums text-ink-secondary">
                    {Math.round(prefs.background.cardOpacity * 100) === 0
                      ? t('settings.backgroundCardTransparent')
                      : `${Math.round(prefs.background.cardOpacity * 100)}%`}
                  </span>
                </div>
              </Row>

              {activeAsset.mediaKind !== 'image' ? (
                <Row
                  label={t('settings.backgroundPauseOnBlur')}
                  hint={t('settings.backgroundPauseOnBlurHint')}
                >
                  <Toggle
                    checked={prefs.background.pauseOnBlur}
                    onChange={(pauseOnBlur) => prefs.updateBackground({ pauseOnBlur })}
                    label={t('settings.backgroundPauseOnBlur')}
                  />
                </Row>
              ) : null}
            </>
          ) : null}
        </Section>

        <Section title={t('settings.buddy')} description={t('settings.buddyDesc')}>
          <Row label={t('settings.buddyEnabled')} hint={t('settings.buddyEnabledHint')}>
            <Toggle
              checked={prefs.buddyCompanion.enabled}
              onChange={(enabled) => prefs.updateBuddyCompanion({ enabled })}
              label={t('settings.buddyEnabled')}
            />
          </Row>

          <Row
            label={t('settings.buddyDesktopFloat')}
            hint={t('settings.buddyDesktopFloatHint')}
            disabled={!prefs.buddyCompanion.enabled}
          >
            <Toggle
              checked={prefs.buddyCompanion.desktopFloat}
              onChange={(desktopFloat) => prefs.updateBuddyCompanion({ desktopFloat })}
              label={t('settings.buddyDesktopFloat')}
            />
          </Row>

          <Row
            label={t('settings.buddyAlwaysOnTop')}
            hint={t('settings.buddyAlwaysOnTopHint')}
            disabled={!prefs.buddyCompanion.enabled || !prefs.buddyCompanion.desktopFloat}
          >
            <Toggle
              checked={prefs.buddyCompanion.alwaysOnTop}
              onChange={(alwaysOnTop) => prefs.updateBuddyCompanion({ alwaysOnTop })}
              label={t('settings.buddyAlwaysOnTop')}
            />
          </Row>

          <Row
            label={t('settings.buddySize')}
            hint={t('settings.buddySizeHint')}
            disabled={!prefs.buddyCompanion.enabled}
          >
            <Segmented<BuddySizeId>
              label={t('settings.buddySize')}
              value={prefs.buddyCompanion.size}
              onChange={(size) => prefs.updateBuddyCompanion({ size })}
              options={BUDDY_SIZES.map((id) => ({
                value: id,
                label: t(`settings.buddySize.${id}`),
              }))}
            />
          </Row>

          <Row
            label={t('settings.buddyBubbles')}
            hint={t('settings.buddyBubblesHint')}
            disabled={!prefs.buddyCompanion.enabled}
          >
            <Toggle
              checked={prefs.buddyCompanion.bubbles}
              onChange={(bubbles) => prefs.updateBuddyCompanion({ bubbles })}
              label={t('settings.buddyBubbles')}
            />
          </Row>

          <Row
            label={t('settings.buddyResetPos')}
            hint={t('settings.buddyResetPosHint')}
            disabled={!prefs.buddyCompanion.enabled}
          >
            <button
              type="button"
              onClick={() => {
                prefs.resetBuddyPosition();
                void window.opc?.buddy?.resetPosition();
              }}
              className={buttonClass.secondary}
            >
              {t('settings.buddyResetPosAction')}
            </button>
          </Row>
        </Section>

        <Section title={t('settings.language')}>
          <Row label={t('settings.language')}>
            <SelectField
              ariaLabel={t('settings.language')}
              value={prefs.locale}
              onChange={(next) => prefs.setLocale(next as Locale)}
              className="w-[11rem]"
            >
              {LOCALES.map((locale) => (
                <option key={locale} value={locale}>
                  {t(`settings.language.${locale}`)}
                </option>
              ))}
            </SelectField>
          </Row>
        </Section>

        <div className="flex items-center justify-between border-t border-line pt-4">
          <button
            type="button"
            onClick={handleReset}
            className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-secondary transition-colors hover:border-accent hover:text-accent"
          >
            {t('settings.reset')}
          </button>
          <span className="text-2xs text-ink-quaternary">{t('settings.autoSave')}</span>
        </div>
      </div>
    </>
  );
}
