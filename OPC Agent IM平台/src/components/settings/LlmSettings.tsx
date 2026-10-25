import React, { useMemo, useRef, useState } from 'react';
import { Brain, Eye, KeyRound, Lock, RotateCcw, Search, Star, Terminal } from 'lucide-react';
import {
  AUTH_MODE_LABEL,
  AuthMode,
  LLM_PROVIDERS,
  PI_AGENT_DIR,
  PI_CHAT_PROVIDER_TOTAL,
  PROVIDER_GROUPS,
  PiProvider,
  THINKING_LEVELS,
  findProvider,
  formatContext,
} from './piCatalog';
import {
  activeAuthMode,
  activeRegion,
  credentialEnv,
  defaultBaseUrl,
  effectiveProviderId,
  getProviderStatus,
  settingsStore,
  useSettings,
} from './settingsStore';
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
  SelectField,
  StatusBadge,
  TONE_CLASS,
  TextField,
  Toggle,
  buttonClass,
} from './settingsUi';

const MODEL_SEPARATOR = '::';

const isValidUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

/** Inline label used above stacked form controls in the provider detail pane. */
const FieldLabel: React.FC<{ children: React.ReactNode; extra?: React.ReactNode }> = ({
  children,
  extra,
}) => (
  <div className="mb-1.5 flex items-center justify-between gap-2">
    <span className="text-[12px] font-medium text-[#3A3A3C] flex items-center gap-1.5">{children}</span>
    {extra}
  </div>
);

const ProviderDetail: React.FC<{ provider: PiProvider }> = ({ provider }) => {
  const { prefs, credentials } = useSettings();
  const providerPrefs = prefs.providers[provider.id];
  const mode = activeAuthMode(provider, providerPrefs);
  const region = activeRegion(provider, providerPrefs);
  const piId = effectiveProviderId(provider, providerPrefs);
  const env = credentialEnv(provider, providerPrefs);
  const status = getProviderStatus(provider, prefs, credentials);
  const isDefaultProvider = prefs.defaultProvider === piId;
  const baseUrlOverride = providerPrefs?.baseUrl ?? '';
  const baseUrlInvalid = baseUrlOverride.trim() !== '' && !isValidUrl(baseUrlOverride.trim());
  const loginCommand = `/login ${piId}`;

  const changeRegion = (regionId: string) => {
    // Keep the default model pointing at the same provider after switching region.
    if (isDefaultProvider) settingsStore.set('defaultProvider', regionId);
    settingsStore.updateProvider(provider.id, { region: regionId });
  };

  return (
    <div className="flex-1 min-w-0 flex flex-col">
      <div className="px-5 py-4 border-b border-[#F0F0F2] flex items-start gap-3">
        <ProviderMark mark={provider.mark} color={provider.color} size="lg" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center flex-wrap gap-2">
            <h4 className="text-[15px] font-bold text-[#1C1C1E]">{provider.name}</h4>
            <StatusBadge tone={status.tone} label={status.label} />
            {isDefaultProvider && (
              <span className="inline-flex items-center gap-0.5 h-5 px-1.5 rounded-full bg-[#0099FF] text-white text-[10.5px] font-medium">
                <Star className="w-2.5 h-2.5" fill="currentColor" />
                默认
              </span>
            )}
          </div>
          <p className="mt-1 text-[12px] text-[#6E6E73] leading-relaxed">{provider.description}</p>
          <div className="mt-2 flex items-center flex-wrap gap-1.5">
            <KeyTag className="!bg-[#E8F3FF] !text-[#0066CC]">{piId}</KeyTag>
            {provider.apis.map((api) => (
              <KeyTag key={api}>{api}</KeyTag>
            ))}
            <span className="text-[11px] text-[#8E8E93] ml-0.5">内置 {provider.modelCount} 个模型</span>
          </div>
        </div>
      </div>

      <div className="px-5 py-4 space-y-5">
        {(provider.regions || provider.auth.length > 1) && (
          <div className="flex flex-wrap gap-x-8 gap-y-4">
            {provider.regions && region && (
              <div>
                <FieldLabel>接入区域</FieldLabel>
                <Segmented
                  label="接入区域"
                  value={region.id}
                  onChange={changeRegion}
                  options={provider.regions.map((r) => ({ value: r.id, label: r.label, title: r.id }))}
                />
              </div>
            )}
            {provider.auth.length > 1 && (
              <div>
                <FieldLabel>认证方式</FieldLabel>
                <Segmented<AuthMode>
                  label="认证方式"
                  value={mode}
                  onChange={(next) => settingsStore.updateProvider(provider.id, { authMode: next })}
                  options={provider.auth.map((a) => ({
                    value: a,
                    label: a === 'apiKey' && provider.keyLabel ? provider.keyLabel : AUTH_MODE_LABEL[a],
                  }))}
                />
              </div>
            )}
          </div>
        )}

        {mode === 'apiKey' && (
          <div>
            <FieldLabel extra={env && <KeyTag>{env}</KeyTag>}>
              <KeyRound className="w-3.5 h-3.5 text-[#8E8E93]" />
              {provider.keyLabel ?? 'API Key'}
            </FieldLabel>
            <SecretField
              label={`${provider.name} ${provider.keyLabel ?? 'API Key'}`}
              value={credentials[piId] ?? ''}
              onChange={(v) => settingsStore.setCredential(piId, v)}
              placeholder={`输入 ${provider.name} ${provider.keyLabel ?? 'API Key'}`}
            />
            <p className="mt-1.5 text-[11px] text-[#8E8E93] leading-relaxed flex items-start gap-1">
              <Lock className="w-3 h-3 mt-0.5 shrink-0" />
              <span>
                仅保存在当前窗口的内存中，不写入浏览器存储，刷新后需重新填写。也可在启动 pi 前设置环境变量
                {env ? ` ${env}` : ''}。
              </span>
            </p>
          </div>
        )}

        {mode === 'oauth' && (
          <div className="rounded-lg border border-[#E5E5E7] bg-[#FAFAFB] px-3.5 py-3">
            <div className="flex items-center gap-2 text-[12.5px] font-medium text-[#1C1C1E]">
              <Terminal className="w-3.5 h-3.5 text-[#6E6E73]" />
              使用 {provider.oauthLabel ?? provider.name} 账号登录
            </div>
            <p className="mt-1 text-[11.5px] text-[#6E6E73] leading-relaxed">
              在终端启动 pi，输入下方命令并在浏览器中完成授权。登录凭据由 pi 保存在{' '}
              <span className="font-mono">{PI_AGENT_DIR}/auth.json</span>，不会经过本页面。
            </p>
            <div className="mt-2.5 h-8 pl-3 pr-1 rounded-md bg-[#1C1C1E] flex items-center justify-between gap-2">
              <code className="font-mono text-[12px] text-[#E5E5EA] select-text">
                <span className="text-[#8E8E93]">› </span>
                {loginCommand}
              </code>
              <CopyButton text={loginCommand} className="!text-[#AEAEB2] hover:!text-white hover:!bg-white/10" />
            </div>
          </div>
        )}

        {mode === 'ambient' && provider.ambientEnv && (
          <div className="rounded-lg border border-[#E5E5E7] bg-[#FAFAFB] px-3.5 py-3">
            <div className="text-[12.5px] font-medium text-[#1C1C1E]">读取本机云凭据</div>
            <p className="mt-1 text-[11.5px] text-[#6E6E73] leading-relaxed">
              pi 启动时从运行环境自动解析凭据，本页面不会读取或保存任何云端密钥。可用来源：
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {provider.ambientEnv.map((v) => (
                <KeyTag key={v} className="!bg-white border border-[#E5E5E7]">
                  {v}
                </KeyTag>
              ))}
            </div>
          </div>
        )}

        {provider.fields && (
          <div className="grid grid-cols-2 gap-3">
            {provider.fields.map((field) => (
              <div key={field.env} className="min-w-0">
                <FieldLabel extra={<KeyTag>{field.env}</KeyTag>}>
                  {field.label}
                  {field.required && mode === 'ambient' && <span className="text-[#FF4D4F]">*</span>}
                </FieldLabel>
                <TextField
                  aria-label={field.label}
                  value={providerPrefs?.fields?.[field.env] ?? ''}
                  onChange={(e) =>
                    settingsStore.updateProvider(provider.id, { fields: { [field.env]: e.target.value } })
                  }
                  placeholder={field.placeholder}
                  spellCheck={false}
                  mono
                  className="w-full"
                />
              </div>
            ))}
          </div>
        )}

        <div>
          <FieldLabel
            extra={
              baseUrlOverride ? (
                <button
                  type="button"
                  className={buttonClass.link}
                  onClick={() => settingsStore.updateProvider(provider.id, { baseUrl: '' })}
                >
                  <RotateCcw className="w-3 h-3" />
                  恢复默认
                </button>
              ) : (
                <KeyTag>models.json</KeyTag>
              )
            }
          >
            Base URL
          </FieldLabel>
          <TextField
            aria-label="Base URL"
            value={baseUrlOverride}
            onChange={(e) => settingsStore.updateProvider(provider.id, { baseUrl: e.target.value })}
            placeholder={defaultBaseUrl(provider, providerPrefs) || '未设置时由资源名称推导'}
            spellCheck={false}
            invalid={baseUrlInvalid}
            mono
            className="w-full"
          />
          <p className={`mt-1.5 text-[11px] ${baseUrlInvalid ? 'text-[#D93025]' : 'text-[#8E8E93]'}`}>
            {baseUrlInvalid
              ? '请输入以 http:// 或 https:// 开头的完整地址。'
              : `留空使用内置地址；填写后写入 providers.${piId}.baseUrl，同时作用于该 Provider 的内置模型。`}
          </p>
        </div>

        <div>
          <FieldLabel
            extra={
              <span className="text-[11px] text-[#8E8E93]">
                精选 {provider.models.length} / {provider.modelCount}
              </span>
            }
          >
            常用模型
          </FieldLabel>
          <div className="rounded-lg border border-[#E5E5E7] divide-y divide-[#F0F0F2] overflow-hidden">
            {provider.models.map((model) => {
              const isDefault = isDefaultProvider && prefs.defaultModel === model.id;
              return (
                <div
                  key={model.id}
                  className={`group px-3 h-11 flex items-center gap-3 ${isDefault ? 'bg-[#F5FAFF]' : 'hover:bg-[#FAFAFB]'}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-[12.5px] font-medium text-[#1C1C1E] truncate">{model.name}</div>
                    <div className="text-[10.5px] font-mono text-[#8E8E93] truncate select-text">{model.id}</div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {model.reasoning && (
                      <span title="支持推理 / 思考" className="w-5 h-5 rounded flex items-center justify-center bg-[#F3EEFF] text-[#7A4CE0]">
                        <Brain className="w-3 h-3" />
                      </span>
                    )}
                    {model.vision && (
                      <span title="支持图片输入" className="w-5 h-5 rounded flex items-center justify-center bg-[#E9F8EC] text-[#1E8E35]">
                        <Eye className="w-3 h-3" />
                      </span>
                    )}
                  </div>
                  <span className="w-12 text-right text-[11px] font-mono text-[#6E6E73] shrink-0" title="上下文窗口">
                    {formatContext(model.context)}
                  </span>
                  <div className="w-[68px] flex justify-end shrink-0">
                    {isDefault ? (
                      <span className="text-[11px] font-medium text-[#0077CC]">当前默认</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => settingsStore.patch({ defaultProvider: piId, defaultModel: model.id })}
                        className="text-[11.5px] text-[#0077CC] hover:text-[#0099FF] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 cursor-pointer transition-opacity"
                      >
                        设为默认
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="mt-1.5 text-[11px] text-[#8E8E93]">
            完整目录可在 pi 中通过 /model 查看{provider.group === 'gateway' ? '；以 ~ 开头的 ID 为 Latest 别名。' : '。'}
          </p>
        </div>
      </div>
    </div>
  );
};

export const LlmSettings: React.FC<{ initialProviderId?: string }> = ({ initialProviderId }) => {
  const { prefs, credentials } = useSettings();
  const providersRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState(
    () => initialProviderId ?? findProvider(prefs.defaultProvider)?.id ?? LLM_PROVIDERS[0].id
  );

  const statuses = useMemo(
    () => new Map(LLM_PROVIDERS.map((p) => [p.id, getProviderStatus(p, prefs, credentials)])),
    [prefs, credentials]
  );
  const readyCount = Array.from(statuses.values()).filter((s) => s.ready).length;

  const q = query.trim().toLowerCase();
  const visible = LLM_PROVIDERS.filter(
    (p) =>
      !q ||
      p.name.toLowerCase().includes(q) ||
      p.id.includes(q) ||
      p.models.some((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
  );
  const selected = LLM_PROVIDERS.find((p) => p.id === selectedId) ?? LLM_PROVIDERS[0];

  const defaultEntry = findProvider(prefs.defaultProvider);
  const defaultStatus = defaultEntry ? statuses.get(defaultEntry.id) : undefined;
  const defaultValue = prefs.defaultProvider
    ? `${prefs.defaultProvider}${MODEL_SEPARATOR}${prefs.defaultModel}`
    : '';
  const defaultKnown =
    !prefs.defaultProvider ||
    !!defaultEntry?.models.some((m) => m.id === prefs.defaultModel);

  const focusProvider = (id: string) => {
    setSelectedId(id);
    setQuery('');
    providersRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <>
      <PageHeader
        crumbs={['模型', 'LLM']}
        title="LLM 对话模型"
        description={
          <>
            Provider 与模型目录取自 pi 内置目录（@earendil-works/pi-ai 1.4.0），默认模型与思考强度对应
            pi 的 settings.json。
          </>
        }
        actions={<StatusBadge tone={readyCount ? 'blue' : 'amber'} label={`${readyCount} 个 Provider 已就绪`} />}
      />

      <div className="space-y-4">
        <Section title="默认模型" description="新建 Agent 会话时使用的 Provider、模型与思考强度。">
          <Row
            label="默认模型"
            settingKey="defaultProvider · defaultModel"
            hint={
              prefs.defaultProvider ? (
                <span className="font-mono select-text">
                  {prefs.defaultProvider}/{prefs.defaultModel}
                </span>
              ) : (
                'pi 将根据已配置的凭据自动选择 Provider 与模型。'
              )
            }
          >
            <SelectField
              aria-label="默认模型"
              wrapperClassName="w-[280px]"
              value={defaultValue}
              onChange={(e) => {
                const [provider = '', model = ''] = e.target.value.split(MODEL_SEPARATOR);
                settingsStore.patch({ defaultProvider: provider, defaultModel: model });
              }}
            >
              <option value="">自动选择</option>
              {!defaultKnown && (
                <option value={defaultValue}>
                  {prefs.defaultProvider}/{prefs.defaultModel}
                </option>
              )}
              {LLM_PROVIDERS.map((p) => {
                const providerPrefs = prefs.providers[p.id];
                const piId = effectiveProviderId(p, providerPrefs);
                const ready = statuses.get(p.id)?.ready;
                return (
                  <optgroup key={p.id} label={ready ? p.name : `${p.name}（${statuses.get(p.id)?.label}）`}>
                    {p.models.map((model) => (
                      <option key={model.id} value={`${piId}${MODEL_SEPARATOR}${model.id}`}>
                        {model.name}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            </SelectField>
          </Row>
          {defaultEntry && defaultStatus && !defaultStatus.ready && (
            <div className="px-4 pb-3 -mt-1">
              <Note
                tone="warn"
                action={
                  <button type="button" className={buttonClass.link} onClick={() => focusProvider(defaultEntry.id)}>
                    去配置
                  </button>
                }
              >
                默认 Provider「{defaultEntry.name}」{defaultStatus.label}，pi 启动时将无法使用该模型。
              </Note>
            </div>
          )}
          <Row label="思考强度" settingKey="defaultThinkingLevel" hint="启动时使用的默认思考强度，仅对支持推理的模型生效。">
            <Segmented
              label="思考强度"
              value={prefs.defaultThinkingLevel}
              onChange={(v) => settingsStore.set('defaultThinkingLevel', v)}
              options={THINKING_LEVELS.map((t) => ({ value: t.value, label: t.label, title: t.value }))}
            />
          </Row>
          <Row label="隐藏思考过程" settingKey="hideThinkingBlock" hint="在对话记录中折叠模型的思考内容。">
            <Toggle
              label="隐藏思考过程"
              checked={prefs.hideThinkingBlock}
              onChange={(v) => settingsStore.set('hideThinkingBlock', v)}
            />
          </Row>
        </Section>

        <div ref={providersRef} className="scroll-mt-6">
          <Section
            title="模型服务商"
            description={`精选 ${LLM_PROVIDERS.length} 个常用 Provider，pi 共内置 ${PI_CHAT_PROVIDER_TOTAL} 个对话模型 Provider。连接状态需由 pi 运行时验证。`}
          >
            <div className="flex min-h-[560px]">
              <div className="w-[236px] shrink-0 border-r border-[#F0F0F2] bg-[#FAFAFB] flex flex-col">
                <div className="p-2.5">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#AEAEB2] pointer-events-none" />
                    <TextField
                      aria-label="搜索 Provider 或模型"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="搜索 Provider 或模型"
                      className="w-full pl-8 !bg-white"
                    />
                  </div>
                </div>
                <nav className="flex-1 overflow-y-auto px-2 pb-3 max-h-[640px]">
                  {PROVIDER_GROUPS.map((group) => {
                    const items = visible.filter((p) => p.group === group.id);
                    if (!items.length) return null;
                    return (
                      <div key={group.id} className="mb-2">
                        <div className="px-2 pt-1.5 pb-1 text-[11px] font-medium text-[#8E8E93]">{group.label}</div>
                        {items.map((p) => {
                          const status = statuses.get(p.id)!;
                          const active = p.id === selected.id;
                          return (
                            <button
                              key={p.id}
                              type="button"
                              onClick={() => setSelectedId(p.id)}
                              aria-current={active ? 'true' : undefined}
                              className={`w-full h-11 px-2 rounded-lg flex items-center gap-2.5 text-left cursor-pointer transition-colors ${
                                active ? 'bg-[#E4E4E8]' : 'hover:bg-black/[0.04]'
                              }`}
                            >
                              <ProviderMark mark={p.mark} color={p.color} />
                              <span className="flex-1 min-w-0">
                                <span className="block text-[12.5px] font-medium text-[#1C1C1E] truncate">{p.name}</span>
                                <span className="block text-[10.5px] font-mono text-[#8E8E93] truncate">
                                  {effectiveProviderId(p, prefs.providers[p.id])}
                                </span>
                              </span>
                              <span
                                title={status.label}
                                className={`w-2 h-2 rounded-full shrink-0 ${TONE_CLASS[status.tone].dot}`}
                              />
                            </button>
                          );
                        })}
                      </div>
                    );
                  })}
                  {!visible.length && (
                    <div className="px-3 py-10 text-center text-[12px] text-[#8E8E93]">没有匹配的 Provider</div>
                  )}
                </nav>
              </div>
              <ProviderDetail key={selected.id} provider={selected} />
            </div>
          </Section>
        </div>
      </div>
    </>
  );
};
