import type { WorkerTemplate } from '@opc/shared/domain';

/** Metadata the Router may use when choosing whether to delegate work. */
export interface RouterWorkerCapability {
  name: string;
  template: WorkerTemplate;
  tools: string[];
  omittedTools?: number;
}

/** Keep the Router's directory useful without copying every internal tool. */
const ROUTER_VISIBLE_TOOLS = new Set([
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
  'ocr_image',
  'generate_image',
  'transcribe_audio',
  'text_to_speech',
]);

const ROUTER_TOOL_LIMIT = 16;
const ROUTER_TOOL_PRIORITY = [
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
  'edit',
  'bash',
  'ocr_image',
  'generate_image',
  'transcribe_audio',
  'text_to_speech',
] as const;
const ROUTER_TOOL_RANK: ReadonlyMap<string, number> = new Map(ROUTER_TOOL_PRIORITY.map((name, index) => [name, index]));

export function summarizeWorkerTools(toolNames: readonly string[]): Pick<RouterWorkerCapability, 'tools' | 'omittedTools'> {
  const tools = [...new Set(toolNames)]
    .filter((name) => ROUTER_VISIBLE_TOOLS.has(name))
    .sort((left, right) => (ROUTER_TOOL_RANK.get(left) ?? ROUTER_TOOL_PRIORITY.length) - (ROUTER_TOOL_RANK.get(right) ?? ROUTER_TOOL_PRIORITY.length));
  const visible = tools.slice(0, ROUTER_TOOL_LIMIT);
  const omitted = tools.length - visible.length;
  return omitted > 0 ? { tools: visible, omittedTools: omitted } : { tools: visible };
}

export function renderRouterWorkerCapabilities(capabilities: readonly RouterWorkerCapability[]): string {
  if (capabilities.length === 0) {
    return [
      '当前没有可展示的 Worker 工具目录。',
      '不要把 Router 自己没有的工具误判为整个系统都没有；如需执行任务，先尝试派给 Worker，再依据实际汇报说明结果。',
    ].join('\n');
  }

  const lines = [
    '当前可派发的 Worker 能力（动态只读目录；Router 不能直接调用这些工具）：',
  ];
  for (const capability of capabilities) {
    const tools = capability.tools.length > 0 ? capability.tools.join('、') : '无可展示工具';
    const suffix = capability.omittedTools ? `（另有 ${capability.omittedTools} 个工具未列出）` : '';
    lines.push(`- ${capability.name} · ${capability.template}：${tools}${suffix}`);
  }
  lines.push(
    '用户请求匹配这些能力时，应调用 open_line_of_work 交给 Worker；能力目录不授予 Router 本身执行权限。',
  );
  return lines.join('\n');
}
