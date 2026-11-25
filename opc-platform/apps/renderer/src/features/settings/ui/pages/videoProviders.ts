import type { CatalogModel, CatalogProvider, ModelOption, ProviderConfig } from '@opc/shared/domain';

/** Wire protocols a video model can speak. Mirrors `ModelOption.api`. */
export const VIDEO_PROTOCOLS = [
  'fal-queue',
  'volcengine-ark-video',
  'kling-video',
  'minimax-video',
  'google-veo',
  'openai-videos',
] as const;

export type VideoProtocol = (typeof VIDEO_PROTOCOLS)[number];

export interface VideoProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  api: VideoProtocol;
  models: CatalogModel[];
}

/**
 * Fallback & display-name presets for the 6 built-in video providers, pre-filled
 * with verified 2026 per-second USD reference pricing.
 */
export const VIDEO_PROVIDER_PRESETS: readonly VideoProviderPreset[] = [
  {
    id: 'fal',
    name: 'fal.ai',
    baseUrl: 'https://queue.fal.run',
    api: 'fal-queue',
    models: [
      { id: 'kling/v4/text-to-video', name: 'Kling 4.0 (文生视频)', type: 'video', api: 'fal-queue', usdPerSecond: 0.157 },
      { id: 'kling/v4/image-to-video', name: 'Kling 4.0 (图生视频)', type: 'video', api: 'fal-queue', usdPerSecond: 0.157 },
      { id: 'bytedance/seedance-2.5/text-to-video', name: 'Seedance 2.5 (文生视频)', type: 'video', api: 'fal-queue', usdPerSecond: 0.216 },
      { id: 'bytedance/seedance-2.5/image-to-video', name: 'Seedance 2.5 (图生视频)', type: 'video', api: 'fal-queue', usdPerSecond: 0.216 },
      { id: 'fal-ai/veo3.1', name: 'Google Veo 3.1', type: 'video', api: 'fal-queue', usdPerSecond: 0.4 },
      { id: 'fal-ai/veo3.1/fast', name: 'Google Veo 3.1 Fast', type: 'video', api: 'fal-queue', usdPerSecond: 0.15 },
      { id: 'fal-ai/veo3.1/fast/first-last-frame-to-video', name: 'Google Veo 3.1 Fast (首尾帧)', type: 'video', api: 'fal-queue', usdPerSecond: 0.15 },
      { id: 'fal-ai/kling-video/v3/pro/text-to-video', name: 'Kling 3.0 Pro (文生视频)', type: 'video', api: 'fal-queue', usdPerSecond: 0.112 },
      { id: 'fal-ai/kling-video/v3/pro/image-to-video', name: 'Kling 3.0 Pro (图生视频)', type: 'video', api: 'fal-queue', usdPerSecond: 0.112 },
      { id: 'bytedance/seedance-2.0/fast/text-to-video', name: 'Seedance 2.0 Fast (文生视频)', type: 'video', api: 'fal-queue', usdPerSecond: 0.114 },
      { id: 'bytedance/seedance-2.0/fast/image-to-video', name: 'Seedance 2.0 Fast (图生视频)', type: 'video', api: 'fal-queue', usdPerSecond: 0.114 },
      { id: 'minimax/h3-max/text-to-video', name: 'MiniMax H3 Max', type: 'video', api: 'fal-queue', usdPerSecond: 0.06 },
      { id: 'minimax/h3-max-turbo/text-to-video', name: 'MiniMax H3 Max Turbo', type: 'video', api: 'fal-queue', usdPerSecond: 0.04 },
    ],
  },
  {
    id: 'volcengine-ark',
    name: '火山引擎方舟（Seedance）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    api: 'volcengine-ark-video',
    models: [
      { id: 'doubao-seedance-2-5-260628', name: '豆包 Seedance 2.5', type: 'video', api: 'volcengine-ark-video', usdPerSecond: 0.216 },
      { id: 'doubao-seedance-2-5-flash-261115', name: '豆包 Seedance 2.5 Flash', type: 'video', api: 'volcengine-ark-video', usdPerSecond: 0.152 },
      { id: 'doubao-seedance-2-0-260128', name: '豆包 Seedance 2.0', type: 'video', api: 'volcengine-ark-video', usdPerSecond: 0.142 },
      { id: 'doubao-seedance-2-0-fast-260128', name: '豆包 Seedance 2.0 Fast', type: 'video', api: 'volcengine-ark-video', usdPerSecond: 0.114 },
      { id: 'doubao-seedance-2-0-mini-260615', name: '豆包 Seedance 2.0 Mini', type: 'video', api: 'volcengine-ark-video', usdPerSecond: 0.071 },
    ],
  },
  {
    id: 'kling',
    name: '可灵 Kling',
    baseUrl: 'https://api.klingai.com',
    api: 'kling-video',
    models: [
      { id: 'kling-v4-0', name: '可灵 Kling 4.0', type: 'video', api: 'kling-video', usdPerSecond: 0.157 },
      { id: 'kling-v4-0-flash', name: '可灵 Kling 4.0 Flash', type: 'video', api: 'kling-video', usdPerSecond: 0.094 },
      { id: 'kling-3.0', name: '可灵 Kling 3.0', type: 'video', api: 'kling-video', usdPerSecond: 0.112 },
      { id: 'kling-3.0-omni', name: '可灵 Kling 3.0 Omni', type: 'video', api: 'kling-video', usdPerSecond: 0.112 },
      { id: 'kling-v2-6', name: '可灵 Kling 2.6', type: 'video', api: 'kling-video', usdPerSecond: 0.07 },
    ],
  },
  {
    id: 'minimax',
    name: 'MiniMax（H3 / 海螺）',
    baseUrl: 'https://api.minimaxi.com/v1',
    api: 'minimax-video',
    models: [
      { id: 'MiniMax-H3', name: 'MiniMax H3', type: 'video', api: 'minimax-video', usdPerSecond: 0.08 },
      { id: 'MiniMax-H3-Max', name: 'MiniMax H3 Max', type: 'video', api: 'minimax-video', usdPerSecond: 0.08 },
      { id: 'MiniMax-H3-Highspeed', name: 'MiniMax H3 Highspeed', type: 'video', api: 'minimax-video', usdPerSecond: 0.05 },
      { id: 'MiniMax-Hailuo-2.3', name: '海螺 Hailuo 2.3', type: 'video', api: 'minimax-video', usdPerSecond: 0.08 },
      { id: 'MiniMax-Hailuo-2.3-Fast', name: '海螺 Hailuo 2.3 Fast', type: 'video', api: 'minimax-video', usdPerSecond: 0.04 },
    ],
  },
  {
    id: 'google',
    name: 'Google Veo',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    api: 'google-veo',
    models: [
      { id: 'veo-3.1-generate-001', name: 'Google Veo 3.1', type: 'video', api: 'google-veo', usdPerSecond: 0.4 },
      { id: 'veo-3.1-fast-generate-001', name: 'Google Veo 3.1 Fast', type: 'video', api: 'google-veo', usdPerSecond: 0.15 },
      { id: 'veo-3.1-lite-generate-001', name: 'Google Veo 3.1 Lite', type: 'video', api: 'google-veo', usdPerSecond: 0.05 },
    ],
  },
  {
    id: 'openai-video',
    name: '通用视频网关（OpenAI-Compatible）',
    baseUrl: 'https://api.openai.com/v1',
    api: 'openai-videos',
    models: [
      { id: 'sora-2', name: 'Sora 2', type: 'video', api: 'openai-videos', usdPerSecond: 0.1 },
      { id: 'sora-2-pro', name: 'Sora 2 Pro', type: 'video', api: 'openai-videos', usdPerSecond: 0.3 },
    ],
  },
];

const PRESET_BY_ID = new Map(VIDEO_PROVIDER_PRESETS.map((preset) => [preset.id, preset]));
const PRESET_ORDER = new Map(VIDEO_PROVIDER_PRESETS.map((preset, index) => [preset.id, index]));

/** One row in the video-model table: built-in, stored, or both. */
export interface VideoModelView {
  id: string;
  name: string;
  api?: string;
  usdPerSecond?: number;
  stored: boolean;
  enabled: boolean;
  catalog?: CatalogModel;
}

/** A provider that can serve video generation models, configured or catalog-only. */
export interface VideoProviderView {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  config?: ProviderConfig;
  hasKey: boolean;
  catalogVideos: CatalogModel[];
  videos: VideoModelView[];
}

export const EMPTY_VIDEO_MODEL_DRAFT = {
  id: '',
  name: '',
  api: VIDEO_PROTOCOLS[0] as string,
  usdPerSecond: '',
};

/**
 * Merges the catalog video providers & presets with configured SQLite provider rows.
 */
export function buildVideoProviders(
  catalog: readonly CatalogProvider[],
  providers: readonly ProviderConfig[],
  displayName: (providerId: string) => string | undefined,
  options: { includeProviderId?: string } = {},
): VideoProviderView[] {
  const configured = new Map(providers.map((provider) => [provider.id, provider]));
  const catalogById = new Map(catalog.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  const entries: VideoProviderView[] = [];

  const pushEntry = (
    id: string,
    defaultName: string,
    defaultBaseUrl: string,
    defaultApi: string,
    catalogVideos: CatalogModel[],
  ) => {
    const config = configured.get(id);
    const storedVideos = (config?.models ?? []).filter((model) => model.capability === 'video');
    const storedById = new Map(storedVideos.map((model) => [model.id, model]));
    const catalogIds = new Set(catalogVideos.map((model) => model.id));

    entries.push({
      id,
      name: config?.name ?? PRESET_BY_ID.get(id)?.name ?? displayName(id) ?? defaultName,
      baseUrl: config?.baseUrl || defaultBaseUrl,
      api: config?.api || defaultApi,
      config,
      hasKey: config?.hasKey ?? false,
      catalogVideos,
      videos: [
        ...catalogVideos.map((model) => {
          const stored = storedById.get(model.id);
          return {
            id: model.id,
            name: model.name,
            api: model.api,
            usdPerSecond:
              stored?.usdPerSecond !== undefined && stored.usdPerSecond > 0
                ? stored.usdPerSecond
                : model.usdPerSecond,
            stored: Boolean(stored),
            enabled: stored?.videoEnabled === true,
            catalog: model,
          };
        }),
        ...storedVideos
          .filter((model) => !catalogIds.has(model.id))
          .map((model) => ({
            id: model.id,
            name: model.name,
            api: model.api,
            usdPerSecond: model.usdPerSecond,
            stored: true,
            enabled: model.videoEnabled === true,
          })),
      ],
    });
    seen.add(id);
  };

  for (const preset of VIDEO_PROVIDER_PRESETS) {
    const cat = catalogById.get(preset.id);
    const catModels = cat?.models.filter((model) => model.type === 'video') ?? [];
    pushEntry(
      preset.id,
      preset.name,
      cat?.baseUrl || preset.baseUrl,
      preset.api,
      catModels.length > 0 ? catModels : preset.models,
    );
  }

  for (const entry of catalog) {
    if (seen.has(entry.id)) continue;
    const catModels = entry.models.filter((model) => model.type === 'video');
    const config = configured.get(entry.id);
    const storedVideos = (config?.models ?? []).filter((model) => model.capability === 'video');
    if (catModels.length === 0 && storedVideos.length === 0) continue;
    pushEntry(entry.id, entry.id, entry.baseUrl, entry.apis[0] ?? 'openai-videos', catModels);
  }

  for (const config of providers) {
    if (seen.has(config.id)) continue;
    const storedVideos = config.models.filter((model) => model.capability === 'video');
    const ownedByVideoPage = config.scope === 'video';
    if (!ownedByVideoPage && storedVideos.length === 0 && config.id !== options.includeProviderId) {
      continue;
    }
    pushEntry(config.id, config.name, config.baseUrl, config.api, []);
  }

  return entries.sort((a, b) => {
    const rankA = PRESET_ORDER.get(a.id);
    const rankB = PRESET_ORDER.get(b.id);
    if (rankA !== undefined && rankB !== undefined) return rankA - rankB;
    if (rankA !== undefined) return -1;
    if (rankB !== undefined) return 1;
    return a.name.localeCompare(b.name);
  });
}

/** Converts a catalog video model into the stored `ModelOption` shape. */
export function toVideoModelOption(model: CatalogModel, videoEnabled = false): ModelOption {
  return {
    id: model.id,
    name: model.name,
    capability: 'video',
    api: model.api,
    contextWindow: model.contextWindow,
    usdPerSecond: model.usdPerSecond,
    videoEnabled,
  };
}

/** Keeps stored rows/prices, upgrades known video models to `capability: 'video'`, and appends built-ins. */
export function mergeVideoModels(
  existing: readonly ModelOption[],
  catalogModels: readonly CatalogModel[],
): ModelOption[] {
  const builtins = new Map(catalogModels.map((model) => [model.id, model]));
  const merged = existing.map((model) => {
    const builtin = builtins.get(model.id);
    if (!builtin) return model;
    const converted = toVideoModelOption(builtin, model.videoEnabled === true);
    return {
      ...model,
      name: converted.name,
      capability: 'video' as const,
      api: converted.api,
      usdPerSecond:
        model.usdPerSecond !== undefined && model.usdPerSecond > 0
          ? model.usdPerSecond
          : converted.usdPerSecond,
    };
  });

  const present = new Set(existing.map((model) => model.id));
  for (const model of catalogModels) {
    if (!present.has(model.id)) merged.push(toVideoModelOption(model));
  }
  return merged;
}
