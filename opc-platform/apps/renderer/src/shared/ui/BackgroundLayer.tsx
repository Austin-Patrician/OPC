import type { BackgroundKind } from '@/shared/theme/types';

/**
 * Fixed wallpaper plane. Rendered once by the shell, below every panel.
 * `custom` accepts remote URLs, `data:` URLs (uploads) and GIFs.
 */
export function BackgroundLayer({ kind, url }: { kind: BackgroundKind; url: string }) {
  if (kind === 'none') return null;

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      {kind === 'custom' && url ? (
        <div
          className="size-full bg-cover bg-center bg-no-repeat"
          style={{ backgroundImage: `url("${url.replaceAll('"', '%22')}")` }}
        />
      ) : (
        <div
          className={
            kind === 'mesh'
              ? 'wallpaper-mesh size-full'
              : kind === 'grid'
                ? 'wallpaper-grid size-full'
                : 'wallpaper-aurora size-full'
          }
        />
      )}

      {/* Keeps text contrast predictable regardless of the image brightness. */}
      <div className="wallpaper-scrim absolute inset-0" />
    </div>
  );
}
