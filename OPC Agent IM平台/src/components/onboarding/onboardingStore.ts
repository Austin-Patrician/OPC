import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'opc.onboarding.v1';

export type OnboardingStatus = 'pending' | 'completed' | 'skipped';

export type Industry = 'content' | 'ecommerce' | 'software' | 'knowledge' | 'consulting' | 'other';

export interface CompanyProfile {
  name: string;
  vision: string;
  industry: Industry | '';
  colorId: string;
}

export const BRAND_COLORS = [
  { id: 'ocean', label: '深海蓝', from: '#38B6FF', to: '#0058E0' },
  { id: 'violet', label: '星云紫', from: '#B49CFF', to: '#6430E0' },
  { id: 'aurora', label: '极光青', from: '#45E3CF', to: '#0A86D8' },
  { id: 'sunset', label: '日落橙', from: '#FFB86B', to: '#F0436A' },
  { id: 'forest', label: '森林绿', from: '#5EE38D', to: '#05875F' },
  { id: 'graphite', label: '石墨黑', from: '#7A808C', to: '#16181D' },
] as const;

export const INDUSTRIES: { id: Industry; label: string }[] = [
  { id: 'content', label: '短视频与内容' },
  { id: 'ecommerce', label: '电商与带货' },
  { id: 'software', label: '软件与 AI 产品' },
  { id: 'knowledge', label: '知识付费' },
  { id: 'consulting', label: '咨询与服务' },
  { id: 'other', label: '其他' },
];

const DEFAULT_COMPANY: CompanyProfile = { name: '', vision: '', industry: '', colorId: 'ocean' };

interface OnboardingState {
  status: OnboardingStatus;
  company: CompanyProfile;
  /** Whether the onboarding overlay is visible; not persisted. */
  open: boolean;
}

const load = (): Omit<OnboardingState, 'open'> => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { status: 'pending', company: DEFAULT_COMPANY };
    const parsed = JSON.parse(raw) as Partial<{ status: unknown; company: Record<string, unknown> }>;
    const status: OnboardingStatus =
      parsed.status === 'completed' || parsed.status === 'skipped' ? parsed.status : 'pending';
    const company = { ...DEFAULT_COMPANY };
    const source = parsed.company ?? {};
    if (typeof source.name === 'string') company.name = source.name.slice(0, 24);
    if (typeof source.vision === 'string') company.vision = source.vision.slice(0, 40);
    if (INDUSTRIES.some((i) => i.id === source.industry)) company.industry = source.industry as Industry;
    if (BRAND_COLORS.some((c) => c.id === source.colorId)) company.colorId = source.colorId as string;
    return { status, company };
  } catch {
    return { status: 'pending', company: DEFAULT_COMPANY };
  }
};

const initial = load();
let state: OnboardingState = { ...initial, open: initial.status === 'pending' };
const listeners = new Set<() => void>();

const commit = (next: Partial<OnboardingState>) => {
  state = { ...state, ...next };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ status: state.status, company: state.company }));
  } catch {
    // Storage unavailable: the onboarding simply shows again next time.
  }
  listeners.forEach((listener) => listener());
};

export const onboardingStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot: () => state,
  updateCompany(partial: Partial<CompanyProfile>) {
    commit({ company: { ...state.company, ...partial } });
  },
  finish(status: Exclude<OnboardingStatus, 'pending'>) {
    // Skipping a reopened guide must not downgrade an earlier completion.
    commit({ status: state.status === 'completed' ? 'completed' : status, open: false });
  },
  reopen() {
    commit({ open: true });
  },
};

export const useOnboarding = () => useSyncExternalStore(onboardingStore.subscribe, onboardingStore.getSnapshot);

export const companyDisplayName = (company: CompanyProfile) => company.name.trim() || 'OPC 一人公司';

export const brandColor = (colorId: string) => BRAND_COLORS.find((c) => c.id === colorId) ?? BRAND_COLORS[0];

/** Two-character monogram: CJK names use their first two characters, Latin names their initials. */
export const companyMonogram = (name: string) => {
  const trimmed = name.trim();
  if (!trimmed) return 'OPC';
  if (/^[\u3400-\u9fff]/.test(trimmed)) return Array.from(trimmed.replace(/\s/g, '')).slice(0, 2).join('');
  const words = trimmed.split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words.slice(0, 2).map((w) => w[0]) : Array.from(words[0]).slice(0, 2);
  return letters.join('').toUpperCase();
};
