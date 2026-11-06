import type { ModelWire } from './protocol';

/**
 * 在子进程里直接调用模型（W5 的「独立会话」真正落地的那一步）。
 *
 * 为什么值得多这一层：判断原本要绕回主进程执行，于是"主进程卡住"时语义层也停。
 * 现在把 provider 配置（含一把钥匙）通过专用通道交给子进程，判断在这里完成——
 * 主进程只负责**解密**与**授权**，不再出现在调用路径上。
 *
 * 三条纪律：
 *
 * 1. **密钥只在内存**：不写库、不进环境变量、不进日志。
 * 2. **只建一个 provider**：不引入整张目录，出问题的面越小越好。
 * 3. **失败就退回主进程**：OAuth-only 的 provider 没有静态 key，这里建不起来，
 *    那条路仍然由主进程代判——退回是兜底，不是失败。
 */

export type CompleteFn = (prompt: string) => Promise<string>;

/** 一次判断最多等这么久（含网络往返）。 */
const COMPLETE_TIMEOUT_MS = 2 * 60_000;

export async function createLocalJudge(wire: ModelWire): Promise<CompleteFn> {
  const { createModels, createProvider } = await import('@earendil-works/pi-ai/models');
  const api = await apiFor(wire.api);
  if (!api) throw new Error(`不支持的接口类型：${wire.api}`);

  const models = createModels();
  const provider = await createProvider({
    id: wire.providerId,
    name: wire.providerName,
    baseUrl: wire.baseUrl.replace(/\/$/, ''),
    auth: {
      apiKey: {
        name: `${wire.providerName} API key`,
        resolve: async () => ({ auth: { apiKey: wire.apiKey }, source: 'watchdog' }),
      },
    },
    // 一个模型就够：它只做一次判断。字段要按 pi 的模型描述来填——
    // 少一个 `provider`，`complete()` 就会说 "Unknown provider: undefined"。
    models: [
      {
        id: wire.modelId,
        name: wire.modelName,
        api: wire.api,
        provider: wire.providerId,
        baseUrl: wire.baseUrl.replace(/\/$/, ''),
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ] as never,
    api: { [wire.api]: api } as never,
  });
  models.setProvider(provider);

  const model = models.getModel(wire.providerId, wire.modelId);
  if (!model) throw new Error('模型没有注册成功');

  return async (prompt: string) => {
    // 一次调用必须有上限：`pendingJudge` 是单飞的，请求挂住就等于语义层停摆。
    // 这里不假设 provider 支持 AbortSignal，用 race 保证"人这边能继续"。
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`模型 ${Math.round(COMPLETE_TIMEOUT_MS / 1000)} 秒没有返回`)),
        COMPLETE_TIMEOUT_MS,
      );
      timer.unref?.();
    });
    try {
      const answer = await Promise.race([
        models.complete(model, {
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        } as never),
        timeout,
      ]);
      const text = ((answer as { content?: { type: string; text?: string }[] }).content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('');
      if (!text.trim()) {
        // 空回答不是"判不了"，是这条通道没通：把原始返回的形状带出去，好查。
        throw new Error(`模型没有返回文本：${JSON.stringify(answer).slice(0, 300)}`);
      }
      return text;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

/** 与 `models/runtime.ts` 里同一套懒加载；这里只保留聊天流需要的那些。 */
async function apiFor(kind: string): Promise<unknown> {
  switch (kind) {
    case 'anthropic-messages':
      return (await import('@earendil-works/pi-ai/api/anthropic-messages.lazy')).anthropicMessagesApi();
    case 'openai-completions':
      return (await import('@earendil-works/pi-ai/api/openai-completions.lazy')).openAICompletionsApi();
    case 'openai-responses':
      return (await import('@earendil-works/pi-ai/api/openai-responses.lazy')).openAIResponsesApi();
    case 'azure-openai-responses':
      return (await import('@earendil-works/pi-ai/api/azure-openai-responses.lazy')).azureOpenAIResponsesApi();
    case 'google-generative-ai':
      return (await import('@earendil-works/pi-ai/api/google-generative-ai.lazy')).googleGenerativeAIApi();
    case 'mistral-conversations':
      return (await import('@earendil-works/pi-ai/api/mistral-conversations.lazy')).mistralConversationsApi();
    case 'pi-messages':
      return (await import('@earendil-works/pi-ai/api/pi-messages.lazy')).piMessagesApi();
    default:
      return undefined;
  }
}
