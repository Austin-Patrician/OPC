import { Boxes, Info, LucideIcon, Settings2, ShieldCheck } from 'lucide-react';

export type SettingsPageId =
  | 'appearance'
  | 'notifications'
  | 'workspace'
  | 'network'
  | 'llm'
  | 'image'
  | 'selfcheck'
  | 'about';

export type SettingsGroupId = 'general' | 'models' | 'selfcheck' | 'about';

export interface SettingsGroup {
  id: SettingsGroupId;
  label: string;
  icon: LucideIcon;
  color: string;
  /** Groups with a single page render as a leaf row without a submenu. */
  pages: { id: SettingsPageId; label: string }[];
}

export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    id: 'general',
    label: '通用',
    icon: Settings2,
    color: '#8E8E93',
    pages: [
      { id: 'appearance', label: '外观与语言' },
      { id: 'notifications', label: '通知' },
      { id: 'workspace', label: '工作区与会话' },
      { id: 'network', label: '网络与隐私' },
    ],
  },
  {
    id: 'models',
    label: '模型',
    icon: Boxes,
    color: '#7A4CE0',
    pages: [
      { id: 'llm', label: 'LLM' },
      { id: 'image', label: 'Image' },
    ],
  },
  { id: 'selfcheck', label: '自检', icon: ShieldCheck, color: '#34C759', pages: [{ id: 'selfcheck', label: '自检' }] },
  { id: 'about', label: '关于', icon: Info, color: '#0099FF', pages: [{ id: 'about', label: '关于' }] },
];

export const groupOfPage = (page: SettingsPageId) =>
  SETTINGS_GROUPS.find((g) => g.pages.some((p) => p.id === page)) ?? SETTINGS_GROUPS[0];
