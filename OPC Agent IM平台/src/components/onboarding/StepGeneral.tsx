import React, { useEffect, useState } from 'react';
import { BellRing, Monitor, Moon, Sun } from 'lucide-react';
import { ThemePreview } from '../settings/GeneralSettings';
import { SettingsPrefs, settingsStore, useSettings } from '../settings/settingsStore';
import { Toggle } from '../settings/settingsUi';
import { Block, ChoiceCard, Kbd, StepHeader, isMac } from './onboardingShared';

const THEMES: { value: SettingsPrefs['theme']; label: string; icon: React.ElementType }[] = [
  { value: 'system', label: '跟随系统', icon: Monitor },
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
];

const LANGUAGES: { value: SettingsPrefs['language']; label: string; sub: string }[] = [
  { value: 'zh-CN', label: '简体中文', sub: 'Chinese, Simplified' },
  { value: 'zh-TW', label: '繁體中文', sub: 'Chinese, Traditional' },
  { value: 'en-US', label: 'English', sub: 'English, US' },
];

type Permission = NotificationPermission | 'unsupported';
const readPermission = (): Permission => ('Notification' in window ? Notification.permission : 'unsupported');

const PERMISSION_TEXT: Record<Permission, string> = {
  granted: '浏览器已允许通知',
  default: '尚未授权浏览器通知',
  denied: '浏览器已拒绝通知，可在站点设置中重新允许',
  unsupported: '当前浏览器不支持桌面通知',
};

export const StepGeneral: React.FC = () => {
  const { prefs } = useSettings();
  const [permission, setPermission] = useState<Permission>(readPermission);
  const mod = isMac() ? '⌘' : 'Ctrl';

  useEffect(() => {
    const refresh = () => setPermission(readPermission());
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);

  const requestPermission = async () => {
    try {
      setPermission(await Notification.requestPermission());
    } catch {
      setPermission(readPermission());
    }
  };

  return (
    <>
      <StepHeader
        eyebrow="通用偏好"
        title="打造顺手的工作环境"
        description="选择外观、语言与消息习惯。偏好会立即保存，之后可在「设置 › 通用」中随时调整。"
      />

      <div className="space-y-7">
        <Block title="界面主题" hint="深色主题适配中，当前界面以浅色呈现">
          <div className="grid grid-cols-3 gap-3">
            {THEMES.map(({ value, label, icon: Icon }) => (
              <ChoiceCard key={value} selected={prefs.theme === value} onClick={() => settingsStore.set('theme', value)} className="p-2.5">
                <ThemePreview mode={value} />
                <div className="mt-2.5 px-0.5 flex items-center gap-1.5 text-[12.5px] font-medium text-[#1C1C1E]">
                  <Icon className="w-3.5 h-3.5 text-[#8E8E93]" />
                  {label}
                </div>
              </ChoiceCard>
            ))}
          </div>
        </Block>

        <Block title="界面语言" hint="其他语言的界面文案正在完善">
          <div className="grid grid-cols-3 gap-3">
            {LANGUAGES.map((lang) => (
              <ChoiceCard
                key={lang.value}
                selected={prefs.language === lang.value}
                onClick={() => settingsStore.set('language', lang.value)}
                className="px-3.5 py-3"
              >
                <div className="text-[13.5px] font-semibold text-[#1C1C1E]">{lang.label}</div>
                <div className="mt-0.5 text-[11.5px] text-[#8E8E93]">{lang.sub}</div>
              </ChoiceCard>
            ))}
          </div>
        </Block>

        <Block title="发送消息">
          <div className="grid grid-cols-2 gap-3">
            <ChoiceCard selected={prefs.sendShortcut === 'enter'} onClick={() => settingsStore.set('sendShortcut', 'enter')} className="px-4 py-3.5">
              <div className="flex items-center gap-1.5">
                <Kbd>Enter</Kbd>
                <span className="text-[13px] font-medium text-[#1C1C1E] ml-1">发送</span>
              </div>
              <div className="mt-2 flex items-center gap-1 text-[11.5px] text-[#8E8E93]">
                <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd>
                <span className="ml-0.5">换行，适合快速对话</span>
              </div>
            </ChoiceCard>
            <ChoiceCard
              selected={prefs.sendShortcut === 'mod-enter'}
              onClick={() => settingsStore.set('sendShortcut', 'mod-enter')}
              className="px-4 py-3.5"
            >
              <div className="flex items-center gap-1">
                <Kbd>{mod}</Kbd>+<Kbd>Enter</Kbd>
                <span className="text-[13px] font-medium text-[#1C1C1E] ml-1">发送</span>
              </div>
              <div className="mt-2 flex items-center gap-1 text-[11.5px] text-[#8E8E93]">
                <Kbd>Enter</Kbd>
                <span className="ml-0.5">换行，适合撰写长指令</span>
              </div>
            </ChoiceCard>
          </div>
        </Block>

        <Block title="消息提醒">
          <div className="rounded-xl border border-[#E5E5E7] bg-white px-4 py-3.5 flex items-center gap-3.5">
            <span className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#FFB86B] to-[#F0436A] flex items-center justify-center text-white shrink-0 shadow-[0_6px_16px_-6px_rgba(240,67,106,0.7)]">
              <BellRing className="w-[18px] h-[18px]" />
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-medium text-[#1C1C1E]">桌面通知</div>
              <div className="mt-0.5 text-[11.5px] text-[#8E8E93]">
                Agent 完成任务或 @ 你时提醒 · {PERMISSION_TEXT[permission]}
              </div>
            </div>
            {permission === 'default' && prefs.desktopNotify && (
              <button
                type="button"
                onClick={requestPermission}
                className="h-[30px] px-3 rounded-md bg-[#0099FF] hover:bg-[#008BEA] text-white text-[12px] font-medium cursor-pointer transition-colors"
              >
                允许通知
              </button>
            )}
            <Toggle label="桌面通知" checked={prefs.desktopNotify} onChange={(v) => settingsStore.set('desktopNotify', v)} />
          </div>
        </Block>
      </div>
    </>
  );
};
