import { describe, expect, it } from 'vitest';
import { PROVIDER_VISUALS, providerIconUrl, providerVisual } from './visuals';

/**
 * Icons are referenced by file name, so a wrong name degrades to tinted initials
 * with no error — it just looks like "the icon I added never showed up". This
 * test compares the mapping against the files that actually ship.
 *
 * `import.meta.glob` is used instead of `node:fs`: the renderer may not import
 * Node modules (it talks to the main process through `window.opc`), and glob is
 * resolved at build time, so the file list here is the one the app bundles.
 */
const iconFiles = new Set(
  Object.keys(import.meta.glob('../../../public/provider-icons/*')).map(
    (key) => key.split('/').pop() ?? '',
  ),
);

describe('provider icons on disk', () => {
  it('finds the icon directory', () => {
    expect(iconFiles.size).toBeGreaterThan(20);
  });

  it('resolves every mapped icon to an existing file', () => {
    const missing = Object.entries(PROVIDER_VISUALS)
      .filter(([, visual]) => visual.icon && !iconFiles.has(visual.icon))
      .map(([id, visual]) => `${id} → ${visual.icon}`);

    expect(missing).toEqual([]);
  });

  it('ships the TypeSafe, Meta and Baseten marks', () => {
    expect(iconFiles.has('typesafeai.svg')).toBe(true);
    expect(iconFiles.has('meta-color.svg')).toBe(true);
    expect(iconFiles.has('baseten.svg')).toBe(true);
  });
});

describe('providerVisual', () => {
  it('maps the classifier and inference providers added later', () => {
    expect(providerIconUrl('typesafe')).toBe('./provider-icons/typesafeai.svg');
    expect(providerIconUrl('meta')).toBe('./provider-icons/meta-color.svg');
    expect(providerIconUrl('baseten')).toBe('./provider-icons/baseten.svg');
  });

  it('carries a brand colour and initials for the fallback', () => {
    expect(providerVisual('meta')).toMatchObject({ color: '#0082FB', initials: 'ME' });
    expect(providerVisual('baseten').initials).toBe('BT');
    expect(providerVisual('typesafe').initials).toBe('TS');
  });

  it('accepts the spellings a provider row may use', () => {
    for (const id of ['typesafe-ai', 'typesafeai', 'TypeSafe']) {
      expect(providerIconUrl(id)).toBe('./provider-icons/typesafeai.svg');
    }
    expect(providerIconUrl('baseten-ai')).toBe('./provider-icons/baseten.svg');
    expect(providerIconUrl('meta-llama')).toBe('./provider-icons/meta-color.svg');
  });

  it('falls back to initials when nothing matches', () => {
    const visual = providerVisual('acme-inference');
    expect(visual.icon).toBeUndefined();
    expect(visual.initials).toBe('AC');
    expect(providerIconUrl('acme-inference')).toBeUndefined();
  });

  it('prefers the longest matching prefix', () => {
    // `typesafe` is a key; a more specific id must resolve through the alias, not
    // through whichever prefix happened to be declared first.
    expect(providerVisual('typesafe-ai')).toEqual(providerVisual('typesafe'));
  });
});
