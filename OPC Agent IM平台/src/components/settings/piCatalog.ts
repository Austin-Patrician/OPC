/**
 * Curated snapshot of the built-in catalog shipped in `@earendil-works/pi-ai` 1.4.0
 * (https://github.com/earendil-works/pi, packages/ai).
 *
 * Provider IDs, API identifiers, base URLs, environment variables and model IDs are copied
 * verbatim from the published package. Only a representative subset of chat models is listed
 * per provider; `modelCount` is the size of that provider's full built-in chat catalog.
 */

export const PI_AI_PACKAGE = '@earendil-works/pi-ai';
export const PI_AI_VERSION = '1.4.0';
export const PI_REPO_URL = 'https://github.com/earendil-works/pi';
export const PI_SITE_URL = 'https://pi.dev';
export const PI_NPM_URL = 'https://www.npmjs.com/package/@earendil-works/pi-ai';
export const PI_AGENT_DIR = '~/.pi/agent';
/** Built-in providers that ship chat models (`typesafe` is classifier-only and excluded). */
export const PI_CHAT_PROVIDER_TOTAL = 41;

export type AuthMode = 'apiKey' | 'oauth' | 'ambient';

export type ProviderGroup = 'official' | 'subscription' | 'cloud' | 'gateway' | 'china';

export interface PiModel {
  id: string;
  name: string;
  /** Context window in thousands of tokens. */
  context: number;
  reasoning: boolean;
  vision: boolean;
}

export interface ProviderField {
  env: string;
  label: string;
  placeholder: string;
  required?: boolean;
}

export interface ProviderRegion {
  id: string;
  label: string;
  baseUrl: string;
  envVar: string;
}

export interface PiProvider {
  id: string;
  name: string;
  group: ProviderGroup;
  mark: string;
  color: string;
  description: string;
  apis: string[];
  baseUrl: string;
  /** Environment variable that supplies the API key / token (first entry is canonical). */
  envVars: string[];
  auth: AuthMode[];
  keyLabel?: string;
  oauthLabel?: string;
  ambientEnv?: string[];
  fields?: ProviderField[];
  regions?: ProviderRegion[];
  modelCount: number;
  models: PiModel[];
}

export const PROVIDER_GROUPS: { id: ProviderGroup; label: string }[] = [
  { id: 'official', label: '官方 API' },
  { id: 'subscription', label: '订阅登录' },
  { id: 'cloud', label: '云平台' },
  { id: 'gateway', label: '聚合网关' },
  { id: 'china', label: '国内模型' },
];

export const AUTH_MODE_LABEL: Record<AuthMode, string> = {
  apiKey: 'API Key',
  oauth: '订阅登录',
  ambient: '云凭据',
};

const m = (
  id: string,
  name: string,
  context: number,
  reasoning = true,
  vision = true
): PiModel => ({ id, name, context, reasoning, vision });

export const LLM_PROVIDERS: PiProvider[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    group: 'official',
    mark: 'A',
    color: '#D97757',
    description: 'Claude 系列模型，支持 API Key 或 Claude Pro / Max 订阅登录。',
    apis: ['anthropic-messages'],
    baseUrl: 'https://api.anthropic.com',
    envVars: ['ANTHROPIC_API_KEY'],
    auth: ['apiKey', 'oauth'],
    oauthLabel: 'Claude Pro / Max',
    modelCount: 17,
    models: [
      m('claude-sonnet-5-5', 'Claude Sonnet 5.5', 1000),
      m('claude-opus-5-5', 'Claude Opus 5.5', 1000),
      m('claude-haiku-5-5', 'Claude Haiku 5.5', 1000),
      m('claude-fable-5-1', 'Claude Fable 5.1', 1000),
      m('claude-sonnet-4-6', 'Claude Sonnet 4.6', 1000),
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    group: 'official',
    mark: 'O',
    color: '#10A37F',
    description: 'GPT 与 o 系列模型，通过 Responses API 调用。',
    apis: ['openai-responses'],
    baseUrl: 'https://api.openai.com/v1',
    envVars: ['OPENAI_API_KEY'],
    auth: ['apiKey'],
    modelCount: 42,
    models: [
      m('gpt-6.1-sol', 'GPT-6.1 Sol', 272),
      m('gpt-6-astra', 'GPT-6 Astra', 272),
      m('gpt-5.5', 'GPT-5.5', 272),
      m('gpt-5.4-mini', 'GPT-5.4 mini', 400),
      m('o4-mini', 'o4-mini', 200),
    ],
  },
  {
    id: 'google',
    name: 'Google Gemini',
    group: 'official',
    mark: 'G',
    color: '#4285F4',
    description: 'Gemini API（Google AI Studio），百万级上下文窗口。',
    apis: ['google-generative-ai'],
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    envVars: ['GEMINI_API_KEY'],
    auth: ['apiKey'],
    modelCount: 24,
    models: [
      m('gemini-pro-latest', 'Gemini Pro Latest', 1049),
      m('gemini-flash-latest', 'Gemini Flash Latest', 1049),
      m('gemini-4-argon', 'Gemini 4 Argon', 1049),
      m('gemini-3.8-flash', 'Gemini 3.8 Flash', 1049),
      m('gemini-2.5-pro', 'Gemini 2.5 Pro', 1049),
    ],
  },
  {
    id: 'xai',
    name: 'xAI',
    group: 'official',
    mark: 'x',
    color: '#1C1C1E',
    description: 'Grok 系列模型，支持 API Key 或 Grok / X 订阅登录。',
    apis: ['openai-responses'],
    baseUrl: 'https://api.x.ai/v1',
    envVars: ['XAI_API_KEY'],
    auth: ['apiKey', 'oauth'],
    oauthLabel: 'Grok / X 订阅',
    modelCount: 4,
    models: [
      m('grok-4.7', 'Grok 4.7', 500),
      m('grok-4.6', 'Grok 4.6', 500),
      m('grok-4.5', 'Grok 4.5', 500),
      m('grok-4.3', 'Grok 4.3', 1000),
    ],
  },
  {
    id: 'mistral',
    name: 'Mistral',
    group: 'official',
    mark: 'M',
    color: '#FA520F',
    description: 'Mistral Large / Medium、Devstral 与 Codestral 编程模型。',
    apis: ['mistral-conversations'],
    baseUrl: 'https://api.mistral.ai',
    envVars: ['MISTRAL_API_KEY'],
    auth: ['apiKey'],
    modelCount: 37,
    models: [
      m('mistral-large-4', 'Mistral Large 4', 1049),
      m('mistral-medium-2604', 'Mistral Medium 3.5', 262),
      m('magistral-medium-latest', 'Magistral Medium (latest)', 262),
      m('devstral-latest', 'Devstral 2', 262, false, false),
      m('codestral-latest', 'Codestral (latest)', 256, false, false),
    ],
  },
  {
    id: 'groq',
    name: 'Groq',
    group: 'official',
    mark: 'g',
    color: '#F55036',
    description: 'LPU 低延迟推理，托管开源模型。',
    apis: ['openai-completions'],
    baseUrl: 'https://api.groq.com/openai/v1',
    envVars: ['GROQ_API_KEY'],
    auth: ['apiKey'],
    modelCount: 7,
    models: [
      m('openai/gpt-oss-120b', 'GPT OSS 120B', 131, true, false),
      m('qwen/qwen3.8-27b', 'Qwen3.8 27B', 131),
      m('llama-3.3-70b-versatile', 'Llama 3.3 70B', 131, false, false),
    ],
  },
  {
    id: 'openai-codex',
    name: 'ChatGPT (Codex)',
    group: 'subscription',
    mark: 'C',
    color: '#0D0D0D',
    description: '使用 ChatGPT Plus / Pro 订阅额度调用 Codex 模型，仅支持登录授权。',
    apis: ['openai-codex-responses'],
    baseUrl: 'https://chatgpt.com/backend-api',
    envVars: [],
    auth: ['oauth'],
    oauthLabel: 'ChatGPT Plus / Pro',
    modelCount: 7,
    models: [
      m('gpt-6.1-sol', 'GPT-6.1 Sol', 500),
      m('gpt-6-sol', 'GPT-6 Sol', 272),
      m('gpt-6-astra', 'GPT-6 Astra', 272),
      m('gpt-5.6-sol', 'GPT-5.6 Sol', 272),
    ],
  },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    group: 'subscription',
    mark: 'GH',
    color: '#24292F',
    description: '复用 GitHub Copilot 订阅，可调用 Claude、GPT、Gemini 与 Grok。',
    apis: ['anthropic-messages', 'openai-responses', 'openai-completions'],
    baseUrl: 'https://api.individual.githubcopilot.com',
    envVars: ['COPILOT_GITHUB_TOKEN'],
    auth: ['oauth', 'apiKey'],
    keyLabel: 'GitHub Token',
    oauthLabel: 'GitHub Copilot',
    modelCount: 26,
    models: [
      m('claude-sonnet-5.5', 'Claude Sonnet 5.5', 1000),
      m('gpt-6.1-sol', 'GPT-6.1 Sol', 1050),
      m('gemini-4-argon', 'Gemini 4 Argon', 1049),
      m('grok-4.6', 'Grok 4.6', 500),
    ],
  },
  {
    id: 'radius',
    name: 'Radius',
    group: 'subscription',
    mark: 'R',
    color: '#5B5BD6',
    description: 'pi.dev 官方模型服务，提供 Balanced / Cheap 智能路由与主流模型。',
    apis: ['pi-messages'],
    baseUrl: 'https://radius.pi.dev/v1',
    envVars: ['RADIUS_API_KEY'],
    auth: ['oauth', 'apiKey'],
    oauthLabel: 'Radius',
    modelCount: 32,
    models: [
      m('balanced', 'Balanced', 1049),
      m('cheap', 'Cheap', 1000),
      m('claude-sonnet-5-5', 'Claude Sonnet 5.5', 1000),
      m('gpt-6-astra', 'GPT 6 Astra', 272),
    ],
  },
  {
    id: 'amazon-bedrock',
    name: 'Amazon Bedrock',
    group: 'cloud',
    mark: 'AWS',
    color: '#FF9900',
    description: '读取本机 AWS 凭据链（Profile、IAM 密钥、Bearer Token、ECS / IRSA 角色）。',
    apis: ['bedrock-converse-stream'],
    baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    envVars: [],
    auth: ['ambient'],
    ambientEnv: [
      'AWS_PROFILE',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_BEARER_TOKEN_BEDROCK',
    ],
    fields: [
      { env: 'AWS_PROFILE', label: '配置档案', placeholder: 'default' },
      { env: 'AWS_REGION', label: '区域', placeholder: 'us-east-1' },
    ],
    modelCount: 193,
    models: [
      m('anthropic.claude-sonnet-5-5', 'Claude Sonnet 5.5', 1000),
      m('anthropic.claude-opus-5-5', 'Claude Opus 5.5', 1000),
      m('amazon.nova-2-lite-v1:0', 'Nova 2 Lite', 1000),
    ],
  },
  {
    id: 'google-vertex',
    name: 'Google Vertex AI',
    group: 'cloud',
    mark: 'V',
    color: '#34A853',
    description: '使用 Application Default Credentials 或 Cloud API Key 访问 Vertex 上的 Gemini。',
    apis: ['google-vertex'],
    baseUrl: 'https://{location}-aiplatform.googleapis.com',
    envVars: ['GOOGLE_CLOUD_API_KEY'],
    auth: ['ambient', 'apiKey'],
    ambientEnv: ['GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION'],
    fields: [
      {
        env: 'GOOGLE_CLOUD_PROJECT',
        label: '项目 ID',
        placeholder: 'my-gcp-project',
        required: true,
      },
      {
        env: 'GOOGLE_CLOUD_LOCATION',
        label: '区域',
        placeholder: 'us-central1',
        required: true,
      },
    ],
    modelCount: 14,
    models: [
      m('gemini-4-argon', 'Gemini 4 Argon', 1049),
      m('gemini-3.8-flash', 'Gemini 3.8 Flash', 1049),
      m('gemini-2.5-pro', 'Gemini 2.5 Pro', 1049),
    ],
  },
  {
    id: 'azure',
    name: 'Azure OpenAI',
    group: 'cloud',
    mark: 'Az',
    color: '#0078D4',
    description: 'Azure 托管的 OpenAI 模型，需提供资源名称或自定义 Base URL。',
    apis: ['azure-openai-responses'],
    baseUrl: '',
    envVars: ['AZURE_OPENAI_API_KEY'],
    auth: ['apiKey'],
    fields: [
      { env: 'AZURE_OPENAI_RESOURCE_NAME', label: '资源名称', placeholder: 'my-openai-resource' },
      { env: 'AZURE_OPENAI_API_VERSION', label: 'API 版本', placeholder: '可选' },
    ],
    modelCount: 43,
    models: [
      m('gpt-6.1-sol', 'GPT-6.1 Sol', 272),
      m('gpt-5.5', 'GPT-5.5', 1050),
      m('gpt-5.4-mini', 'GPT-5.4 mini', 400),
      m('o4-mini', 'o4-mini', 200),
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    group: 'gateway',
    mark: 'OR',
    color: '#6467F2',
    description: '一个密钥访问数百个模型；同时是 pi 图像生成的 Provider。',
    apis: ['openai-completions', 'anthropic-messages'],
    baseUrl: 'https://openrouter.ai/api/v1',
    envVars: ['OPENROUTER_API_KEY'],
    auth: ['apiKey', 'oauth'],
    oauthLabel: 'OpenRouter',
    modelCount: 401,
    models: [
      m('~anthropic/claude-sonnet-latest', 'Anthropic: Claude Sonnet Latest', 1000),
      m('~openai/gpt-sol-latest', 'OpenAI: GPT Sol Latest', 1050),
      m('~google/gemini-pro-latest', 'Google: Gemini Pro Latest', 1049),
      m('~deepseek/deepseek-pro-latest', 'DeepSeek: DeepSeek Pro Latest', 1049, true, false),
      m('~moonshotai/kimi-latest', 'MoonshotAI: Kimi Latest', 1049),
    ],
  },
  {
    id: 'vercel-ai-gateway',
    name: 'Vercel AI Gateway',
    group: 'gateway',
    mark: 'VC',
    color: '#000000',
    description: 'Vercel 统一模型网关，按用量计费并支持故障转移。',
    apis: ['anthropic-messages'],
    baseUrl: 'https://ai-gateway.vercel.sh',
    envVars: ['AI_GATEWAY_API_KEY'],
    auth: ['apiKey'],
    modelCount: 305,
    models: [
      m('anthropic/claude-sonnet-5.5', 'Claude Sonnet 5.5', 1000),
      m('openai/gpt-6.1-sol', 'GPT-6.1 Sol', 1050),
      m('google/gemini-4-argon', 'Gemini 4 Argon', 1000),
      m('deepseek/deepseek-v4-pro', 'DeepSeek V4 Pro', 1000, true, false),
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    group: 'china',
    mark: 'DS',
    color: '#4D6BFE',
    description: 'DeepSeek V4 系列，百万上下文与深度推理。',
    apis: ['openai-completions'],
    baseUrl: 'https://api.deepseek.com',
    envVars: ['DEEPSEEK_API_KEY'],
    auth: ['apiKey'],
    modelCount: 2,
    models: [
      m('deepseek-v4-pro', 'DeepSeek V4 Pro', 1000, true, false),
      m('deepseek-flash', 'DeepSeek V4.1 Flash', 1000),
    ],
  },
  {
    id: 'moonshotai',
    name: 'Moonshot AI (Kimi)',
    group: 'china',
    mark: 'K',
    color: '#16191E',
    description: 'Kimi K3 与 K2.7 Code 编程模型，可选国际站或中国站。',
    apis: ['openai-completions'],
    baseUrl: 'https://api.moonshot.ai/v1',
    envVars: ['MOONSHOT_API_KEY'],
    auth: ['apiKey'],
    regions: [
      {
        id: 'moonshotai',
        label: '国际站',
        baseUrl: 'https://api.moonshot.ai/v1',
        envVar: 'MOONSHOT_API_KEY',
      },
      {
        id: 'moonshotai-cn',
        label: '中国站',
        baseUrl: 'https://api.moonshot.cn/v1',
        envVar: 'MOONSHOT_API_KEY',
      },
    ],
    modelCount: 4,
    models: [
      m('kimi-k3', 'Kimi K3', 1049),
      m('kimi-k2.7-code', 'Kimi K2.7 Code', 262),
      m('kimi-k2.6', 'Kimi K2.6', 262),
    ],
  },
  {
    id: 'zai',
    name: 'Z.ai (GLM)',
    group: 'china',
    mark: 'Z',
    color: '#3859FF',
    description: '智谱 GLM-5 系列模型（Coding 端点）。',
    apis: ['openai-completions'],
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    envVars: ['ZAI_API_KEY'],
    auth: ['apiKey'],
    modelCount: 7,
    models: [
      m('glm-5.3', 'GLM-5.3', 1000, true, false),
      m('glm-5.3-flash', 'GLM-5.3-Flash', 1000),
      m('glm-5.2', 'GLM-5.2', 1000, true, false),
      m('glm-4.7', 'GLM-4.7', 205, true, false),
    ],
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    group: 'china',
    mark: 'MM',
    color: '#E2445C',
    description: 'MiniMax M3 系列，兼容 Anthropic Messages 协议，可选国际站或中国站。',
    apis: ['anthropic-messages'],
    baseUrl: 'https://api.minimax.io/anthropic',
    envVars: ['MINIMAX_API_KEY'],
    auth: ['apiKey'],
    regions: [
      {
        id: 'minimax',
        label: '国际站',
        baseUrl: 'https://api.minimax.io/anthropic',
        envVar: 'MINIMAX_API_KEY',
      },
      {
        id: 'minimax-cn',
        label: '中国站',
        baseUrl: 'https://api.minimaxi.com/anthropic',
        envVar: 'MINIMAX_CN_API_KEY',
      },
    ],
    modelCount: 4,
    models: [
      m('MiniMax-M3', 'MiniMax-M3', 1000),
      m('MiniMax-M3.1-Flash', 'MiniMax-M3.1-Flash', 1000),
      m('MiniMax-M2.7', 'MiniMax-M2.7', 205, true, false),
    ],
  },
];

export const findProvider = (id: string) =>
  LLM_PROVIDERS.find((p) => p.id === id || p.regions?.some((r) => r.id === id));

/** pi `defaultThinkingLevel` values, in order. */
export const THINKING_LEVELS = [
  { value: 'off', label: '关闭' },
  { value: 'minimal', label: '极少' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '超高' },
  { value: 'max', label: '最大' },
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number]['value'];

// ---------------------------------------------------------------------------
// Image generation: pi-ai registers a single image API, `openrouter-images`,
// and every built-in image model is served by the `openrouter` provider.
// ---------------------------------------------------------------------------
export const IMAGE_API = 'openrouter-images';

export const IMAGE_PROVIDER_ID = 'openrouter';

export const IMAGE_BASE_URL = 'https://openrouter.ai/api/v1';

export interface PiImageModel {
  id: string;
  name: string;
  vendor: string;
  /** Accepts reference images in addition to a text prompt. */
  imageInput: boolean;
}

const IMAGE_VENDORS: Record<string, string> = {
  'black-forest-labs': 'Black Forest Labs',
  'bytedance-seed': 'ByteDance Seed',
  google: 'Google',
  krea: 'Krea',
  meta: 'Meta',
  microsoft: 'Microsoft AI',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  qwen: 'Qwen',
  recraft: 'Recraft',
  sourceful: 'Sourceful',
  tencent: 'Tencent',
  'x-ai': 'xAI',
};
// [id, display name] – the catalog prefixes names with the vendor, which the UI shows separately.
const RAW_IMAGE_MODELS: [string, string][] = [
  ['black-forest-labs/flux-3-image', 'FLUX 3 Image'],
  ['black-forest-labs/flux-3-image-klein', 'FLUX 3 Image Klein'],
  ['black-forest-labs/flux.2-flex', 'FLUX.2 Flex'],
  ['black-forest-labs/flux.2-klein-4b', 'FLUX.2 Klein 4B'],
  ['black-forest-labs/flux.2-max', 'FLUX.2 Max'],
  ['black-forest-labs/flux.2-pro', 'FLUX.2 Pro'],
  ['bytedance-seed/seedream-4.5', 'Seedream 4.5'],
  ['bytedance-seed/seedream-5-0-flash', 'Seedream 5.0 Flash'],
  ['bytedance-seed/seedream-5-0-lite', 'Seedream 5.0 Lite'],
  ['bytedance-seed/seedream-5-0-pro', 'Seedream 5.0 Pro'],
  ['google/gemini-2.5-flash-image', 'Nano Banana (Gemini 2.5 Flash Image)'],
  ['google/gemini-3-pro-image', 'Nano Banana Pro (Gemini 3 Pro Image)'],
  ['google/gemini-3-pro-image-preview', 'Nano Banana Pro (Gemini 3 Pro Image Preview)'],
  ['google/gemini-3.1-flash-image', 'Nano Banana 2 (Gemini 3.1 Flash Image)'],
  ['google/gemini-3.1-flash-image-preview', 'Nano Banana 2 (Gemini 3.1 Flash Image Preview)'],
  ['google/gemini-3.1-flash-lite-image', 'Nano Banana 2 Lite (Gemini 3.1 Flash Lite Image)'],
  ['google/gemini-nano-banana-2.1', 'Nano Banana 2.1'],
  ['krea/k3-edit', 'K3 Edit'],
  ['krea/krea-2-large', 'Krea 2 Large'],
  ['krea/krea-2-medium', 'Krea 2 Medium'],
  ['krea/krea-2-medium-turbo', 'Krea 2 Medium Turbo'],
  ['meta/muse-image', 'Muse Image'],
  ['microsoft/mai-image-2.5', 'MAI-Image-2.5'],
  ['microsoft/mai-image-2.5-pro', 'MAI-Image-2.5 Pro'],
  ['microsoft/mai-image-2.6', 'MAI-Image-2.6'],
  ['microsoft/mai-image-2.6-flash', 'MAI-Image-2.6 Flash'],
  ['openai/gpt-5-image', 'GPT-5 Image'],
  ['openai/gpt-5-image-mini', 'GPT-5 Image Mini'],
  ['openai/gpt-5.4-image-2', 'GPT-5.4 Image 2'],
  ['openai/gpt-image-1', 'GPT Image 1'],
  ['openai/gpt-image-1-mini', 'GPT Image 1 Mini'],
  ['openai/gpt-image-2', 'GPT Image 2'],
  ['openai/gpt-image-2.5-flare', 'GPT Image 2.5 Flare'],
  ['openai/gpt-image-2.5-sunburst', 'GPT Image 2.5 Sunburst'],
  ['openrouter/auto', 'Auto Router'],
  ['openrouter/auto-beta', 'Auto Router (Beta)'],
  ['qwen/qwen-image-2.1-pro', 'Qwen Image 2.1 Pro'],
  ['qwen/qwen-image-2.1-turbo', 'Qwen Image 2.1 Turbo'],
  ['qwen/qwen-image-3', 'Qwen Image 3'],
  ['qwen/qwen-image-3-pro', 'Qwen Image 3 Pro'],
  ['recraft/recraft-v3', 'Recraft V3'],
  ['recraft/recraft-v4', 'Recraft V4'],
  ['recraft/recraft-v4-pro', 'Recraft V4 Pro'],
  ['recraft/recraft-v4-pro-vector', 'Recraft V4 Pro Vector'],
  ['recraft/recraft-v4-styles', 'Recraft V4 Styles'],
  ['recraft/recraft-v4-styles-pro', 'Recraft V4 Styles Pro'],
  ['recraft/recraft-v4-styles-pro-vector', 'Recraft V4 Styles Pro Vector'],
  ['recraft/recraft-v4-styles-vector', 'Recraft V4 Styles Vector'],
  ['recraft/recraft-v4-vector', 'Recraft V4 Vector'],
  ['recraft/recraft-v4.1', 'Recraft V4.1'],
  ['recraft/recraft-v4.1-flash', 'Recraft V4.1 Flash'],
  ['recraft/recraft-v4.1-pro', 'Recraft V4.1 Pro'],
  ['recraft/recraft-v4.1-pro-vector', 'Recraft V4.1 Pro Vector'],
  ['recraft/recraft-v4.1-utility', 'Recraft V4.1 Utility'],
  ['recraft/recraft-v4.1-utility-pro', 'Recraft V4.1 Utility Pro'],
  ['recraft/recraft-v4.1-vector', 'Recraft V4.1 Vector'],
  ['sourceful/riverflow-v2-fast', 'Riverflow V2 Fast'],
  ['sourceful/riverflow-v2-pro', 'Riverflow V2 Pro'],
  ['sourceful/riverflow-v2.5-fast', 'Riverflow V2.5 Fast'],
  ['sourceful/riverflow-v2.5-pro', 'Riverflow V2.5 Pro'],
  ['tencent/hy-image-v3.5-preview', 'Hy Image 3.5 Preview'],
  ['x-ai/grok-imagine-image-2.0', 'Grok Imagine Image 2.0'],
  ['x-ai/grok-imagine-image-quality', 'Grok Imagine Image Quality'],
];

/** The only built-in image model that takes a text prompt alone. */
const TEXT_ONLY_IMAGE_MODELS = new Set(['recraft/recraft-v4.1-flash']);

export const IMAGE_MODELS: PiImageModel[] = RAW_IMAGE_MODELS.map(([id, name]) => {
  const prefix = id.split('/')[0];
  return {
    id,
    name,
    vendor: IMAGE_VENDORS[prefix] ?? prefix,
    imageInput: !TEXT_ONLY_IMAGE_MODELS.has(id),
  };
});

export const IMAGE_VENDOR_LIST = Array.from(new Set(IMAGE_MODELS.map((im) => im.vendor)));

export const formatContext = (k: number) =>
  k >= 1000 ? `${(k / 1000).toFixed(k % 1000 === 0 ? 0 : 2).replace(/\.?0+$/, '')}M` : `${k}K`;
