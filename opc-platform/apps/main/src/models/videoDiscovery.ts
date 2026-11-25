import type { ProviderConfig } from '@opc/shared/domain';
import { defaultNetworkClient, type NetworkClient } from '../network/networkClient';
import { DIRECT_VIDEO_MODELS, type VideoProtocol } from './videoCatalog';
import { buildKlingAuthHeader, inferVideoProtocol } from './videoGeneration';

export interface DiscoveredVideoModel {
  id: string;
  name: string;
  api: VideoProtocol;
  usdPerSecond?: number;
}

export interface VideoDiscoveryResult {
  ok: boolean;
  message: string;
  models: DiscoveredVideoModel[];
}

const VIDEO_ID_PATTERNS = [
  /seedance/i,
  /kling/i,
  /\bveo[-_]/i,
  /^veo/i,
  /hailuo/i,
  /minimax[-_/]h3/i,
  /\bsora[-_0-9]?/i,
  /runway|gen[-_]?[34]/i,
  /luma|ray[-_]?2/i,
  /\bwan[-_.]?\d/i,
  /cogvideo/i,
  /hunyuan[-_]?video/i,
  /pixverse/i,
  /\bvidu\b/i,
  /\bpika\b/i,
  /text[-_]?to[-_]?video|image[-_]?to[-_]?video|t2v|i2v|video[-_]gen/i,
];

const OFFICIAL_NO_LISTING_HOSTS = ['api.klingai.com', 'api.minimaxi.com', 'api.minimax.io'];

/**
 * Queries a provider's live model catalog endpoint (`api.fal.ai/v1/models`, Volcengine Ark `/models`,
 * Google Gemini `/models`, or OpenAI-compatible gateways `/models`) and extracts video generation models.
 */
export async function discoverVideoModels(
  config: ProviderConfig,
  apiKey: string | undefined,
  network: NetworkClient = defaultNetworkClient,
): Promise<VideoDiscoveryResult> {
  const protocol = inferVideoProtocol(config.id, undefined, config.api);
  const baseUrl = (config.baseUrl ?? '').trim().replace(/\/+$/, '');

  if (protocol === 'fal-queue' && (!baseUrl || /fal\.(run|ai)/i.test(baseUrl))) {
    return discoverFalVideoModels(apiKey, network);
  }

  if (!apiKey?.trim()) {
    return { ok: false, message: '未配置 API Key', models: [] };
  }
  if (!baseUrl) {
    return { ok: false, message: '未配置 Base URL，无法拉取模型列表', models: [] };
  }

  if (
    (protocol === 'kling-video' || protocol === 'minimax-video') &&
    OFFICIAL_NO_LISTING_HOSTS.some((host) => baseUrl.toLowerCase().includes(host))
  ) {
    return {
      ok: false,
      message: '该服务商官方接口暂未开放模型列表查询，已保留内置最新模型；若接入兼容网关可填写网关 Base URL 后重试。',
      models: [],
    };
  }

  if (protocol === 'google-veo') {
    return discoverGoogleVeoModels(baseUrl, apiKey, config.id, network);
  }

  const headers: Record<string, string> = {
    authorization:
      protocol === 'kling-video' ? buildKlingAuthHeader(apiKey) : `Bearer ${apiKey.trim()}`,
  };

  try {
    const response = await network.fetch(
      `${baseUrl}/models`,
      { method: 'GET', headers, signal: AbortSignal.timeout(15_000) },
      { purpose: 'video', providerId: config.id },
    );
    if (!response.ok) {
      return {
        ok: false,
        message: `HTTP ${response.status} ${response.statusText}`,
        models: [],
      };
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const rawItems = Array.isArray(payload.data)
      ? payload.data
      : Array.isArray(payload.models)
        ? payload.models
        : [];
    const matched = extractOpenAiStyleVideoModels(rawItems, config.id, protocol);

    if (matched.length === 0) {
      return {
        ok: false,
        message:
          rawItems.length > 0
            ? `接口返回了 ${rawItems.length} 个模型，但未识别到视频模型 ID（可使用「添加视频模型」手动填写）`
            : '该服务商没有返回可用模型列表',
        models: [],
      };
    }

    return {
      ok: true,
      message: `拉取到 ${matched.length} 个视频模型`,
      models: matched,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      models: [],
    };
  }
}

async function discoverFalVideoModels(
  apiKey: string | undefined,
  network: NetworkClient,
): Promise<VideoDiscoveryResult> {
  const categories = ['text-to-video', 'image-to-video'] as const;
  const seen = new Map<string, DiscoveredVideoModel>();
  const headers: Record<string, string> = apiKey?.trim()
    ? { authorization: `Key ${apiKey.trim()}` }
    : {};

  try {
    for (const category of categories) {
      const response = await network.fetch(
        `https://api.fal.ai/v1/models?category=${category}&limit=50`,
        { method: 'GET', headers, signal: AbortSignal.timeout(15_000) },
        { purpose: 'video', providerId: 'fal' },
      );
      if (!response.ok) {
        return {
          ok: false,
          message: `fal 模型目录查询失败：HTTP ${response.status}`,
          models: [],
        };
      }
      const payload = (await response.json()) as {
        models?: Array<{
          endpoint_id?: string;
          id?: string;
          name?: string;
          status?: string;
          metadata?: { display_name?: string; status?: string };
        }>;
      };
      for (const item of payload.models ?? []) {
        const id = (item.endpoint_id ?? item.id ?? '').trim();
        const status = (item.status ?? item.metadata?.status ?? 'active').toLowerCase();
        if (!id || status === 'deprecated') continue;
        if (seen.has(id)) continue;
        seen.set(id, {
          id,
          name: item.name?.trim() || item.metadata?.display_name?.trim() || id,
          api: 'fal-queue',
          usdPerSecond: matchKnownVideoPrice('fal', id),
        });
      }
    }

    const models = [...seen.values()];
    if (models.length === 0) {
      return { ok: false, message: 'fal 模型目录返回为空', models: [] };
    }
    return {
      ok: true,
      message: `拉取到 ${models.length} 个视频模型`,
      models,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      models: [],
    };
  }
}

async function discoverGoogleVeoModels(
  baseUrl: string,
  apiKey: string,
  providerId: string,
  network: NetworkClient,
): Promise<VideoDiscoveryResult> {
  try {
    const response = await network.fetch(
      `${baseUrl}/models?pageSize=200`,
      {
        method: 'GET',
        headers: { 'x-goog-api-key': apiKey.trim() },
        signal: AbortSignal.timeout(15_000),
      },
      { purpose: 'video', providerId },
    );
    if (!response.ok) {
      return {
        ok: false,
        message: `HTTP ${response.status} ${response.statusText}`,
        models: [],
      };
    }

    const payload = (await response.json()) as {
      models?: Array<{
        name?: string;
        displayName?: string;
        supportedGenerationMethods?: string[];
      }>;
      data?: unknown[];
    };

    if (!Array.isArray(payload.models) && Array.isArray(payload.data)) {
      const compat = extractOpenAiStyleVideoModels(payload.data, providerId, 'google-veo');
      return compat.length > 0
        ? { ok: true, message: `拉取到 ${compat.length} 个视频模型`, models: compat }
        : { ok: false, message: '未在该网关返回的列表中识别到 Veo / 视频模型', models: [] };
    }

    const models: DiscoveredVideoModel[] = [];
    for (const item of payload.models ?? []) {
      const rawName = item.name?.trim() ?? '';
      const id = rawName.replace(/^models\//, '');
      if (!id) continue;
      const methods = item.supportedGenerationMethods ?? [];
      const isVeo = /veo/i.test(id) || methods.includes('predictLongRunning');
      if (!isVeo) continue;
      models.push({
        id,
        name: item.displayName?.trim() || id,
        api: 'google-veo',
        usdPerSecond: matchKnownVideoPrice(providerId, id),
      });
    }

    if (models.length === 0) {
      return { ok: false, message: 'Google 模型列表未返回可用的 Veo 模型', models: [] };
    }
    return { ok: true, message: `拉取到 ${models.length} 个视频模型`, models };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      models: [],
    };
  }
}

function extractOpenAiStyleVideoModels(
  rawItems: readonly unknown[],
  providerId: string,
  protocol: VideoProtocol,
): DiscoveredVideoModel[] {
  const seen = new Map<string, DiscoveredVideoModel>();
  for (const raw of rawItems) {
    if (typeof raw !== 'object' || raw === null) continue;
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id) continue;

    const domain = typeof item.domain === 'string' ? item.domain.toLowerCase() : '';
    const modelType = typeof item.type === 'string' ? item.type.toLowerCase() : '';
    const taskTypes = Array.isArray(item.task_type)
      ? item.task_type.filter((v): v is string => typeof v === 'string').map((v) => v.toLowerCase())
      : [];
    const status = typeof item.status === 'string' ? item.status.toLowerCase() : '';
    if (status === 'deprecated' || status === 'offline') continue;

    const explicitlyVideo =
      domain.includes('videogeneration') ||
      modelType === 'video' ||
      taskTypes.some((t) => t.includes('video'));
    if (!explicitlyVideo && !isLikelyVideoModelId(id)) continue;

    if (!seen.has(id)) {
      const displayName =
        typeof item.name === 'string' && item.name.trim() ? item.name.trim() : id;
      seen.set(id, {
        id,
        name: displayName,
        api: protocol,
        usdPerSecond: matchKnownVideoPrice(providerId, id),
      });
    }
  }
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function isLikelyVideoModelId(id: string): boolean {
  return VIDEO_ID_PATTERNS.some((pattern) => pattern.test(id));
}

function matchKnownVideoPrice(providerId: string, modelId: string): number | undefined {
  const exact = DIRECT_VIDEO_MODELS[providerId]?.find((entry) => entry.id === modelId);
  if (exact?.usdPerSecond !== undefined) return exact.usdPerSecond;
  const normalized = modelId.toLowerCase();
  for (const list of Object.values(DIRECT_VIDEO_MODELS)) {
    for (const candidate of list) {
      if (candidate.id.toLowerCase() === normalized) return candidate.usdPerSecond;
      const base = candidate.id.replace(/-\d{6}$/, '').toLowerCase();
      if (normalized.startsWith(base)) return candidate.usdPerSecond;
    }
  }
  return undefined;
}
