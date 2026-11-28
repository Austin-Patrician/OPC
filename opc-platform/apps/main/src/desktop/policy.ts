import type { DesktopApprovalCategory } from '@opc/shared/ipc';

export const DESKTOP_APPROVAL_CATEGORIES: readonly DesktopApprovalCategory[] = [
  'send-message',
  'destructive',
  'payment',
  'quit-app',
  'system-settings',
];

export const DEFAULT_DESKTOP_APPROVALS: readonly DesktopApprovalCategory[] = [
  'send-message',
  'destructive',
  'payment',
  'quit-app',
];

export interface DesktopRefMeta {
  ref: string;
  role?: string;
  name?: string;
  value?: string;
  app?: string;
  windowId?: string;
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface DesktopAppTarget {
  app?: string;
  bundleId?: string;
  process?: string;
}

const APP_ALIAS_GROUPS: readonly (readonly string[])[] = [
  ['钥匙串访问', 'Keychain Access', 'com.apple.keychainaccess'],
  [
    '系统设置',
    '系统偏好设置',
    'System Settings',
    'System Preferences',
    'com.apple.systempreferences',
    'Control Panel',
  ],
  ['微信', 'WeChat', 'com.tencent.xinWeChat'],
  ['支付宝', 'Alipay', 'com.alipay.wallet'],
  ['飞书', 'Lark', 'Feishu', 'com.electron.lark'],
  ['钉钉', 'DingTalk', 'com.alibaba.DingTalkMac'],
  ['1Password', 'com.1password.1password', 'com.1password.mac'],
  ['Bitwarden', 'com.bitwarden.desktop'],
  ['备忘录', 'Notes', 'com.apple.Notes'],
  ['终端', 'Terminal', 'com.apple.Terminal', 'iTerm', 'iTerm2', 'com.googlecode.iterm2'],
];

function stripAppExtension(value: string): string {
  return value.replace(/\.(?:app|exe)$/i, '').trim();
}

function expandTokenVariants(raw: string): Set<string> {
  const tokens = new Set<string>();
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return tokens;
  tokens.add(trimmed);
  const stripped = stripAppExtension(trimmed);
  if (stripped) tokens.add(stripped);

  for (const group of APP_ALIAS_GROUPS) {
    const lowerGroup = group.map((item) => item.toLowerCase());
    if (lowerGroup.some((item) => item === trimmed || item === stripped)) {
      for (const alias of lowerGroup) tokens.add(alias);
    }
  }
  return tokens;
}

/**
 * Checks whether a target desktop app/process/bundleId matches any entry in the user's blacklist.
 * Supports case-insensitive names, `.app`/`.exe` suffixes, bundle IDs, and common CN/EN aliases.
 */
export function isAppBlocked(
  target: DesktopAppTarget | string | undefined,
  blockedApps: readonly string[],
): boolean {
  if (!target || blockedApps.length === 0) return false;

  const targetCandidates =
    typeof target === 'string'
      ? [target]
      : [target.app, target.bundleId, target.process].filter(
          (entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()),
        );
  if (targetCandidates.length === 0) return false;

  const targetVariants = new Set<string>();
  for (const candidate of targetCandidates) {
    for (const variant of expandTokenVariants(candidate)) {
      targetVariants.add(variant);
    }
  }

  for (const rawBlocked of blockedApps) {
    const blocked = rawBlocked.trim();
    if (!blocked) continue;
    const blockedVariants = expandTokenVariants(blocked);
    for (const candidateVariant of targetVariants) {
      if (blockedVariants.has(candidateVariant)) return true;
      // Match reversed-DNS bundle identifiers if either side uses one.
      if (blocked.includes('.') && candidateVariant.includes('.')) {
        if (
          candidateVariant === blocked.toLowerCase() ||
          candidateVariant.endsWith(`.${blocked.toLowerCase()}`) ||
          blocked.toLowerCase().endsWith(`.${candidateVariant}`)
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

export interface DesktopActionRiskInput {
  action: string;
  app?: string;
  combo?: string;
  text?: string;
  refMeta?: DesktopRefMeta;
  consequential?: boolean;
}

export interface DesktopActionRiskResult {
  risky: boolean;
  category?: DesktopApprovalCategory;
  title?: string;
  preview?: string;
}

const QUIT_HOTKEY_RE = /^(?:cmd|command|meta|super)\+(?:shift\+|alt\+)?q$|^alt\+f4$/;
const DESTRUCTIVE_HOTKEY_RE = /^(?:cmd|command|meta)\+(?:backspace|delete)$|^shift\+delete$/;
const SEND_HOTKEY_RE = /^(?:cmd|command|meta|ctrl|control)\+(?:return|enter)$/;

const PAYMENT_RE =
  /支付|付款|转账|下单|提交订单|确认支付|确认付款|立即购买|确认转账|充值|\bpay\s*now\b|\bcheckout\b|\bpurchase\b|\btransfer\b|\bconfirm\s*payment\b/i;
const DESTRUCTIVE_RE =
  /删除|移到废纸篓|移至废纸篓|永久删除|全部清空|清空|格式化|卸载|销毁|注销账号|revoke|\bdelete\b|\bremove\b|\btrash\b|\berase\b|\bformat\b|\buninstall\b|\bwipe\b/i;
const SEND_RE =
  /发送|提交|发布|发表|回复|群发|寄出|确认发送|\bsend\b|\bsubmit\b|\bpublish\b|\bpost\b|\breply\b/i;
const SYSTEM_SETTINGS_APP_RE =
  /system\s*settings|system\s*preferences|系统设置|系统偏好设置|keychain\s*access|钥匙串访问|com\.apple\.systempreferences|com\.apple\.keychainaccess/i;

const CATEGORY_TITLES: Record<DesktopApprovalCategory, string> = {
  'send-message': '确认发送消息或提交内容',
  destructive: '确认删除或破坏性操作',
  payment: '确认支付、下单或转账操作',
  'quit-app': '确认关闭或退出桌面应用',
  'system-settings': '确认修改系统设置或钥匙串',
};

const READ_ONLY_ACTIONS = new Set([
  'snapshot',
  'find',
  'get',
  'is',
  'list-apps',
  'list-windows',
  'list-displays',
  'list-surfaces',
  'screenshot',
  'focus-window',
  'scroll',
  'scroll-to',
]);

/**
 * Classifies whether a desktop action hits a guarded approval category.
 */
export function classifyDesktopActionRisk(
  input: DesktopActionRiskInput,
  requireApprovalFor: readonly DesktopApprovalCategory[],
): DesktopActionRiskResult {
  const enabled = new Set(requireApprovalFor);
  const normalizedCombo = (input.combo ?? '').toLowerCase().replace(/\s+/g, '');
  const label = [input.refMeta?.name, input.refMeta?.value, input.text]
    .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    .join(' · ')
    .trim();
  const targetApp = input.app ?? input.refMeta?.app;
  const preview = [targetApp, label || normalizedCombo || input.action]
    .filter(Boolean)
    .join(' · ');

  let matched: DesktopApprovalCategory | undefined;

  if (
    input.action === 'close-app' ||
    input.action === 'close' ||
    QUIT_HOTKEY_RE.test(normalizedCombo)
  ) {
    matched = 'quit-app';
  } else if (PAYMENT_RE.test(label)) {
    matched = 'payment';
  } else if (DESTRUCTIVE_HOTKEY_RE.test(normalizedCombo) || DESTRUCTIVE_RE.test(label)) {
    matched = 'destructive';
  } else if (SEND_HOTKEY_RE.test(normalizedCombo) || SEND_RE.test(label)) {
    matched = 'send-message';
  } else if (
    targetApp &&
    SYSTEM_SETTINGS_APP_RE.test(targetApp) &&
    !READ_ONLY_ACTIONS.has(input.action)
  ) {
    matched = 'system-settings';
  }

  if (matched && enabled.has(matched)) {
    return {
      risky: true,
      category: matched,
      title: CATEGORY_TITLES[matched],
      ...(preview ? { preview } : {}),
    };
  }

  if (input.consequential && enabled.size > 0) {
    return {
      risky: true,
      category: 'send-message',
      title: '确认执行敏感桌面操作',
      ...(preview ? { preview } : {}),
    };
  }

  return { risky: false };
}
