import type { CatalogModel } from '@opc/shared/domain';

/** Wire protocols supported by the video generation engine. Mirrors `ModelOption.api`. */
export const VIDEO_PROTOCOLS = [
  'fal-queue',
  'volcengine-ark-video',
  'kling-video',
  'minimax-video',
  'google-veo',
  'openai-videos',
] as const;

export type VideoProtocol = (typeof VIDEO_PROTOCOLS)[number];

/**
 * First-party & gateway video providers shipped out of the box with verified November 2026
 * model IDs and official per-second USD reference pricing.
 */
export const DIRECT_VIDEO_BASE_URLS: Record<string, string> = {
  fal: 'https://queue.fal.run',
  'volcengine-ark': 'https://ark.cn-beijing.volces.com/api/v3',
  kling: 'https://api.klingai.com',
  minimax: 'https://api.minimaxi.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  'openai-video': 'https://api.openai.com/v1',
};

export const DIRECT_VIDEO_MODELS: Record<string, CatalogModel[]> = {
  fal: [
    {
      id: 'kling/v4/text-to-video',
      name: 'Kling 4.0 (文生视频)',
      type: 'video',
      api: 'fal-queue',
      usdPerSecond: 0.157,
    },
    {
      id: 'kling/v4/image-to-video',
      name: 'Kling 4.0 (图生视频)',
      type: 'video',
      api: 'fal-queue',
      usdPerSecond: 0.157,
    },
    {
      id: 'bytedance/seedance-2.5/text-to-video',
      name: 'Seedance 2.5 (文生视频)',
      type: 'video',
      api: 'fal-queue',
      usdPerSecond: 0.216,
    },
    {
      id: 'bytedance/seedance-2.5/image-to-video',
      name: 'Seedance 2.5 (图生视频)',
      type: 'video',
      api: 'fal-queue',
      usdPerSecond: 0.216,
    },
    {
      id: 'fal-ai/veo3.1',
      name: 'Google Veo 3.1',
      type: 'video',
      api: 'fal-queue',
      usdPerSecond: 0.4,
    },
    {
      id: 'fal-ai/veo3.1/fast',
      name: 'Google Veo 3.1 Fast',
      type: 'video',
      api: 'fal-queue',
      usdPerSecond: 0.15,
    },
    {
      id: 'fal-ai/veo3.1/fast/first-last-frame-to-video',
      name: 'Google Veo 3.1 Fast (首尾帧)',
      type: 'video',
      api: 'fal-queue',
      usdPerSecond: 0.15,
    },
    {
      id: 'fal-ai/kling-video/v3/pro/text-to-video',
      name: 'Kling 3.0 Pro (文生视频)',
      type: 'video',
      api: 'fal-queue',
      usdPerSecond: 0.112,
    },
    {
      id: 'fal-ai/kling-video/v3/pro/image-to-video',
      name: 'Kling 3.0 Pro (图生视频)',
      type: 'video',
      api: 'fal-queue',
      usdPerSecond: 0.112,
    },
    {
      id: 'bytedance/seedance-2.0/fast/text-to-video',
      name: 'Seedance 2.0 Fast (文生视频)',
      type: 'video',
      api: 'fal-queue',
      usdPerSecond: 0.114,
    },
    {
      id: 'bytedance/seedance-2.0/fast/image-to-video',
      name: 'Seedance 2.0 Fast (图生视频)',
      type: 'video',
      api: 'fal-queue',
      usdPerSecond: 0.114,
    },
    {
      id: 'minimax/h3-max/text-to-video',
      name: 'MiniMax H3 Max',
      type: 'video',
      api: 'fal-queue',
      usdPerSecond: 0.06,
    },
    {
      id: 'minimax/h3-max-turbo/text-to-video',
      name: 'MiniMax H3 Max Turbo',
      type: 'video',
      api: 'fal-queue',
      usdPerSecond: 0.04,
    },
  ],
  'volcengine-ark': [
    {
      id: 'doubao-seedance-2-5-260628',
      name: '豆包 Seedance 2.5',
      type: 'video',
      api: 'volcengine-ark-video',
      usdPerSecond: 0.216,
    },
    {
      id: 'doubao-seedance-2-5-flash-261115',
      name: '豆包 Seedance 2.5 Flash',
      type: 'video',
      api: 'volcengine-ark-video',
      usdPerSecond: 0.152,
    },
    {
      id: 'doubao-seedance-2-0-260128',
      name: '豆包 Seedance 2.0',
      type: 'video',
      api: 'volcengine-ark-video',
      usdPerSecond: 0.142,
    },
    {
      id: 'doubao-seedance-2-0-fast-260128',
      name: '豆包 Seedance 2.0 Fast',
      type: 'video',
      api: 'volcengine-ark-video',
      usdPerSecond: 0.114,
    },
    {
      id: 'doubao-seedance-2-0-mini-260615',
      name: '豆包 Seedance 2.0 Mini',
      type: 'video',
      api: 'volcengine-ark-video',
      usdPerSecond: 0.071,
    },
  ],
  kling: [
    {
      id: 'kling-v4-0',
      name: '可灵 Kling 4.0',
      type: 'video',
      api: 'kling-video',
      usdPerSecond: 0.157,
    },
    {
      id: 'kling-v4-0-flash',
      name: '可灵 Kling 4.0 Flash',
      type: 'video',
      api: 'kling-video',
      usdPerSecond: 0.094,
    },
    {
      id: 'kling-3.0',
      name: '可灵 Kling 3.0',
      type: 'video',
      api: 'kling-video',
      usdPerSecond: 0.112,
    },
    {
      id: 'kling-3.0-omni',
      name: '可灵 Kling 3.0 Omni',
      type: 'video',
      api: 'kling-video',
      usdPerSecond: 0.112,
    },
    {
      id: 'kling-v2-6',
      name: '可灵 Kling 2.6',
      type: 'video',
      api: 'kling-video',
      usdPerSecond: 0.07,
    },
  ],
  minimax: [
    {
      id: 'MiniMax-H3',
      name: 'MiniMax H3',
      type: 'video',
      api: 'minimax-video',
      usdPerSecond: 0.08,
    },
    {
      id: 'MiniMax-H3-Max',
      name: 'MiniMax H3 Max',
      type: 'video',
      api: 'minimax-video',
      usdPerSecond: 0.08,
    },
    {
      id: 'MiniMax-H3-Highspeed',
      name: 'MiniMax H3 Highspeed',
      type: 'video',
      api: 'minimax-video',
      usdPerSecond: 0.05,
    },
    {
      id: 'MiniMax-Hailuo-2.3',
      name: '海螺 Hailuo 2.3',
      type: 'video',
      api: 'minimax-video',
      usdPerSecond: 0.08,
    },
    {
      id: 'MiniMax-Hailuo-2.3-Fast',
      name: '海螺 Hailuo 2.3 Fast',
      type: 'video',
      api: 'minimax-video',
      usdPerSecond: 0.04,
    },
  ],
  google: [
    {
      id: 'veo-3.1-generate-001',
      name: 'Google Veo 3.1',
      type: 'video',
      api: 'google-veo',
      usdPerSecond: 0.4,
    },
    {
      id: 'veo-3.1-fast-generate-001',
      name: 'Google Veo 3.1 Fast',
      type: 'video',
      api: 'google-veo',
      usdPerSecond: 0.15,
    },
    {
      id: 'veo-3.1-lite-generate-001',
      name: 'Google Veo 3.1 Lite',
      type: 'video',
      api: 'google-veo',
      usdPerSecond: 0.05,
    },
  ],
  'openai-video': [
    {
      id: 'sora-2',
      name: 'Sora 2',
      type: 'video',
      api: 'openai-videos',
      usdPerSecond: 0.1,
    },
    {
      id: 'sora-2-pro',
      name: 'Sora 2 Pro',
      type: 'video',
      api: 'openai-videos',
      usdPerSecond: 0.3,
    },
  ],
};
