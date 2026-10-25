import React, { useMemo, useState } from 'react';
import { ArrowUpRight, Check, ImagePlus, Search, Type } from 'lucide-react';
import {
  AUTH_MODE_LABEL,
  AuthMode,
  IMAGE_API,
  IMAGE_BASE_URL,
  IMAGE_MODELS,
  IMAGE_PROVIDER_ID,
  IMAGE_VENDOR_LIST,
  PI_AGENT_DIR,
  findProvider,
} from './piCatalog';
import { activeAuthMode, getProviderStatus, settingsStore, useSettings } from './settingsStore';
import {
  CopyButton,
  KeyTag,
  Note,
  PageHeader,
  ProviderMark,
  Row,
  Section,
  Segmented,
  SecretField,
  StatusBadge,
  TextField,
  Toggle,
  buttonClass,
} from './settingsUi';

const VENDOR_STYLE: Record<string, { mark: string; color: string }> = {
  'Black Forest Labs': { mark: 'BFL', color: '#1C1C1E' },
  'ByteDance Seed': { mark: 'BD', color: '#3370FF' },
  Google: { mark: 'G', color: '#4285F4' },
  Krea: { mark: 'K', color: '#3F3F46' },
  Meta: { mark: 'M', color: '#0866FF' },
  'Microsoft AI': { mark: 'MS', color: '#00A4EF' },
  OpenAI: { mark: 'O', color: '#10A37F' },
  OpenRouter: { mark: 'OR', color: '#6467F2' },
  Qwen: { mark: 'Q', color: '#615CED' },
  Recraft: { mark: 'R', color: '#E5484D' },
  Sourceful: { mark: 'S', color: '#0F766E' },
  Tencent: { mark: 'T', color: '#0052D9' },
  xAI: { mark: 'x', color: '#3A3A3C' },
};

const vendorStyle = (vendor: string) =>
  VENDOR_STYLE[vendor] ?? { mark: vendor.slice(0, 1).toUpperCase(), color: '#8E8E93' };

export const ImageSettings: React.FC<{ onOpenLlmProvider: (providerId: string) => void }> = ({
  onOpenLlmProvider,
}) => {
  const { prefs, credentials } = useSettings();
  const [query, setQuery] = useState('');
  const [vendor, setVendor] = useState<string>('all');

  const openrouter = findProvider(IMAGE_PROVIDER_ID)!;
  const status = getProviderStatus(openrouter, prefs, credentials);
  const mode = activeAuthMode(openrouter, prefs.providers[openrouter.id]);
  const selected = IMAGE_MODELS.find((im) => im.id === prefs.imageModel);
  const modelRef = selected ? `${IMAGE_PROVIDER_ID}/${selected.id}` : '';

  const vendorCounts = useMemo(() => {
    const counts = new Map<string, number>();
    IMAGE_MODELS.forEach((im) => counts.set(im.vendor, (counts.get(im.vendor) ?? 0) + 1));
    return counts;
  }, []);

  const q = query.trim().toLowerCase();
  const visible = IMAGE_MODELS.filter(
    (im) =>
      (vendor === 'all' || im.vendor === vendor) &&
      (!q ||
        im.id.toLowerCase().includes(q) ||
        im.name.toLowerCase().includes(q) ||
        im.vendor.toLowerCase().includes(q))
  );

  const chipClass = (active: boolean) =>
    `h-6 px-2 rounded-full text-[11.5px] whitespace-nowrap inline-flex items-center gap-1 cursor-pointer transition-colors ${
      active
        ? 'bg-[#1C1C1E] text-white'
        : 'bg-[#F2F2F5] text-[#3A3A3C] hover:bg-[#E8E8ED]'
    }`;

  return (
    <>
      <PageHeader
        crumbs={['模型', 'Image']}
        title="Image 图像模型"
        description={
          <>
            pi 的图像生成统一走 <span className="font-mono text-[12px]">{IMAGE_API}</span> 接口，内置{' '}
            {IMAGE_MODELS.length} 个图像模型，目前全部由 OpenRouter 提供。
          </>
        }
      />

      <div className="space-y-4">
        <Section
          title="图像 Provider"
          description="与 LLM · OpenRouter 共用同一份凭据与认证方式。"
          action={
            <button type="button" className={buttonClass.link} onClick={() => onOpenLlmProvider(openrouter.id)}>
              在 LLM 中查看
              <ArrowUpRight className="w-3 h-3" />
            </button>
          }
        >
          <div className="px-4 py-4 flex items-start gap-3">
            <ProviderMark mark={openrouter.mark} color={openrouter.color} size="md" />
            <div className="flex-1 min-w-0 space-y-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[13.5px] font-semibold text-[#1C1C1E]">OpenRouter</span>
                  <StatusBadge tone={status.tone} label={status.label} />
                </div>
                <div className="mt-1.5 flex items-center flex-wrap gap-1.5">
                  <KeyTag className="!bg-[#E8F3FF] !text-[#0066CC]">{IMAGE_PROVIDER_ID}</KeyTag>
                  <KeyTag>{IMAGE_API}</KeyTag>
                  <span className="text-[11px] font-mono text-[#8E8E93] select-text">{IMAGE_BASE_URL}</span>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Segmented<AuthMode>
                  label="认证方式"
                  value={mode}
                  onChange={(next) => settingsStore.updateProvider(openrouter.id, { authMode: next })}
                  options={openrouter.auth.map((a) => ({ value: a, label: AUTH_MODE_LABEL[a] }))}
                />
                {mode === 'apiKey' ? (
                  <SecretField
                    label="OpenRouter API Key"
                    value={credentials[openrouter.id] ?? ''}
                    onChange={(v) => settingsStore.setCredential(openrouter.id, v)}
                    placeholder="输入 OpenRouter API Key"
                    className="flex-1 min-w-0"
                  />
                ) : (
                  <div className="flex-1 min-w-0 h-[30px] pl-3 pr-1 rounded-md bg-[#1C1C1E] flex items-center justify-between">
                    <code className="font-mono text-[12px] text-[#E5E5EA] select-text">
                      <span className="text-[#8E8E93]">› </span>/login openrouter
                    </code>
                    <CopyButton
                      text="/login openrouter"
                      className="!text-[#AEAEB2] hover:!text-white hover:!bg-white/10"
                    />
                  </div>
                )}
              </div>
              <p className="text-[11px] text-[#8E8E93]">
                {mode === 'apiKey'
                  ? '密钥仅保存在当前窗口的内存中；也可在启动 pi 前设置环境变量 OPENROUTER_API_KEY。'
                  : `在 pi 终端中完成登录，凭据保存在 ${PI_AGENT_DIR}/auth.json。`}
              </p>
            </div>
          </div>
        </Section>

        <Section
          title="默认图像模型"
          description="Agent 生成图像时默认调用的模型。"
          action={
            selected ? (
              <span className="flex items-center gap-1">
                <KeyTag className="!bg-[#E8F3FF] !text-[#0066CC]">{modelRef}</KeyTag>
                <CopyButton text={modelRef} />
              </span>
            ) : (
              <StatusBadge tone="amber" label="未选择" />
            )
          }
        >
          <div className="px-4 pt-3 pb-2.5 flex items-center gap-3 border-b border-[#F0F0F2]">
            <div className="relative w-[220px] shrink-0">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#AEAEB2] pointer-events-none" />
              <TextField
                aria-label="搜索图像模型"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索模型名称或 ID"
                className="w-full pl-8"
              />
            </div>
            <div className="flex-1 min-w-0 flex gap-1.5 overflow-x-auto py-0.5">
              <button type="button" className={chipClass(vendor === 'all')} onClick={() => setVendor('all')}>
                全部
                <span className="opacity-60 font-mono">{IMAGE_MODELS.length}</span>
              </button>
              {IMAGE_VENDOR_LIST.map((v) => (
                <button key={v} type="button" className={chipClass(vendor === v)} onClick={() => setVendor(v)}>
                  {v}
                  <span className="opacity-60 font-mono">{vendorCounts.get(v)}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="p-3 max-h-[436px] overflow-y-auto">
            {visible.length ? (
              <div className="grid grid-cols-2 xl:grid-cols-3 gap-2">
                {visible.map((im) => {
                  const active = im.id === prefs.imageModel;
                  const style = vendorStyle(im.vendor);
                  return (
                    <button
                      key={im.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => settingsStore.set('imageModel', active ? '' : im.id)}
                      title={active ? '再次点击取消选择' : im.id}
                      className={`relative text-left rounded-lg border px-2.5 py-2 flex items-start gap-2.5 cursor-pointer transition-colors ${
                        active
                          ? 'border-[#0099FF] bg-[#F5FAFF] ring-1 ring-[#0099FF]'
                          : 'border-[#E5E5E7] hover:border-[#C7C7CC] hover:bg-[#FAFAFB]'
                      }`}
                    >
                      <ProviderMark mark={style.mark} color={style.color} />
                      <span className="flex-1 min-w-0 pr-4">
                        <span className="block text-[12.5px] font-medium text-[#1C1C1E] truncate">{im.name}</span>
                        <span className="block text-[10.5px] font-mono text-[#8E8E93] truncate">{im.id}</span>
                        <span className="mt-1.5 flex items-center gap-1">
                          <span className="inline-flex items-center gap-0.5 h-[18px] px-1.5 rounded bg-[#F2F2F5] text-[10.5px] text-[#6E6E73]">
                            <Type className="w-2.5 h-2.5" />
                            文生图
                          </span>
                          {im.imageInput && (
                            <span className="inline-flex items-center gap-0.5 h-[18px] px-1.5 rounded bg-[#E9F8EC] text-[10.5px] text-[#1E8E35]">
                              <ImagePlus className="w-2.5 h-2.5" />
                              图生图
                            </span>
                          )}
                        </span>
                      </span>
                      {active && (
                        <span className="absolute top-2 right-2 w-4 h-4 rounded-full bg-[#0099FF] text-white flex items-center justify-center">
                          <Check className="w-2.5 h-2.5" strokeWidth={3} />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="py-12 text-center text-[12px] text-[#8E8E93]">没有匹配的图像模型</div>
            )}
          </div>
          {!selected && (
            <div className="px-4 pb-3">
              <Note>尚未选择默认图像模型。选择后会在右上角显示可直接引用的模型 ID。</Note>
            </div>
          )}
        </Section>

        <Section title="图像输入" description="控制聊天中的截图、附件等图片如何发送给对话模型。">
          <Row label="自动缩放图片" settingKey="images.autoResize" hint="发送前将图片缩放至 2000 × 2000 像素以内。">
            <Toggle
              label="自动缩放图片"
              checked={prefs.imagesAutoResize}
              onChange={(v) => settingsStore.set('imagesAutoResize', v)}
            />
          </Row>
          <Row label="禁止发送图片" settingKey="images.blockImages" hint="开启后不会向任何模型发送图片。">
            <Toggle
              label="禁止发送图片"
              checked={prefs.imagesBlockImages}
              onChange={(v) => settingsStore.set('imagesBlockImages', v)}
            />
          </Row>
        </Section>
      </div>
    </>
  );
};
