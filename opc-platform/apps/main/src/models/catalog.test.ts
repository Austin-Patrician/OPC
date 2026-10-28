import { describe, expect, it } from 'vitest';
import { getCatalog } from './catalog';

/**
 * pi only registers `openrouter-images`. The settings page still has to offer
 * OpenAI and Gemini out of the box, with a protocol the generator understands.
 */
describe('getCatalog image entries', () => {
  it('adds first-party OpenAI image models', async () => {
    const catalog = await getCatalog();
    const openai = catalog.find((provider) => provider.id === 'openai');
    const images = openai?.models.filter((model) => model.type === 'image') ?? [];

    expect(images.map((model) => model.id)).toEqual(
      expect.arrayContaining(['gpt-image-1', 'gpt-image-1-mini', 'gpt-image-2']),
    );
    expect(images.every((model) => model.api === 'openai-images')).toBe(true);
    expect(openai?.apis).toContain('openai-images');
    expect(openai?.counts.image).toBe(images.length);
  });

  it('adds Gemini image models on the Google provider', async () => {
    const catalog = await getCatalog();
    const google = catalog.find((provider) => provider.id === 'google');
    const images = google?.models.filter((model) => model.type === 'image') ?? [];

    expect(images.map((model) => model.id)).toEqual(
      expect.arrayContaining(['gemini-2.5-flash-image', 'gemini-3-pro-image']),
    );
    expect(images.every((model) => model.api === 'google-images')).toBe(true);
    expect(google?.apis).toContain('google-images');
    expect(google?.baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta');
  });

  it("keeps the direct ids in sync with pi's OpenRouter image catalog", async () => {
    const catalog = await getCatalog();
    const openrouter = catalog.find((provider) => provider.id === 'openrouter');
    const relayIds = openrouter?.models.filter((model) => model.type === 'image').map((model) => model.id) ?? [];

    // The direct catalog mirrors the relay, minus the `vendor/` prefix, so a
    // name that works through OpenRouter also works against the vendor API.
    for (const [providerId, api] of [
      ['openai', 'openai-images'],
      ['google', 'google-images'],
    ] as const) {
      const direct = (catalog.find((provider) => provider.id === providerId)?.models ?? [])
        .filter((model) => model.type === 'image')
        .map((model) => model.id)
        .sort();
      const fromRelay = relayIds
        .filter((id) => id.startsWith(`${providerId}/`))
        .map((id) => id.slice(providerId.length + 1))
        .sort();

      expect(direct).toEqual(fromRelay);
      expect(
        catalog
          .find((provider) => provider.id === providerId)
          ?.models.filter((model) => model.type === 'image')
          .every((model) => model.api === api),
      ).toBe(true);
    }
  });

  it("keeps pi's OpenRouter image catalog untouched", async () => {
    const catalog = await getCatalog();
    const openrouter = catalog.find((provider) => provider.id === 'openrouter');

    expect(openrouter?.counts.image).toBe(63);
    expect(openrouter?.apis).toContain('openrouter-images');
  });
});

describe('getCatalog speech entries', () => {
  it('adds Xiaomi ASR/TTS models to the existing xiaomi provider', async () => {
    const catalog = await getCatalog();
    const xiaomi = catalog.find((provider) => provider.id === 'xiaomi');
    const voice = xiaomi?.models.filter((model) => model.type === 'asr' || model.type === 'tts') ?? [];

    expect(voice.map((model) => model.id)).toEqual([
      'mimo-v2.5-asr',
      'mimo-v2.5-tts',
      'mimo-v2.5-tts-voiceclone',
      'mimo-v2.5-tts-voicedesign',
    ]);
    expect(voice.every((model) => model.api === 'xiaomi-audio')).toBe(true);
    expect(xiaomi?.counts.asr).toBe(1);
    expect(xiaomi?.counts.tts).toBe(3);
    expect(xiaomi?.apis).toContain('xiaomi-audio');
    // The chat provider row is reused, so the base URL must stay the MiMo API.
    expect(xiaomi?.baseUrl).toBe('https://api.xiaomimimo.com/v1');
  });
});
