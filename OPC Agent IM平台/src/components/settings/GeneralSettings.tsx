import React, { useEffect, useState } from 'react';
import { BellRing, Check } from 'lucide-react';
import { SettingsPrefs, settingsStore, useSettings, validateProxy } from './settingsStore';
import {
  NumberField,
  PageHeader,
  Row,
  Section,
  Segmented,
  SelectField,
  StatusBadge,
  TextField,
  Toggle,
  buttonClass,
} from './settingsUi';

const set = settingsStore.set;

// ---------------------------------------------------------------------------
// 外观与语言
// ---------------------------------------------------------------------------

const THEMES: { value: SettingsPrefs['theme']; label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];

const ThemePreview: React.FC<{ mode: SettingsPrefs['theme'] }> = ({ mode }) => {
  const pane = (dark: boolean) => (
    <div className={`flex-1 flex ${dark ? 'bg-[#2C2C2E]' : 'bg-white'}`}>
      <div className={`w-[22%] border-r ${dark ? 'bg-[#1C1C1E] border-[#3A3A3C]' : 'bg-[#F2F2F3] border-[#E5E5E7]'}`} />
      <div className="flex-1 p-1.5 space-y-1">
        <div className={`h-1.5 w-3/4 rounded-full ${dark ? 'bg-[#48484A]' : 'bg-[#E5E5EA]'}`} />
        <div className={`h-1.5 w-1/2 rounded-full ${dark ? 'bg-[#3A3A3C]' : 'bg-[#EFEFF1]'}`} />
        <div className="h-1.5 w-2/5 rounded-full bg-[#0099FF]/70 ml-auto" />
      </div>
    </div>
  );
  return (
    <div className="h-[58px] rounded-lg overflow-hidden border border-black/[0.08] flex">
      {mode === 'system' ? (
        <>
          {pane(false)}
          {pane(true)}
        </>
      ) : (
        pane(mode === 'dark')
      )}
    </div>
  );
};

export const AppearanceSettings: React.FC = () => {
  const { prefs } = useSettings();
  return (
    <>
      <PageHeader
        crumbs={['通用', '外观与语言']}
        title="外观与语言"
        description="调整 OPC 客户端的显示方式与语言偏好，所有选项自动保存在本机。"
      />
      <div className="space-y-4">
        <Section title="外观" description="当前版本界面以浅色呈现，深色主题正在适配中。">
          <div className="px-4 py-4 flex gap-3">
            {THEMES.map((t) => {
              const active = prefs.theme === t.value;
              return (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => set('theme', t.value)}
                  aria-pressed={active}
                  className="w-[132px] text-left cursor-pointer group"
                >
                  <div
                    className={`rounded-[10px] p-1 transition-shadow ${
                      active
                        ? 'ring-2 ring-[#0099FF]'
                        : 'ring-1 ring-transparent group-hover:ring-[#D1D1D6]'
                    }`}
                  >
                    <ThemePreview mode={t.value} />
                  </div>
                  <div className="mt-1.5 flex items-center gap-1.5 text-[12px]">
                    <span
                      className={`w-3.5 h-3.5 rounded-full flex items-center justify-center ${
                        active ? 'bg-[#0099FF] text-white' : 'border border-[#C7C7CC]'
                      }`}
                    >
                      {active && <Check className="w-2.5 h-2.5" strokeWidth={3} />}
                    </span>
                    <span className={active ? 'text-[#1C1C1E] font-medium' : 'text-[#3A3A3C]'}>
                      {t.label}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
          <Row label="界面字号" hint="影响会话列表与聊天消息的文字大小。">
            <Segmented
              label="界面字号"
              value={prefs.textSize}
              onChange={(v) => set('textSize', v)}
              options={[
                { value: 'small', label: '小' },
                { value: 'standard', label: '标准' },
                { value: 'large', label: '大' },
              ]}
            />
          </Row>
        </Section>

        <Section title="语言与地区">
          <Row label="界面语言">
            <SelectField
              aria-label="界面语言"
              value={prefs.language}
              onChange={(e) => set('language', e.target.value as SettingsPrefs['language'])}
            >
              <option value="zh-CN">简体中文</option>
              <option value="zh-TW">繁體中文</option>
              <option value="en-US">English</option>
            </SelectField>
          </Row>
          <Row
            label="时间格式"
            hint={prefs.timeFormat === '24h' ? '示例：14:30' : '示例：下午 2:30'}
          >
            <Segmented
              label="时间格式"
              value={prefs.timeFormat}
              onChange={(v) => set('timeFormat', v)}
              options={[
                { value: '24h', label: '24 小时制' },
                { value: '12h', label: '12 小时制' },
              ]}
            />
          </Row>
        </Section>
      </div>
    </>
  );
};

// ---------------------------------------------------------------------------
// 通知
// ---------------------------------------------------------------------------

type PermissionState = NotificationPermission | 'unsupported';

const readPermission = (): PermissionState =>
  typeof window !== 'undefined' && 'Notification' in window
    ? Notification.permission
    : 'unsupported';

const PERMISSION_META: Record<PermissionState, { tone: 'green' | 'gray' | 'red'; label: string }> = {
  granted: { tone: 'green', label: '已允许' },
  default: { tone: 'gray', label: '尚未授权' },
  denied: { tone: 'red', label: '已拒绝' },
  unsupported: { tone: 'gray', label: '当前环境不支持' },
};

export const NotificationSettings: React.FC = () => {
  const { prefs } = useSettings();
  const [permission, setPermission] = useState<PermissionState>(readPermission);

  useEffect(() => {
    const sync = () => setPermission(readPermission());
    window.addEventListener('focus', sync);
    return () => window.removeEventListener('focus', sync);
  }, []);

  const requestPermission = async () => {
    try {
      setPermission(await Notification.requestPermission());
    } catch {
      setPermission(readPermission());
    }
  };

  const meta = PERMISSION_META[permission];

  return (
    <>
      <PageHeader
        crumbs={['通用', '通知']}
        title="通知"
        description="控制 Agent 私聊、部门群组与任务流转的提醒方式。"
      />
      <div className="space-y-4">
        <Section title="消息通知">
          <Row
            label="系统通知权限"
            hint={
              permission === 'denied'
                ? '浏览器已拒绝通知，请在浏览器的站点设置中重新允许。'
                : '桌面通知需要浏览器授予通知权限。'
            }
          >
            <StatusBadge tone={meta.tone} label={meta.label} />
            {permission === 'default' && (
              <button type="button" onClick={requestPermission} className={buttonClass.secondary}>
                <BellRing className="w-3.5 h-3.5" />
                请求权限
              </button>
            )}
          </Row>
          <Row label="桌面通知" hint="新消息到达且窗口不在前台时弹出系统通知。">
            <Toggle label="桌面通知" checked={prefs.desktopNotify} onChange={(v) => set('desktopNotify', v)} />
          </Row>
          <Row
            label="通知中显示消息内容"
            hint="关闭后通知仅显示发送者名称。"
            disabled={!prefs.desktopNotify}
          >
            <Toggle
              label="通知中显示消息内容"
              checked={prefs.notifyPreview}
              onChange={(v) => set('notifyPreview', v)}
            />
          </Row>
          <Row label="提示音">
            <Toggle label="提示音" checked={prefs.notifySound} onChange={(v) => set('notifySound', v)} />
          </Row>
          <Row label="群聊仅在 @我 时提醒" hint="部门群组中其他消息只累计未读数，不打扰。">
            <Toggle
              label="群聊仅在 @我 时提醒"
              checked={prefs.notifyMentionOnly}
              onChange={(v) => set('notifyMentionOnly', v)}
            />
          </Row>
          <Row label="Agent 任务完成提醒" hint="任务流转结束或交付物归档时提醒。">
            <Toggle
              label="Agent 任务完成提醒"
              checked={prefs.notifyTaskDone}
              onChange={(v) => set('notifyTaskDone', v)}
            />
          </Row>
        </Section>

        <Section title="免打扰" description="时段内静音全部通知，Agent 仍会继续执行任务。">
          <Row label="定时免打扰">
            <Toggle label="定时免打扰" checked={prefs.dndEnabled} onChange={(v) => set('dndEnabled', v)} />
          </Row>
          <Row
            label="免打扰时段"
            hint={prefs.dndStart > prefs.dndEnd ? '跨越午夜，至次日结束。' : undefined}
            disabled={!prefs.dndEnabled}
          >
            <TextField
              type="time"
              aria-label="开始时间"
              value={prefs.dndStart}
              onChange={(e) => e.target.value && set('dndStart', e.target.value)}
              mono
              className="w-[92px]"
            />
            <span className="text-[12px] text-[#8E8E93]">至</span>
            <TextField
              type="time"
              aria-label="结束时间"
              value={prefs.dndEnd}
              onChange={(e) => e.target.value && set('dndEnd', e.target.value)}
              mono
              className="w-[92px]"
            />
          </Row>
        </Section>
      </div>
    </>
  );
};

// ---------------------------------------------------------------------------
// 工作区与会话
// ---------------------------------------------------------------------------

const DELIVERY_OPTIONS = [
  { value: 'one-at-a-time', label: '逐条投递' },
  { value: 'all', label: '一次全部' },
] as const;

export const WorkspaceSettings: React.FC = () => {
  const { prefs } = useSettings();
  return (
    <>
      <PageHeader
        crumbs={['通用', '工作区与会话']}
        title="工作区与会话"
        description={
          <>
            带有键名标记的选项对应 pi 的 <span className="font-mono text-[12px]">settings.json</span>
            ，未修改时沿用 pi 默认值。
          </>
        }
      />
      <div className="space-y-4">
        <Section title="消息发送">
          <Row
            label="发送快捷键"
            hint={prefs.sendShortcut === 'enter' ? 'Shift + Enter 换行' : 'Enter 换行'}
          >
            <Segmented
              label="发送快捷键"
              value={prefs.sendShortcut}
              onChange={(v) => set('sendShortcut', v)}
              options={[
                { value: 'enter', label: 'Enter 发送' },
                { value: 'mod-enter', label: '⌘ Enter 发送' },
              ]}
            />
          </Row>
        </Section>

        <Section title="Agent 协作">
          <Row label="引导消息投递" settingKey="steeringMode" hint="Agent 运行中排队的引导消息如何送达。">
            <Segmented
              label="引导消息投递"
              value={prefs.steeringMode}
              onChange={(v) => set('steeringMode', v)}
              options={DELIVERY_OPTIONS}
            />
          </Row>
          <Row label="后续消息投递" settingKey="followUpMode" hint="排队的后续追问如何送达。">
            <Segmented
              label="后续消息投递"
              value={prefs.followUpMode}
              onChange={(v) => set('followUpMode', v)}
              options={DELIVERY_OPTIONS}
            />
          </Row>
          <Row
            label="项目信任"
            settingKey="defaultProjectTrust"
            hint="是否加载工作目录下的 .pi 项目配置。仅可在 agent 目录的设置中生效。"
          >
            <Segmented
              label="项目信任"
              value={prefs.defaultProjectTrust}
              onChange={(v) => set('defaultProjectTrust', v)}
              options={[
                { value: 'ask', label: '每次询问' },
                { value: 'always', label: '始终信任' },
                { value: 'never', label: '从不信任' },
              ]}
            />
          </Row>
        </Section>

        <Section title="上下文压缩" description="上下文接近模型上限时，自动将较早的对话总结为摘要。">
          <Row label="自动压缩" settingKey="compaction.enabled">
            <Toggle
              label="自动压缩"
              checked={prefs.compactionEnabled}
              onChange={(v) => set('compactionEnabled', v)}
            />
          </Row>
          <Row
            label="触发阈值"
            settingKey="compaction.reserveTokens"
            hint="剩余可用上下文低于该值时开始压缩。"
            disabled={!prefs.compactionEnabled}
          >
            <NumberField
              label="触发阈值"
              value={prefs.compactionReserveTokens}
              onChange={(v) => set('compactionReserveTokens', v)}
              min={1024}
              max={1000000}
              unit="tok"
            />
          </Row>
          <Row
            label="保留最近对话"
            settingKey="compaction.keepRecentTokens"
            hint="这部分最近的上下文保持原文，不做摘要。"
            disabled={!prefs.compactionEnabled}
          >
            <NumberField
              label="保留最近对话"
              value={prefs.compactionKeepRecentTokens}
              onChange={(v) => set('compactionKeepRecentTokens', v)}
              min={0}
              max={1000000}
              unit="tok"
            />
          </Row>
        </Section>

        <Section title="会话">
          <Row
            label="会话存储目录"
            settingKey="sessionDir"
            hint="留空使用 agent 目录下的默认位置；PI_CODING_AGENT_SESSION_DIR 与 --session-dir 优先。"
          >
            <TextField
              aria-label="会话存储目录"
              value={prefs.sessionDir}
              onChange={(e) => set('sessionDir', e.target.value)}
              placeholder="默认目录"
              spellCheck={false}
              mono
              className="w-[240px]"
            />
          </Row>
          <Row
            label="分享目的地"
            settingKey="sessionShareDestination"
            hint="/share 命令的去向。自动：已登录 Radius 时使用 Radius，否则创建 GitHub Gist。"
          >
            <Segmented
              label="分享目的地"
              value={prefs.sessionShareDestination}
              onChange={(v) => set('sessionShareDestination', v)}
              options={[
                { value: 'auto', label: '自动' },
                { value: 'gist', label: 'GitHub Gist' },
                { value: 'radius', label: 'Radius' },
              ]}
            />
          </Row>
        </Section>
      </div>
    </>
  );
};

// ---------------------------------------------------------------------------
// 网络与隐私
// ---------------------------------------------------------------------------

export const NetworkSettings: React.FC = () => {
  const { prefs } = useSettings();
  const proxyError = validateProxy(prefs.httpProxy);
  return (
    <>
      <PageHeader
        crumbs={['通用', '网络与隐私']}
        title="网络与隐私"
        description="pi 调用模型 Provider 时使用的传输方式、代理、超时与重试策略。"
      />
      <div className="space-y-4">
        <Section title="传输与超时">
          <Row label="传输方式" settingKey="transport" hint="仅对支持多种传输方式的 Provider 生效。">
            <SelectField
              aria-label="传输方式"
              value={prefs.transport}
              onChange={(e) => set('transport', e.target.value as SettingsPrefs['transport'])}
              wrapperClassName="w-[180px]"
            >
              <option value="auto">自动</option>
              <option value="sse">SSE</option>
              <option value="websocket">WebSocket</option>
              <option value="websocket-cached">WebSocket（缓存）</option>
            </SelectField>
          </Row>
          <Row label="HTTP 空闲超时" settingKey="httpIdleTimeoutMs" hint="响应头与响应体的空闲超时，0 表示禁用。">
            <NumberField
              label="HTTP 空闲超时"
              value={prefs.httpIdleTimeoutMs}
              onChange={(v) => set('httpIdleTimeoutMs', v)}
              min={0}
              max={3600000}
              unit="ms"
            />
          </Row>
          <Row label="WebSocket 连接超时" settingKey="websocketConnectTimeoutMs" hint="0 表示禁用。">
            <NumberField
              label="WebSocket 连接超时"
              value={prefs.websocketConnectTimeoutMs}
              onChange={(v) => set('websocketConnectTimeoutMs', v)}
              min={0}
              max={600000}
              unit="ms"
            />
          </Row>
        </Section>

        <Section title="代理">
          <Row
            label="HTTP 代理"
            settingKey="httpProxy"
            hint={
              proxyError ? (
                <span className="text-[#D93025]">{proxyError}</span>
              ) : (
                '作为 HTTP_PROXY / HTTPS_PROXY 应用于 pi 管理的 HTTP 客户端。仅可在 agent 目录的设置中生效。'
              )
            }
          >
            <TextField
              aria-label="HTTP 代理"
              value={prefs.httpProxy}
              onChange={(e) => set('httpProxy', e.target.value)}
              placeholder="http://127.0.0.1:7890"
              spellCheck={false}
              invalid={!!proxyError}
              mono
              className="w-[240px]"
            />
          </Row>
        </Section>

        <Section title="自动重试" description="遇到限流、超时等暂时性错误时，按指数退避自动重试。">
          <Row label="启用自动重试" settingKey="retry.enabled">
            <Toggle label="启用自动重试" checked={prefs.retryEnabled} onChange={(v) => set('retryEnabled', v)} />
          </Row>
          <Row label="最大重试次数" settingKey="retry.maxRetries" disabled={!prefs.retryEnabled}>
            <NumberField
              label="最大重试次数"
              value={prefs.retryMaxRetries}
              onChange={(v) => set('retryMaxRetries', v)}
              min={0}
              max={20}
              unit="次"
            />
          </Row>
          <Row label="初始退避延迟" settingKey="retry.baseDelayMs" disabled={!prefs.retryEnabled}>
            <NumberField
              label="初始退避延迟"
              value={prefs.retryBaseDelayMs}
              onChange={(v) => set('retryBaseDelayMs', v)}
              min={100}
              max={600000}
              unit="ms"
            />
          </Row>
          <Row label="最大退避延迟" settingKey="retry.maxAgentDelayMs" disabled={!prefs.retryEnabled}>
            <NumberField
              label="最大退避延迟"
              value={prefs.retryMaxAgentDelayMs}
              onChange={(v) => set('retryMaxAgentDelayMs', v)}
              min={1000}
              max={3600000}
              unit="ms"
            />
          </Row>
        </Section>

        <Section title="隐私">
          <Row
            label="安装与更新统计"
            settingKey="enableInstallTelemetry"
            hint="匿名上报安装 / 更新事件及所选 Provider 的归因请求头；不影响更新检查。"
          >
            <Toggle
              label="安装与更新统计"
              checked={prefs.enableInstallTelemetry}
              onChange={(v) => set('enableInstallTelemetry', v)}
            />
          </Row>
          <Row label="分享分析数据" settingKey="enableAnalytics" hint="目前仅用于实验性的首次运行引导。">
            <Toggle
              label="分享分析数据"
              checked={prefs.enableAnalytics}
              onChange={(v) => set('enableAnalytics', v)}
            />
          </Row>
        </Section>
      </div>
    </>
  );
};
