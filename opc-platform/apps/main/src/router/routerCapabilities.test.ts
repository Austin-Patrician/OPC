import { describe, expect, it } from 'vitest';
import { renderRouterWorkerCapabilities, summarizeWorkerTools } from './routerCapabilities';

describe('Router Worker capability directory', () => {
  it('keeps only useful task tools and caps the list', () => {
    const result = summarizeWorkerTools([
      'recall',
      'bash',
      ...Array.from({ length: 20 }, () => 'desktop_snapshot'),
      ...Array.from({ length: 20 }, () => 'desktop_click'),
      'browser_open',
    ]);

    expect(result.tools).toEqual(['browser_open', 'desktop_snapshot', 'desktop_click', 'bash']);
    expect(result.omittedTools).toBeUndefined();

    const capped = summarizeWorkerTools([
      'bash',
      'read',
      'write',
      'edit',
      'browser_open',
      'browser_snapshot',
      'browser_read',
      'browser_click',
      'browser_tabs',
      'browser_screenshot',
      'desktop_list_apps',
      'desktop_list_windows',
      'desktop_snapshot',
      'desktop_find',
      'desktop_get',
      'desktop_click',
      'desktop_scroll',
      'desktop_screenshot',
    ]);
    expect(capped.tools).toEqual([
      'browser_open',
      'browser_snapshot',
      'browser_read',
      'browser_click',
      'browser_tabs',
      'browser_screenshot',
      'desktop_list_apps',
      'desktop_list_windows',
      'desktop_snapshot',
      'desktop_find',
      'desktop_get',
      'desktop_click',
      'desktop_scroll',
      'desktop_screenshot',
      'read',
      'write',
    ]);
    expect(capped.omittedTools).toBe(2);
  });

  it('renders metadata without granting Router execution access', () => {
    const text = renderRouterWorkerCapabilities([
      { name: '小助手', template: 'research', tools: ['desktop_list_apps', 'desktop_snapshot'] },
    ]);

    expect(text).toContain('小助手 · research：desktop_list_apps、desktop_snapshot');
    expect(text).toContain('Router 不能直接调用这些工具');
    expect(text).toContain('open_line_of_work');
    expect(text).not.toContain('desktop_snapshot(');
  });
});
