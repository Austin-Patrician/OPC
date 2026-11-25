import crypto from 'node:crypto';
import type { ModelRef, PricingMode, ProviderConfig } from '@opc/shared/domain';
import type { UsageRepository } from '../data/usageRepository';
import { defaultNetworkClient, type NetworkClient } from '../network/networkClient';
import { resolveChargedCost } from '../work/usage';
import type { ModelConfigService } from './modelConfigService';
import { DIRECT_VIDEO_MODELS } from './videoCatalog';
import {
  defaultVideoBaseUrl,
  generateVideo,
  inferVideoProtocol,
  type VideoImageInput,
} from './videoGeneration';

interface ResolvedVideoTarget {
  providerId: string;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  protocol: string;
  usdPerSecond?: number;
}

export interface VideoGenerateBytesInput {
  prompt: string;
  providerId?: string;
  modelId?: string;
  startImage?: VideoImageInput;
  endImage?: VideoImageInput;
  duration?: number;
  aspectRatio?: string;
  resolution?: string;
  generateAudio?: boolean;
  negativePrompt?: string;
  signal?: AbortSignal;
}

export type VideoGenerateBytesResult =
  | {
      ok: true;
      bytes: Uint8Array;
      mimeType: string;
      providerId: string;
      model: string;
      durationSeconds?: number;
    }
  | { ok: false; error: string };

/**
 * Video generation for the agent tool (`generateBytes`); settings only
 * configures providers/models. The tool writes the returned MP4/WebM bytes into
 * the task workspace so artifacts and chat playback pick them up automatically.
 */
export class VideoService {
  constructor(
    private readonly models: ModelConfigService,
    private readonly network: NetworkClient = defaultNetworkClient,
    private readonly usage?: UsageRepository,
    private readonly pricingMode: () => PricingMode = () => 'provider_first',
  ) {}

  isAvailable = (): boolean => !('error' in this.resolveTarget());

  generateBytes = async (
    input: VideoGenerateBytesInput,
  ): Promise<VideoGenerateBytesResult> => {
    const override =
      input.providerId && input.modelId
        ? { providerId: input.providerId, modelId: input.modelId }
        : input.modelId
          ? { providerId: '', modelId: input.modelId }
          : undefined;
    const resolved = this.resolveTarget(override);
    if ('error' in resolved) {
      return { ok: false, error: resolved.error };
    }

    const startedAt = Date.now();
    try {
      const result = await generateVideo(
        {
          baseUrl: resolved.baseUrl,
          apiKey: resolved.apiKey,
          model: resolved.modelId,
          prompt: input.prompt,
          protocol: resolved.protocol,
          providerId: resolved.providerId,
          startImage: input.startImage,
          endImage: input.endImage,
          duration: input.duration,
          aspectRatio: input.aspectRatio,
          resolution: input.resolution,
          generateAudio: input.generateAudio,
          negativePrompt: input.negativePrompt,
          signal: input.signal,
        },
        this.network,
      );
      const billedSeconds = result.durationSeconds ?? input.duration ?? 5;
      const configuredCostUsd =
        resolved.usdPerSecond && resolved.usdPerSecond > 0
          ? Math.round(resolved.usdPerSecond * billedSeconds * 1_000_000) / 1_000_000
          : undefined;
      const charged = resolveChargedCost(this.pricingMode(), undefined, configuredCostUsd);

      this.usage?.recordSafely({
        idempotencyKey: `video:${crypto.randomUUID()}`,
        startedAt,
        finishedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        capability: 'video',
        operation: 'video.generate',
        origin: 'tool',
        providerId: resolved.providerId,
        modelId: resolved.modelId,
        status: 'ok',
        billingUnit: 'second',
        billedQuantity: billedSeconds,
        tokenSource: result.durationSeconds ? 'provider' : 'estimated',
        ...(configuredCostUsd !== undefined ? { configuredCostUsd } : {}),
        ...(charged.chargedCostUsd !== undefined ? { chargedCostUsd: charged.chargedCostUsd } : {}),
        costSource: charged.costSource,
      });
      return {
        ok: true,
        bytes: result.bytes,
        mimeType: result.mimeType,
        providerId: resolved.providerId,
        model: resolved.modelId,
        durationSeconds: result.durationSeconds ?? input.duration,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.usage?.recordSafely({
        idempotencyKey: `video:${crypto.randomUUID()}`,
        startedAt,
        finishedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        capability: 'video',
        operation: 'video.generate',
        origin: 'tool',
        providerId: resolved.providerId,
        modelId: resolved.modelId,
        status: 'error',
        billingUnit: 'second',
        billedQuantity: 0,
        tokenSource: 'missing',
        costSource: 'unpriced',
        error: message,
      });
      return { ok: false, error: message };
    }
  };

  resolveTarget(override?: Partial<ModelRef>): ResolvedVideoTarget | { error: string } {
    const providers = this.models.listProviders();
    const defaults = this.models.getDefaults();
    const isEnabledVideo = (provider: ProviderConfig) =>
      provider.models.some((model) => model.capability === 'video' && model.videoEnabled === true);

    let providerId: string | undefined;
    let modelId: string | undefined;

    if (override?.modelId) {
      if (override.providerId) {
        providerId = override.providerId;
        modelId = override.modelId;
      } else {
        const matched = providers.find((provider) =>
          provider.models.some(
            (model) =>
              model.id === override.modelId &&
              model.capability === 'video' &&
              model.videoEnabled === true,
          ),
        );
        if (matched) {
          providerId = matched.id;
          modelId = override.modelId;
        }
      }
    }

    if (!providerId && defaults.video) {
      const defProvider = providers.find((provider) => provider.id === defaults.video!.providerId);
      if (
        defProvider?.hasKey &&
        defProvider.models.some(
          (model) =>
            model.id === defaults.video!.modelId &&
            model.capability === 'video' &&
            model.videoEnabled === true,
        )
      ) {
        providerId = defProvider.id;
        modelId = defaults.video.modelId;
      }
    }

    if (!providerId) {
      const fallback =
        providers.find((provider) => provider.hasKey && isEnabledVideo(provider)) ??
        providers.find(isEnabledVideo);
      if (fallback) {
        providerId = fallback.id;
        modelId = fallback.models.find(
          (model) => model.capability === 'video' && model.videoEnabled === true,
        )?.id;
      }
    }

    if (!providerId || !modelId) {
      return { error: '请先添加并启用一个视频模型（设置 → 模型 → Video）' };
    }

    const provider = providers.find((entry) => entry.id === providerId);
    const model = provider?.models.find(
      (entry) =>
        entry.id === modelId && entry.capability === 'video' && entry.videoEnabled === true,
    );
    if (!provider || !model) {
      return { error: `视频模型未启用：${modelId}` };
    }
    if (!provider.hasKey) {
      return { error: `请先在 Video 页配置 ${providerId} 的 API Key` };
    }

    const apiKey = this.models.readKey(providerId);
    if (!apiKey) {
      return { error: `${providerId} 没有可用的 API Key` };
    }

    const protocol = inferVideoProtocol(providerId, model.api, provider.api);
    const baseUrl = provider.baseUrl?.trim() || defaultVideoBaseUrl(providerId, protocol);
    const catalogDefaultRate = DIRECT_VIDEO_MODELS[providerId]?.find(
      (entry) => entry.id === modelId,
    )?.usdPerSecond;
    const usdPerSecond =
      model.usdPerSecond !== undefined && model.usdPerSecond > 0
        ? model.usdPerSecond
        : catalogDefaultRate;

    return {
      providerId,
      modelId,
      baseUrl,
      apiKey,
      protocol,
      usdPerSecond,
    };
  }
}
