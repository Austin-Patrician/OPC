export interface CatalogPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiers?: {
    inputTokensAbove: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  }[];
}

export interface CatalogModel {
  id: string;
  name: string;
  type: 'chat' | 'image' | 'classifier' | 'asr' | 'tts';
  api: string;
  contextWindow?: number;
  reasoning?: boolean;
  vision?: boolean;
  price?: CatalogPrice;
}

export interface CatalogProvider {
  id: string;
  baseUrl: string;
  /** Every API kind this provider's models use. */
  apis: string[];
  counts: { chat: number; image: number; classifier: number; asr: number; tts: number };
  models: CatalogModel[];
}

interface BuiltinModelLike {
  id: string;
  name?: string;
  api: string;
  baseUrl?: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: string[];
  cost?: CatalogPrice;
}

let cache: CatalogProvider[] | null = null;

/**
 * Image models served by first-party APIs that pi does not ship in its image
 * registry (pi only registers `openrouter-images`).
 *
 * The ids mirror pi's own OpenRouter image catalog with the vendor prefix
 * stripped, so the direct endpoint and the relay agree on model names. `api`
 * selects the wire protocol in `imageGeneration.ts` (`openai-images` →
 * /images/generations, `google-images` → Gemini generateContent). The base URL
 * still lives on the provider row, so a relay or gateway can be substituted from
 * the UI without touching code.
 */
const DIRECT_IMAGE_MODELS: Record<string, CatalogModel[]> = {
  openai: [
    { id: 'gpt-5-image', name: 'GPT-5 Image', type: 'image', api: 'openai-images' },
    { id: 'gpt-5-image-mini', name: 'GPT-5 Image Mini', type: 'image', api: 'openai-images' },
    { id: 'gpt-5.4-image-2', name: 'GPT-5.4 Image 2', type: 'image', api: 'openai-images' },
    { id: 'gpt-image-1', name: 'GPT Image 1', type: 'image', api: 'openai-images' },
    { id: 'gpt-image-1-mini', name: 'GPT Image 1 Mini', type: 'image', api: 'openai-images' },
    { id: 'gpt-image-2', name: 'GPT Image 2', type: 'image', api: 'openai-images' },
    { id: 'gpt-image-2.5-flare', name: 'GPT Image 2.5 Flare', type: 'image', api: 'openai-images' },
    { id: 'gpt-image-2.5-sunburst', name: 'GPT Image 2.5 Sunburst', type: 'image', api: 'openai-images' },
  ],
  google: [
    {
      id: 'gemini-2.5-flash-image',
      name: 'Nano Banana (Gemini 2.5 Flash Image)',
      type: 'image',
      api: 'google-images',
    },
    {
      id: 'gemini-3-pro-image',
      name: 'Nano Banana Pro (Gemini 3 Pro Image)',
      type: 'image',
      api: 'google-images',
    },
    {
      id: 'gemini-3-pro-image-preview',
      name: 'Nano Banana Pro (Preview)',
      type: 'image',
      api: 'google-images',
    },
    {
      id: 'gemini-3.1-flash-image',
      name: 'Nano Banana 2 (Gemini 3.1 Flash Image)',
      type: 'image',
      api: 'google-images',
    },
    {
      id: 'gemini-3.1-flash-image-preview',
      name: 'Nano Banana 2 (Preview)',
      type: 'image',
      api: 'google-images',
    },
    {
      id: 'gemini-3.1-flash-lite-image',
      name: 'Nano Banana 2 Lite',
      type: 'image',
      api: 'google-images',
    },
    {
      id: 'gemini-nano-banana-2.1',
      name: 'Nano Banana 2.1',
      type: 'image',
      api: 'google-images',
    },
  ],
};

/** Fallback when a direct-image provider is missing from pi's provider list. */
const DIRECT_IMAGE_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
};

/**
 * Speech models pi does not ship in its registry.
 *
 * Xiaomi serves ASR and TTS over the same [OI]-compatible
 * `/v1/chat/completions` endpoint as its chat models, so the existing provider
 * row (base URL + key) is reused. `api: 'xiaomi-audio'` selects that wire
 * protocol in `speech.ts`; a relay can still override the base URL from the UI.
 */
const DIRECT_VOICE_MODELS: Record<string, CatalogModel[]> = {
  xiaomi: [
    {
      id: 'mimo-v2.5-asr',
      name: 'MiMo-V2.5-ASR',
      type: 'asr',
      api: 'xiaomi-audio',
    },
    {
      id: 'mimo-v2.5-tts',
      name: 'MiMo-V2.5-TTS',
      type: 'tts',
      api: 'xiaomi-audio',
    },
    {
      id: 'mimo-v2.5-tts-voiceclone',
      name: 'MiMo-V2.5-TTS Voice Clone',
      type: 'tts',
      api: 'xiaomi-audio',
    },
    {
      id: 'mimo-v2.5-tts-voicedesign',
      name: 'MiMo-V2.5-TTS Voice Design',
      type: 'tts',
      api: 'xiaomi-audio',
    },
  ],
};

/** Fallback when a voice-only provider is missing from pi's provider list. */
const DIRECT_VOICE_BASE_URLS: Record<string, string> = {
  xiaomi: 'https://api.xiaomimimo.com/v1',
};

/**
 * pi's entire built-in catalog, flattened for the settings UI.
 *
 * 42 providers, ~1600 chat models, 63 pi image models + 15 first-party image
 * models (OpenAI / Gemini), 51 classifiers, 4 Xiaomi speech models, 14 API kinds. Everything the UI
 * shows (names, context windows, prices incl. tiers) comes from here, so
 * "pi 内置的 provider" are all reachable instead of a curated subset.
 */
export async function getCatalog(): Promise<CatalogProvider[]> {
  if (cache) return cache;

  const { getBuiltinProviders, getBuiltinModels, getBuiltinImageModels, getBuiltinClassifierModels } =
    await import('@earendil-works/pi-ai/providers/all');

  const providers: CatalogProvider[] = [];

  for (const providerId of getBuiltinProviders()) {
    const safe = <T>(load: () => readonly T[]): readonly T[] => {
      try {
        return load();
      } catch {
        return [];
      }
    };

    const toModel = (model: BuiltinModelLike, type: CatalogModel['type']): CatalogModel => ({
      id: model.id,
      name: model.name ?? model.id,
      type,
      api: model.api,
      contextWindow: model.contextWindow,
      reasoning: model.reasoning,
      vision: model.input?.includes('image') ?? false,
      price: model.cost,
    });

    const chat = safe(() => getBuiltinModels(providerId)) as unknown as BuiltinModelLike[];
    const builtinImage = safe(() => getBuiltinImageModels(providerId)) as unknown as BuiltinModelLike[];
    const classifier = safe(() => getBuiltinClassifierModels(providerId)) as unknown as BuiltinModelLike[];

    const image = builtinImage.map((model) => toModel(model, 'image'));
    const known = new Set(image.map((model) => model.id));
    for (const model of DIRECT_IMAGE_MODELS[providerId] ?? []) {
      if (!known.has(model.id)) image.push(model);
    }

    const voice = (DIRECT_VOICE_MODELS[providerId] ?? []).map((model) => ({ ...model }));

    if (chat.length === 0 && image.length === 0 && classifier.length === 0 && voice.length === 0) continue;

    const models = [
      ...chat.map((model) => toModel(model, 'chat')),
      ...image,
      ...classifier.map((model) => toModel(model, 'classifier')),
      ...voice,
    ];

    providers.push({
      id: providerId,
      baseUrl:
        chat[0]?.baseUrl ??
        builtinImage[0]?.baseUrl ??
        DIRECT_IMAGE_BASE_URLS[providerId] ??
        DIRECT_VOICE_BASE_URLS[providerId] ??
        '',
      apis: Array.from(new Set(models.map((model) => model.api))).sort(),
      counts: {
        chat: chat.length,
        image: image.length,
        classifier: classifier.length,
        asr: voice.filter((model) => model.type === 'asr').length,
        tts: voice.filter((model) => model.type === 'tts').length,
      },
      models,
    });
  }

  // Defensive: keep first-party image providers reachable even if pi renames or
  // drops their provider entry.
  const covered = new Set(providers.map((provider) => provider.id));
  for (const [providerId, imageModels] of Object.entries(DIRECT_IMAGE_MODELS)) {
    if (covered.has(providerId)) continue;
    providers.push({
      id: providerId,
      baseUrl: DIRECT_IMAGE_BASE_URLS[providerId] ?? '',
      apis: Array.from(new Set(imageModels.map((model) => model.api))).sort(),
      counts: { chat: 0, image: imageModels.length, classifier: 0, asr: 0, tts: 0 },
      models: imageModels.map((model) => ({ ...model })),
    });
    covered.add(providerId);
  }

  // Same guard for speech: a voice-only provider must stay configurable even if
  // pi's provider list changes.
  for (const [providerId, voiceModels] of Object.entries(DIRECT_VOICE_MODELS)) {
    if (covered.has(providerId)) continue;
    providers.push({
      id: providerId,
      baseUrl: DIRECT_VOICE_BASE_URLS[providerId] ?? '',
      apis: Array.from(new Set(voiceModels.map((model) => model.api))).sort(),
      counts: {
        chat: 0,
        image: 0,
        classifier: 0,
        asr: voiceModels.filter((model) => model.type === 'asr').length,
        tts: voiceModels.filter((model) => model.type === 'tts').length,
      },
      models: voiceModels.map((model) => ({ ...model })),
    });
  }

  cache = providers.sort((a, b) => a.id.localeCompare(b.id));
  return cache;
}
