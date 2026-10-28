import fs from 'node:fs';
import path from 'node:path';
import type { GeneratedImageResult } from '@opc/shared/ipc';
import type { AppPaths } from '../env';
import type { ModelConfigService } from './modelConfigService';
import { generateImage } from './imageGeneration';
import { defaultNetworkClient, type NetworkClient } from '../network/networkClient';

interface ResolvedTarget {
  providerId: string;
  modelId: string;
  baseUrl: string;
  apiKey: string;
}

/**
 * Image generation for both entry points:
 *  - the settings page (`generate`, saves to `userData/images`)
 *  - the agent tool (`generateBytes`, the tool writes into the task workspace)
 *
 * Provider resolution is shared, so "which provider/model" is answered once:
 * explicit model → configured default image model → any configured image model.
 */
export class ImageService {
  constructor(
    private readonly models: ModelConfigService,
    private readonly paths: AppPaths,
    private readonly network: NetworkClient = defaultNetworkClient,
  ) {}

  generateBytes = async (input: { prompt: string; modelId?: string }) => {
    const resolved = this.resolveTarget(input);
    if ('error' in resolved) return { ok: false as const, error: resolved.error };

    try {
      const image = await generateImage({
        baseUrl: resolved.baseUrl,
        apiKey: resolved.apiKey,
        model: resolved.modelId,
        prompt: input.prompt,
        providerId: resolved.providerId,
        network: this.network,
      });
      return {
        ok: true as const,
        bytes: new Uint8Array(image.bytes),
        mimeType: image.mimeType,
        model: resolved.modelId,
      };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  };

  generate = async (input: { prompt: string; modelId?: string }): Promise<GeneratedImageResult> => {
    const prompt = input.prompt.trim();
    if (!prompt) return { ok: false, error: '提示词为空' };

    const result = await this.generateBytes({ prompt, modelId: input.modelId });
    if (!result.ok || !result.bytes) return { ok: false, error: result.error };

    try {
      const dir = path.join(this.paths.userData, 'images');
      fs.mkdirSync(dir, { recursive: true });
      const fileName = `${Date.now()}-${result.model.replace(/[^\w.-]+/g, '_')}.png`;
      fs.writeFileSync(path.join(dir, fileName), result.bytes);

      return {
        ok: true,
        fileName,
        dataUrl: `data:${result.mimeType};base64,${Buffer.from(result.bytes).toString('base64')}`,
        bytes: result.bytes.byteLength,
        model: result.model,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  /** True when at least one provider owns an image model and has credentials. */
  isAvailable = (): boolean =>
    this.models
      .listProviders()
      .some((provider) => provider.hasKey && provider.models.some((model) => model.capability === 'image'));

  private resolveTarget(input: { modelId?: string }): ResolvedTarget | { error: string } {
    const providers = this.models.listProviders();
    const defaults = this.models.getDefaults();

    const explicit = input.modelId
      ? providers.find((provider) => provider.models.some((model) => model.id === input.modelId))
      : undefined;
    const providerId =
      input.modelId && explicit
        ? explicit.id
        : (defaults.image?.providerId ??
          providers.find((provider) => provider.models.some((model) => model.capability === 'image'))?.id);
    const modelId =
      input.modelId ??
      (providerId === defaults.image?.providerId ? defaults.image?.modelId : undefined) ??
      providers
        .find((provider) => provider.id === providerId)
        ?.models.find((model) => model.capability === 'image')?.id;

    if (!providerId || !modelId) {
      return { error: '请先添加并选择一个图像模型（设置 → 模型 → Image）' };
    }

    const provider = providers.find((entry) => entry.id === providerId);
    if (!provider?.hasKey) return { error: `请先在 LLM 页配置 ${providerId} 的凭证` };

    const apiKey = this.models.readKey(providerId);
    // OAuth-backed providers keep tokens in pi's credential store; the HTTP image
    // endpoint needs a plain bearer key, so say so instead of failing obscurely.
    if (!apiKey) return { error: `${providerId} 没有可用的 API Key（OAuth 凭证不支持图像接口）` };

    return {
      providerId,
      modelId,
      baseUrl: provider.baseUrl || 'https://openrouter.ai/api/v1',
      apiKey,
    };
  }
}
