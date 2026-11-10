import { describe, expect, it } from 'vitest';
import {
  filterSelectOptions,
  getSelectMenuPosition,
  nextSelectIndex,
  shouldShowSelectSearch,
  type SelectOption,
} from './Select';

const options: SelectOption[] = [
  { value: 'one', label: 'Asia/Shanghai' },
  { value: 'two', label: 'Europe/London' },
  { value: 'three', label: 'America/New_York' },
];

describe('Select helpers', () => {
  it('filters options without case sensitivity or surrounding whitespace', () => {
    expect(filterSelectOptions(options, '  lOnDoN ')).toEqual([options[1]]);
    expect(filterSelectOptions(options, '')).toEqual(options);
  });

  it('enables search automatically for long lists and allows explicit overrides', () => {
    expect(shouldShowSelectSearch(9)).toBe(false);
    expect(shouldShowSelectSearch(10)).toBe(true);
    expect(shouldShowSelectSearch(2, true)).toBe(true);
    expect(shouldShowSelectSearch(20, false)).toBe(false);
  });

  it('aligns menu width with the trigger and caps it to viewport bounds', () => {
    expect(getSelectMenuPosition(
      { left: 100, top: 50, bottom: 80, width: 180 },
      800,
      600,
    )).toEqual({ left: 100, width: 180, maxHeight: 320, top: 84 });

    expect(getSelectMenuPosition(
      { left: 250, top: 30, bottom: 60, width: 180 },
      320,
      600,
    )).toEqual({ left: 132, width: 180, maxHeight: 320, top: 64 });
  });

  it('flips above the trigger when the lower edge has less room', () => {
    expect(getSelectMenuPosition(
      { left: 40, top: 650, bottom: 680, width: 220 },
      800,
      720,
    )).toEqual({ left: 40, width: 220, maxHeight: 320, bottom: 74 });
  });

  it('wraps keyboard navigation across enabled items and handles empty lists', () => {
    expect(nextSelectIndex(-1, 1, 3)).toBe(0);
    expect(nextSelectIndex(0, -1, 3)).toBe(2);
    expect(nextSelectIndex(2, 1, 3)).toBe(0);
    expect(nextSelectIndex(-1, 1, 0)).toBe(-1);
  });
});
