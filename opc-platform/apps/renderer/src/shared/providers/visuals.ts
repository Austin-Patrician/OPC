/**
 * Provider visuals: icon file, brand color and display name.
 *
 * Icons live in `public/provider-icons/` (copied from the design bundle) and are
 * referenced by filename, so a provider can be added by dropping a file and one
 * entry here — no import graph to maintain.
 */

export interface ProviderVisual {
  /** File name inside `public/provider-icons/`. */
  icon?: string;
  /** Brand color, used when the icon is missing and for tinted backgrounds. */
  color: string;
  /** Fallback initials (1–2 chars) when no icon matches. */
  initials: string;
}

const VISUALS: Record<string, ProviderVisual> = {
  openai: { icon: 'openai.svg', color: '#10A37F', initials: 'AI' },
  anthropic: { icon: 'anthropic.svg', color: '#D97757', initials: 'AN' },
  google: { icon: 'gemini-color.svg', color: '#4285F4', initials: 'G' },
  deepseek: { icon: 'deepseek-color.svg', color: '#4D6BFE', initials: 'DS' },
  moonshotai: { icon: 'moonshot.svg', color: '#1A1A1A', initials: 'K' },
  kimi: { icon: 'kimi-color.svg', color: '#1A1A1A', initials: 'K' },
  openrouter: { icon: 'openrouter.svg', color: '#6467F2', initials: 'OR' },
  groq: { icon: 'groq.svg', color: '#F55036', initials: 'GQ' },
  xai: { icon: 'grok.svg', color: '#111827', initials: 'X' },
  zai: { icon: 'zai.svg', color: '#1F2937', initials: 'Z' },
  mistral: { icon: 'mistral-color.svg', color: '#FA520F', initials: 'M' },
  minimax: { icon: 'minimax-color.svg', color: '#F23F5D', initials: 'MM' },
  qwen: { icon: 'qwen-color.svg', color: '#615CED', initials: 'Q' },
  bailian: { icon: 'bailian-color.svg', color: '#615CED', initials: 'BL' },
  volcengine: { icon: 'volcengine-color.svg', color: '#1664FF', initials: 'VE' },
  bytedance: { icon: 'bytedance-color.svg', color: '#325AB4', initials: 'BD' },
  hunyuan: { icon: 'hunyuan-color.svg', color: '#0052D9', initials: 'HY' },
  jimeng: { icon: 'jimeng-color.svg', color: '#0F172A', initials: 'JM' },
  kling: { icon: 'kling-color.svg', color: '#111827', initials: 'KL' },
  stepfun: { icon: 'stepfun.svg', color: '#1F2937', initials: 'SF' },
  baai: { icon: 'baai.svg', color: '#0E7490', initials: 'BA' },
  longcat: { icon: 'longcat-color.svg', color: '#F59E0B', initials: 'LC' },
  together: { icon: 'together-color.svg', color: '#0F172A', initials: 'TG' },
  fireworks: { icon: 'fireworks-color.svg', color: '#F97316', initials: 'FW' },
  cerebras: { icon: 'cerebras-color.svg', color: '#F97316', initials: 'CB' },
  huggingface: { icon: 'huggingface-color.svg', color: '#FFD21E', initials: 'HF' },
  nvidia: { icon: 'nvidia-color.svg', color: '#76B900', initials: 'NV' },
  'github-copilot': { icon: 'copilot-color.svg', color: '#1F2328', initials: 'GH' },
  azure: { icon: 'azure-color.svg', color: '#0078D4', initials: 'AZ' },
  'amazon-bedrock': { icon: 'amazon-bedrock.png', color: '#FF9900', initials: 'BR' },
  'cloudflare-workers-ai': { icon: 'workersai-color.svg', color: '#F38020', initials: 'CF' },
  'cloudflare-ai-gateway': { icon: 'cloudflare-color.svg', color: '#F38020', initials: 'CF' },
  ollama: { icon: 'ollama.svg', color: '#111827', initials: 'OL' },
  opencode: { icon: 'opencode.svg', color: '#111827', initials: 'OC' },
  'vercel-ai-gateway': { icon: 'vercel.svg', color: '#111827', initials: 'V' },
  xiaomi: { icon: 'xiaomimimo.svg', color: '#FF6900', initials: 'MI' },
  'ant-ling': { icon: 'ant-ling.svg', color: '#1677FF', initials: 'AL' },
};

/** Ids that appear in configs under different names than the icon files. */
const ALIASES: Record<string, string> = {
  'azure-openai': 'azure',
  'amazon': 'amazon-bedrock',
  bedrock: 'amazon-bedrock',
  'github': 'github-copilot',
  copilot: 'github-copilot',
  moonshot: 'moonshotai',
  'moonshot-ai': 'moonshotai',
  'kimi-coding': 'kimi',
  'qwen-token-plan': 'qwen',
  'qwen-token-plan-cn': 'qwen',
  grok: 'xai',
  gemini: 'google',
  'google-vertex': 'google',
  workersai: 'cloudflare-workers-ai',
  'vercel': 'vercel-ai-gateway',
  'xiaomi-token-plan-cn': 'xiaomi',
  'xiaomi-token-plan-ams': 'xiaomi',
  'xiaomi-token-plan-sgp': 'xiaomi',
  'minimax-cn': 'minimax',
  'moonshotai-cn': 'moonshotai',
  'zai-coding-cn': 'zai',
};

const normalize = (value: string) => value.toLowerCase().replaceAll('_', '-').trim();

/**
 * Image-model vendors → provider id. pi routes every image model through
 * OpenRouter, but the row still shows the model's *own* brand, which is what the
 * design asks for.
 */
const VENDOR_PROVIDERS: Record<string, string> = {
  'black forest labs': 'black-forest-labs',
  'bytedance seed': 'bytedance',
  bytedance: 'bytedance',
  google: 'google',
  krea: 'krea',
  meta: 'meta',
  'microsoft ai': 'microsoft',
  openai: 'openai',
  openrouter: 'openrouter',
  qwen: 'qwen',
  recraft: 'recraft',
  sourceful: 'sourceful',
  tencent: 'hunyuan',
  xai: 'xai',
};

/** Resolves a human vendor name (`ByteDance Seed`) to a provider id. */
export function vendorProviderId(vendor: string): string {
  return VENDOR_PROVIDERS[normalize(vendor)] ?? normalize(vendor);
}

/** Resolves a provider id to visuals, tolerating `-color` suffixes and aliases. */
export function providerVisual(providerId: string): ProviderVisual {
  const id = normalize(providerId);
  if (VISUALS[id]) return VISUALS[id] as ProviderVisual;

  const aliased = ALIASES[id];
  if (aliased && VISUALS[aliased]) return VISUALS[aliased] as ProviderVisual;

  const prefix = Object.keys(VISUALS).find((key) => id.startsWith(key));
  if (prefix) return VISUALS[prefix] as ProviderVisual;

  const initials = providerId
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '')
    .slice(0, 2)
    .toUpperCase();

  return { color: '#8E8E93', initials: initials || '?' };
}

/**
 * URL of a provider icon, or undefined when the id has none.
 *
 * Relative on purpose: the packaged app loads the renderer over `file://`, where an
 * absolute `/provider-icons/…` would resolve to the filesystem root.
 */
export function providerIconUrl(providerId: string): string | undefined {
  const icon = providerVisual(providerId).icon;
  return icon ? `./provider-icons/${icon}` : undefined;
}
