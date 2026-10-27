import React, { useState } from 'react';
import { Brain, ChevronDown, Eye, Lock, Terminal } from 'lucide-react';
import {
  AUTH_MODE_LABEL,
  AuthMode,
  LLM_PROVIDERS,
  PI_AGENT_DIR,
  PiProvider,
  THINKING_LEVELS,
  findProvider,
  formatContext,
} from '../settings/piCatalog';
import {
  activeAuthMode,
  credentialEnv,
  effectiveProviderId,
  getProviderStatus,
  settingsStore,
  useSettings,
} from '../settings/settingsStore';
import { CopyButton, ProviderMark, SecretField, Segmented, StatusBadge } from '../settings/settingsUi';
import { Block, ChoiceCard, StepHeader } from './onboardingShared';

const FEATURED = ['anthropic', 'openai', 'google', 'deepseek', 'openrouter', 'moonshotai', 'zai', 'openai-codex'];

const authSummary = (p: PiProvider) =>
  p.auth.map((a) => (a === 'apiKey' ? (p.keyLabel ?? 'API Key') : AUTH_MODE_LABEL[a])).join(' / ');

export const StepModel: React.FC = () => {
  const { prefs, credentials } = useSettings();
  const [showAll, setShowAll] = useState(false);
  const [selectedId, setSelectedId] = useState(() => findProvider(prefs.defaultProvider)?.id ?? 'anthropic');

  const provider = LLM_PROVIDERS.find((p) => p.id === selectedId) ?? LLM_PROVIDERS[0];
  const providerPrefs = prefs.providers[provider.id];
  const mode = activeAuthMode(provider, providerPrefs);
  const piId = effectiveProviderId(provider, providerPrefs);
  const env = credentialEnv(provider, providerPrefs);
  const status = getProviderStatus(provider, prefs, credentials);
  const visible = showAll
    ? LLM_PROVIDERS
    : LLM_PROVIDERS.filter((p) => FEATURED.includes(p.id) || p.id === provider.id);

  const defaultEntry = findProvider(prefs.defaultProvider);
  const defaultModel = defaultEntry?.models.find((m) => m.id === prefs.defaultModel);

  return (
    <>
      <StepHeader
        eyebrow="模型引擎"
        title="为团队接入 AI 大脑"
        description="选择模型服务商并设定默认模型，Agent 员工将通过 pi 引擎调用它。暂时没有密钥也没关系，跳过后 pi 会按可用凭据自动选择。"
        aside={
          <div className="text-right">
            <div className="text-[11px] text-[#8E8E93]">当前默认</div>
            <div className="mt-1 text-[13px] font-semibold text-[#1C1C1E]">
              {defaultModel ? defaultModel.name : '自动选择'}
            </div>
          </div>
        }
      />

      <div className="space-y-6">
        <Block
          title="选择服务商"
          hint={
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="inline-flex items-center gap-0.5 text-[12px] text-[#0077CC] hover:text-[#0099FF] cursor-pointer"
            >
              {showAll ? '收起' : `查看全部 ${LLM_PROVIDERS.length} 家`}
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showAll ? 'rotate-180' : ''}`} />
            </button>
          }
        >
          <div className="grid grid-cols-4 gap-2.5">
            {visible.map((p) => (
              <ChoiceCard key={p.id} selected={p.id === provider.id} onClick={() => setSelectedId(p.id)} className="p-3" label={p.name}>
                <div className="flex items-center gap-2.5 pr-4">
                  <ProviderMark mark={p.mark} color={p.color} />
                  <div className="min-w-0">
                    <div className="text-[12.5px] font-semibold text-[#1C1C1E] truncate">{p.name}</div>
                    <div className="text-[10.5px] text-[#8E8E93] truncate">{authSummary(p)}</div>
                  </div>
                </div>
              </ChoiceCard>
            ))}
          </div>
        </Block>

        <div key={provider.id} className="rounded-2xl border border-[#E5E5E7] bg-[#FAFAFB] p-5 onb-slide-next">
          <div className="flex items-start gap-3">
            <ProviderMark mark={provider.mark} color={provider.color} size="md" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[14.5px] font-semibold text-[#1C1C1E]">{provider.name}</span>
                <StatusBadge tone={status.tone} label={status.label} />
              </div>
              <p className="mt-0.5 text-[12px] text-[#6E6E73] leading-relaxed">{provider.description}</p>
            </div>
            {provider.auth.length > 1 && (
              <Segmented<AuthMode>
                label="认证方式"
                value={mode}
                onChange={(next) => settingsStore.updateProvider(provider.id, { authMode: next })}
                options={provider.auth.map((a) => ({
                  value: a,
                  label: a === 'apiKey' && provider.keyLabel ? provider.keyLabel : AUTH_MODE_LABEL[a],
                }))}
              />
            )}
          </div>

          <div className="mt-4">
            {mode === 'apiKey' && (
              <>
                <SecretField
                  label={`${provider.name} ${provider.keyLabel ?? 'API Key'}`}
                  value={credentials[piId] ?? ''}
                  onChange={(v) => settingsStore.setCredential(piId, v)}
                  placeholder={`粘贴 ${provider.name} ${provider.keyLabel ?? 'API Key'}`}
                />
                <p className="mt-1.5 text-[11px] text-[#8E8E93] flex items-center gap-1">
                  <Lock className="w-3 h-3 shrink-0" />
                  仅保存在当前窗口内存中，刷新后需重新填写；也可在启动 pi 前设置 {env}。
                </p>
              </>
            )}
            {mode === 'oauth' && (
              <div className="rounded-xl bg-[#0E1016] px-3.5 py-3">
                <div className="flex items-center justify-between gap-2">
                  <code className="font-mono text-[12.5px] text-[#E5E5EA] select-text flex items-center gap-2">
                    <Terminal className="w-3.5 h-3.5 text-[#8E8E93]" />
                    /login {piId}
                  </code>
                  <CopyButton text={`/login ${piId}`} className="!text-[#AEAEB2] hover:!text-white hover:!bg-white/10" />
                </div>
                <p className="mt-1.5 text-[11px] text-[#8E8E93]">
                  在终端启动 pi 后输入此命令，使用 {provider.oauthLabel ?? provider.name} 账号授权；凭据保存在{' '}
                  {PI_AGENT_DIR}/auth.json。
                </p>
              </div>
            )}
            {mode === 'ambient' && (
              <div className="rounded-xl border border-[#E5E5E7] bg-white px-3.5 py-3 text-[12px] text-[#6E6E73] leading-relaxed">
                pi 会从运行环境读取云凭据（{provider.ambientEnv?.slice(0, 3).join('、')} 等）。区域、项目等参数可稍后在「设置 › 模型 › LLM」中填写。
              </div>
            )}
          </div>

          <div className="mt-5">
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-[12.5px] font-semibold text-[#1C1C1E]">默认模型</span>
              <span className="text-[11px] text-[#8E8E93]">
                精选 {provider.models.length} / 内置 {provider.modelCount} 个
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {provider.models.map((model) => {
                const selected = prefs.defaultProvider === piId && prefs.defaultModel === model.id;
                return (
                  <ChoiceCard
                    key={model.id}
                    selected={selected}
                    onClick={() =>
                      settingsStore.patch(
                        selected ? { defaultProvider: '', defaultModel: '' } : { defaultProvider: piId, defaultModel: model.id }
                      )
                    }
                    className="px-3 py-2.5"
                  >
                    <div className="pr-6 text-[12.5px] font-medium text-[#1C1C1E] truncate">{model.name}</div>
                    <div className="mt-0.5 flex items-center gap-2">
                      <span className="flex-1 min-w-0 font-mono text-[10.5px] text-[#8E8E93] truncate">{model.id}</span>
                      {model.reasoning && <Brain className="w-3 h-3 text-[#7A4CE0] shrink-0" aria-label="支持推理" />}
                      {model.vision && <Eye className="w-3 h-3 text-[#1E8E35] shrink-0" aria-label="支持图片输入" />}
                      <span className="font-mono text-[10.5px] text-[#6E6E73] shrink-0">{formatContext(model.context)}</span>
                    </div>
                  </ChoiceCard>
                );
              })}
            </div>
          </div>

          <div className="mt-5 flex items-center justify-between gap-4">
            <div>
              <div className="text-[12.5px] font-semibold text-[#1C1C1E]">思考强度</div>
              <div className="mt-0.5 text-[11px] text-[#8E8E93]">仅对支持推理的模型生效</div>
            </div>
            <Segmented
              label="思考强度"
              value={prefs.defaultThinkingLevel}
              onChange={(v) => settingsStore.set('defaultThinkingLevel', v)}
              options={THINKING_LEVELS.map((t) => ({ value: t.value, label: t.label, title: t.value }))}
            />
          </div>
        </div>
      </div>
    </>
  );
};
