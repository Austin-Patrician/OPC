import React, { useState } from 'react';
import { AlertTriangle, CheckCircle2, MinusCircle, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import { IMAGE_MODELS, IMAGE_PROVIDER_ID, LLM_PROVIDERS, findProvider } from './piCatalog';
import { getProviderStatus, settingsStore, useSettings, validateProxy } from './settingsStore';
import { SettingsPageId } from './settingsNav';
import { PageHeader, Section, buttonClass } from './settingsUi';

export type CheckState = 'pass' | 'warn' | 'fail' | 'skip';

type CheckGroup = '运行环境' | '配置一致性' | '连通性';

export interface CheckItem {
  id: string;
  group: CheckGroup;
  title: string;
  detail: string;
  state: CheckState;
  action?: { label: string; page: SettingsPageId };
}

type Snapshot = ReturnType<typeof settingsStore.getSnapshot>;

export interface SelfCheckRun {
  at: number;
  items: CheckItem[];
  /** Snapshot references at run time; immutable updates make staleness a reference check. */
  prefs: Snapshot['prefs'];
  credentials: Snapshot['credentials'];
}

const STATE_META: Record<CheckState, { label: string; icon: React.ElementType; color: string; bg: string }> = {
  pass: { label: '通过', icon: CheckCircle2, color: 'text-[#1E8E35]', bg: 'bg-[#E9F8EC]' },
  warn: { label: '警告', icon: AlertTriangle, color: 'text-[#B76E00]', bg: 'bg-[#FFF4E5]' },
  fail: { label: '失败', icon: XCircle, color: 'text-[#D93025]', bg: 'bg-[#FFEDED]' },
  skip: { label: '未检查', icon: MinusCircle, color: 'text-[#8E8E93]', bg: 'bg-[#F2F2F5]' },
};

const GROUP_ORDER: CheckGroup[] = ['运行环境', '配置一致性', '连通性'];

const isHttpUrl = (value: string) => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

const storageWritable = () => {
  try {
    const probe = 'opc.settings.selfcheck';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
};

/** Runs local, side-effect-free checks. Nothing here contacts a model provider. */
const runChecks = ({ prefs, credentials }: Snapshot): CheckItem[] => {
  const items: CheckItem[] = [];
  const add = (item: CheckItem) => items.push(item);

  // ---- Runtime environment -------------------------------------------------
  add(
    navigator.onLine
      ? { id: 'online', group: '运行环境', title: '网络状态', state: 'pass', detail: '浏览器报告已联网（不代表可访问各 Provider）。' }
      : { id: 'online', group: '运行环境', title: '网络状态', state: 'fail', detail: '浏览器当前处于离线状态。' }
  );
  add({
    id: 'secure',
    group: '运行环境',
    title: '安全上下文',
    ...(window.isSecureContext
      ? { state: 'pass', detail: '页面运行在 HTTPS 或 localhost 下。' }
      : { state: 'warn', detail: '非安全上下文，剪贴板、通知等浏览器能力会受限。' }),
  });
  add({
    id: 'storage',
    group: '运行环境',
    title: '本地存储',
    ...(storageWritable()
      ? { state: 'pass', detail: '偏好设置可保存到本机（凭据除外）。' }
      : { state: 'warn', detail: '无法写入 localStorage，设置仅在本次打开期间有效。' }),
  });
  add({
    id: 'websocket',
    group: '运行环境',
    title: 'WebSocket',
    ...(typeof WebSocket === 'function'
      ? { state: 'pass', detail: '浏览器支持 WebSocket 传输。' }
      : {
          state: 'warn',
          detail: '浏览器不支持 WebSocket，请将传输方式设为自动或 SSE。',
          action: { label: '网络设置', page: 'network' },
        }),
  });
  add({
    id: 'clipboard',
    group: '运行环境',
    title: '剪贴板',
    ...(typeof navigator.clipboard?.writeText === 'function'
      ? { state: 'pass', detail: '可一键复制命令、环境变量与模型 ID。' }
      : { state: 'warn', detail: '剪贴板 API 不可用，复制按钮将无法使用。' }),
  });

  const permission = 'Notification' in window ? Notification.permission : 'unsupported';
  if (!prefs.desktopNotify) {
    add({ id: 'notify', group: '运行环境', title: '桌面通知', state: 'skip', detail: '桌面通知已关闭。' });
  } else if (permission === 'granted') {
    add({ id: 'notify', group: '运行环境', title: '桌面通知', state: 'pass', detail: '浏览器已授权显示通知。' });
  } else {
    add({
      id: 'notify',
      group: '运行环境',
      title: '桌面通知',
      state: 'warn',
      detail:
        permission === 'denied'
          ? '通知权限已被浏览器拒绝，需要在浏览器的站点设置中重新允许。'
          : permission === 'default'
            ? '尚未授予通知权限，Agent 消息不会弹出提醒。'
            : '当前浏览器不支持桌面通知。',
      action: permission === 'default' ? { label: '去授权', page: 'notifications' } : undefined,
    });
  }

  const { timeZone } = Intl.DateTimeFormat().resolvedOptions();
  add({
    id: 'locale',
    group: '运行环境',
    title: '区域与时区',
    state: 'pass',
    detail: `${navigator.language} · ${timeZone}`,
  });

  // ---- Configuration consistency -------------------------------------------
  const defaultEntry = findProvider(prefs.defaultProvider);
  if (!prefs.defaultProvider) {
    add({ id: 'default-model', group: '配置一致性', title: '默认模型', state: 'pass', detail: '自动选择：pi 将根据已配置的凭据挑选模型。' });
  } else if (!defaultEntry || !defaultEntry.models.some((m) => m.id === prefs.defaultModel)) {
    add({
      id: 'default-model',
      group: '配置一致性',
      title: '默认模型',
      state: 'warn',
      detail: `${prefs.defaultProvider}/${prefs.defaultModel} 不在内置精选目录中，请确认模型 ID 是否正确。`,
      action: { label: '查看 LLM', page: 'llm' },
    });
  } else {
    const status = getProviderStatus(defaultEntry, prefs, credentials);
    add({
      id: 'default-model',
      group: '配置一致性',
      title: '默认模型',
      state: status.ready ? 'pass' : 'warn',
      detail: status.ready
        ? `${prefs.defaultProvider}/${prefs.defaultModel}`
        : `${prefs.defaultProvider}/${prefs.defaultModel} · 所属 Provider ${status.label}。`,
      action: status.ready ? undefined : { label: '去配置', page: 'llm' },
    });
  }

  const filled = Object.values(credentials).filter((v) => v.trim()).length;
  add({
    id: 'credentials',
    group: '配置一致性',
    title: 'API 凭据',
    state: filled ? 'pass' : 'warn',
    detail: filled
      ? `本次已填写 ${filled} 个 Provider 的密钥，仅保存在内存中。`
      : '本页面尚未填写任何密钥；也可通过环境变量或在 pi 中 /login 配置。',
    action: filled ? undefined : { label: '填写凭据', page: 'llm' },
  });

  const badBaseUrls = LLM_PROVIDERS.filter((p) => {
    const url = prefs.providers[p.id]?.baseUrl?.trim();
    return url && !isHttpUrl(url);
  });
  add({
    id: 'base-url',
    group: '配置一致性',
    title: 'Base URL',
    state: badBaseUrls.length ? 'fail' : 'pass',
    detail: badBaseUrls.length
      ? `${badBaseUrls.map((p) => p.name).join('、')} 的 Base URL 格式无效。`
      : '所有自定义 Base URL 格式有效。',
    action: badBaseUrls.length ? { label: '修改', page: 'llm' } : undefined,
  });

  const openrouter = findProvider(IMAGE_PROVIDER_ID);
  const imageModel = IMAGE_MODELS.find((m) => m.id === prefs.imageModel);
  const imageReady = openrouter ? getProviderStatus(openrouter, prefs, credentials).ready : false;
  add({
    id: 'image-model',
    group: '配置一致性',
    title: '默认图像模型',
    state: imageModel && imageReady ? 'pass' : 'warn',
    detail: !imageModel
      ? '尚未选择默认图像模型。'
      : imageReady
        ? `${IMAGE_PROVIDER_ID}/${imageModel.id}`
        : `${imageModel.name} 需要 OpenRouter 凭据，当前尚未配置。`,
    action: imageModel && imageReady ? undefined : { label: '图像设置', page: 'image' },
  });

  const proxyError = validateProxy(prefs.httpProxy);
  add({
    id: 'proxy',
    group: '配置一致性',
    title: 'HTTP 代理',
    state: proxyError ? 'fail' : 'pass',
    detail: proxyError
      ? `代理地址无效：${proxyError}。`
      : prefs.httpProxy.trim()
        ? `请求将经由 ${new URL(prefs.httpProxy.trim()).host} 转发。`
        : '未设置代理，直接连接。',
    action: proxyError ? { label: '修改', page: 'network' } : undefined,
  });

  add({
    id: 'retry',
    group: '配置一致性',
    title: '自动重试',
    state: prefs.retryEnabled ? 'pass' : 'warn',
    detail: prefs.retryEnabled
      ? `失败后最多重试 ${prefs.retryMaxRetries} 次，初始间隔 ${prefs.retryBaseDelayMs / 1000} 秒。`
      : '已关闭自动重试，网络波动或限流时请求会直接失败。',
    action: prefs.retryEnabled ? undefined : { label: '网络设置', page: 'network' },
  });

  // ---- Connectivity ---------------------------------------------------------
  add({
    id: 'provider-connectivity',
    group: '连通性',
    title: 'Provider 连通性',
    state: 'skip',
    detail: '为避免泄露凭据，本页面不会向任何 Provider 发起请求。请在 pi 中发起一次对话来验证。',
  });

  return items;
};

export const SelfCheckSettings: React.FC<{
  run: SelfCheckRun | null;
  onRunComplete: (run: SelfCheckRun) => void;
  onNavigate: (page: SettingsPageId) => void;
}> = ({ run, onRunComplete, onNavigate }) => {
  const snapshot = useSettings();
  const [running, setRunning] = useState(false);

  const start = () => {
    setRunning(true);
    // A short pause gives visible feedback; the checks themselves are synchronous.
    window.setTimeout(() => {
      const current = settingsStore.getSnapshot();
      onRunComplete({
        at: Date.now(),
        items: runChecks(current),
        prefs: current.prefs,
        credentials: current.credentials,
      });
      setRunning(false);
    }, 450);
  };

  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 } as Record<CheckState, number>;
  run?.items.forEach((item) => (counts[item.state] += 1));
  const stale = !!run && (run.prefs !== snapshot.prefs || run.credentials !== snapshot.credentials);
  const time = run
    ? new Date(run.at).toLocaleTimeString(snapshot.prefs.language, { hour12: snapshot.prefs.timeFormat === '12h' })
    : '';

  const summary = !run
    ? { title: '尚未运行自检', tone: 'skip' as CheckState }
    : counts.fail
      ? { title: `发现 ${counts.fail} 个问题需要处理`, tone: 'fail' as CheckState }
      : counts.warn
        ? { title: `${counts.warn} 项建议优化`, tone: 'warn' as CheckState }
        : { title: '本地检查全部通过', tone: 'pass' as CheckState };
  const SummaryIcon = run ? STATE_META[summary.tone].icon : ShieldCheck;

  return (
    <>
      <PageHeader
        crumbs={['自检']}
        title="自检"
        description="检查浏览器运行环境与设置是否一致。所有检查均在本地完成，不会读取 pi 的 auth.json，也不会向模型服务商发送请求。"
      />

      <div className="space-y-4">
        <section className="bg-white rounded-xl border border-[#E5E5E7] p-4 flex items-center gap-4">
          <div
            className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 ${STATE_META[summary.tone].bg} ${STATE_META[summary.tone].color}`}
          >
            <SummaryIcon className="w-6 h-6" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[15px] font-semibold text-[#1C1C1E]">{running ? '正在检查…' : summary.title}</div>
            <div className="mt-0.5 text-[12px] text-[#8E8E93]">
              {run ? (
                <>
                  上次检查 {time} · 共 {run.items.length} 项
                  {stale && <span className="text-[#B76E00]"> · 设置已变更，建议重新检查</span>}
                </>
              ) : (
                '约 1 秒完成，可随时重复运行。'
              )}
            </div>
          </div>
          <button type="button" className={buttonClass.primary} onClick={start} disabled={running}>
            <RefreshCw className={`w-3.5 h-3.5 ${running ? 'animate-spin' : ''}`} />
            {run ? '重新检查' : '开始自检'}
          </button>
        </section>

        <div className="grid grid-cols-4 gap-3">
          {(Object.keys(STATE_META) as CheckState[]).map((state) => {
            const meta = STATE_META[state];
            const Icon = meta.icon;
            return (
              <div key={state} className="bg-white rounded-xl border border-[#E5E5E7] px-3.5 py-3">
                <div className={`flex items-center gap-1.5 text-[12px] ${meta.color}`}>
                  <Icon className="w-3.5 h-3.5" />
                  {meta.label}
                </div>
                <div className="mt-1 text-[22px] leading-none font-semibold text-[#1C1C1E] tabular-nums">
                  {run ? counts[state] : '–'}
                </div>
              </div>
            );
          })}
        </div>

        {run &&
          GROUP_ORDER.map((group) => {
            const groupItems = run.items.filter((item) => item.group === group);
            return (
              <Section key={group} title={group}>
                {groupItems.map((item) => {
                  const meta = STATE_META[item.state];
                  const Icon = meta.icon;
                  return (
                    <div
                      key={item.id}
                      className="px-4 py-2.5 flex items-center gap-3 border-t border-[#F0F0F2] first:border-t-0"
                    >
                      <Icon className={`w-4 h-4 shrink-0 ${meta.color}`} />
                      <div className="w-[104px] shrink-0 text-[12.5px] font-medium text-[#1C1C1E]">{item.title}</div>
                      <div className="flex-1 min-w-0 text-[12px] text-[#6E6E73] leading-relaxed select-text break-words">
                        {item.detail}
                      </div>
                      {item.action && (
                        <button type="button" className={buttonClass.link} onClick={() => onNavigate(item.action!.page)}>
                          {item.action.label}
                        </button>
                      )}
                    </div>
                  );
                })}
              </Section>
            );
          })}
      </div>
    </>
  );
};
