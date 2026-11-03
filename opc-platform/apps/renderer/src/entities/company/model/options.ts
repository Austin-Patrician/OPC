import type { CompanyProfile } from '@opc/shared/domain';

/**
 * 工作台资料的词汇表。
 *
 * id 存进库，标签翻译：`company.domain.<id>` / `company.color.<id>`。未知 id（被更新的
 * 版本写进去的资料）落到第一项，而不是渲染成空白。
 */

export const DOMAINS = [
  { id: 'content' },
  { id: 'ecommerce' },
  { id: 'software' },
  { id: 'knowledge' },
  { id: 'consulting' },
  { id: 'other' },
] as const;

export type DomainId = (typeof DOMAINS)[number]['id'];

export const BRAND_COLORS = [
  { id: 'ocean', from: '#38B6FF', to: '#0058E0' },
  { id: 'violet', from: '#B49CFF', to: '#6430E0' },
  { id: 'aurora', from: '#45E3CF', to: '#0A86D8' },
  { id: 'sunset', from: '#FFB86B', to: '#F0436A' },
  { id: 'forest', from: '#5EE38D', to: '#05875F' },
  { id: 'graphite', from: '#7A808C', to: '#16181D' },
] as const;

export type BrandColorId = (typeof BRAND_COLORS)[number]['id'];

export const DEFAULT_BRAND_COLOR: BrandColorId = 'ocean';

export const brandColor = (colorId: string) =>
  BRAND_COLORS.find((color) => color.id === colorId) ?? BRAND_COLORS[0];

export const domainLabelKey = (domainId: string) =>
  `company.domain.${DOMAINS.some((domain) => domain.id === domainId) ? domainId : 'other'}`;

export const colorLabelKey = (colorId: string) =>
  `company.color.${BRAND_COLORS.some((color) => color.id === colorId) ? colorId : DEFAULT_BRAND_COLOR}`;

/** Name shown in the title bar: the stored name, or the caller's fallback. */
export const companyName = (profile: CompanyProfile, fallback: string) => profile.name.trim() || fallback;

/** What you is called: the stored name, or the caller's fallback. */
export const userName = (profile: CompanyProfile, fallback: string) => profile.userName.trim() || fallback;

/** Two-character monogram: CJK names use their first two characters, Latin their initials. */
export function companyMonogram(name: string, fallback = 'OPC'): string {
  const trimmed = name.trim();
  if (!trimmed) return fallback;
  if (/^[\u3400-\u9fff]/.test(trimmed)) return Array.from(trimmed.replace(/\s/g, '')).slice(0, 2).join('');
  const words = trimmed.split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words.slice(0, 2).map((word) => word[0]) : Array.from(words[0]!).slice(0, 2);
  return letters.join('').toUpperCase();
}
