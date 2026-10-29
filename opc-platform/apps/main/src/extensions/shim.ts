import fs from 'node:fs';
import path from 'node:path';
import { defineExtension, defineTool, hook, ToolTask } from '@earendil-works/pi-durable';
import type { Extension, ToolExecutionApi, ToolRegistration } from '@earendil-works/pi-durable';
import type { JsonValue } from '@earendil-works/chord';
import type { ToolResultMessage } from '@earendil-works/pi-ai';
import { Type, type TSchema } from 'typebox';
import { workspaceOf } from '../sandbox/workspaces';

/**
 * Pi coding-agent extensions, adapted to pi-durable.
 *
 * The two SDKs describe extensions differently. Pi's is imperative: a module
 * exports `(pi: ExtensionAPI) => void` and calls `pi.registerTool()` / `pi.on()`
 * while it loads. pi-durable's is declarative: an `Extension` is plain data the
 * host installs. This module loads the former and lowers it to the latter.
 *
 * What survives the crossing:
 *   - custom tools          → `Extension.tools` (schemas are typebox on both sides)
 *   - `tool_call` handlers  → a `ToolTask.beforeTool` hook (block or rewrite args)
 *   - `before_agent_start`  → nothing: OPC renders its own system prompt
 *   - `ctx.ui.*`            → no dialogs yet; `confirm` answers "no" and says so
 *
 * Everything else is recorded in `unsupported` instead of failing the load, so a
 * half-supported extension still contributes its tools and the UI can say so.
 */

export interface PiToolLike {
  name: string;
  description?: string;
  parameters?: TSchema;
  execute?: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal,
    onUpdate: (update: { content?: unknown }) => void,
    ctx: unknown,
  ) => Promise<{ content?: unknown; details?: unknown; isError?: boolean } | undefined> | {
    content?: unknown;
    details?: unknown;
    isError?: boolean;
  };
}

type PiHandler = (event: unknown, ctx: unknown) => unknown;

export interface LoadedPiExtension {
  extension: Extension;
  tools: string[];
  events: string[];
  commands: string[];
  unsupported: string[];
}

export interface LoadOptions {
  /** Registry name, also what the employee policy stores (e.g. `pi.my-tools`). */
  name: string;
  /** Directory used to resolve the extension's own `node_modules`. */
  dir: string;
  /** Overrides `os.homedir()`-free tests; defaults to the real importer. */
  import?: (entry: string, options: { dir: string }) => Promise<unknown>;
}

/**
 * Import one extension module and collect what it registered.
 *
 * This executes third-party code in the main process. Callers must have consent
 * before invoking it; nothing here is sandboxed.
 */
export async function loadPiExtension(entry: string, options: LoadOptions): Promise<LoadedPiExtension> {
  const factory = await importFactory(entry, options);

  const tools: PiToolLike[] = [];
  const events: string[] = [];
  const toolCallHandlers: PiHandler[] = [];
  const commands: string[] = [];
  const unsupported = new Set<string>();

  const target: Record<string, unknown> = {
    on(event: unknown, handler: unknown) {
      if (typeof event !== 'string' || typeof handler !== 'function') return () => {};
      events.push(event);
      if (event === 'tool_call') toolCallHandlers.push(handler as PiHandler);
      else unsupported.add(`event:${event}`);
      return () => {};
    },
    registerTool(tool: unknown) {
      if (tool && typeof tool === 'object' && typeof (tool as PiToolLike).name === 'string') {
        tools.push(tool as PiToolLike);
      }
      return () => {};
    },
    registerCommand(name: unknown) {
      if (typeof name === 'string') commands.push(name);
      return () => {};
    },
    registerShortcut() {
      unsupported.add('registerShortcut');
      return () => {};
    },
    registerFlag() {
      unsupported.add('registerFlag');
      return () => {};
    },
    registerProvider() {
      unsupported.add('registerProvider');
      return () => {};
    },
    registerMessageRenderer() {
      unsupported.add('registerMessageRenderer');
      return () => {};
    },
    appendEntry() {
      unsupported.add('appendEntry');
      return () => {};
    },
    sendUserMessage() {
      unsupported.add('sendUserMessage');
      return Promise.resolve();
    },
    getFlag: () => undefined,
    events: { on: () => () => {} },
  };

  const pi = new Proxy(target, {
    get(source, key) {
      if (key in source) return source[key as string];
      if (typeof key !== 'string' || key.startsWith('__')) return undefined;
      // Unknown API: record it once and stay callable, so one unsupported call
      // does not abort an otherwise useful extension.
      unsupported.add(key);
      return () => undefined;
    },
  });

  await factory(pi);

  const adapted = tools.map((tool) => adaptTool(tool, options.name));
  const hooks = toolCallHandlers.length
    ? [
        hook(ToolTask, {
          async beforeTool(call) {
            const event = {
              type: 'tool_call',
              toolCallId: call.id,
              toolName: call.name,
              input: call.arguments ?? {},
            };
            for (const handler of toolCallHandlers) {
              const verdict = (await handler(event, minimalContext(options.name))) as
                | { block?: boolean; reason?: string; input?: unknown }
                | undefined;
              if (!verdict) continue;
              if (verdict.block) {
                return { block: verdict.reason?.trim() || `被扩展 ${options.name} 拦截` };
              }
              if (verdict.input && typeof verdict.input === 'object') {
                return { arguments: verdict.input as Record<string, JsonValue> };
              }
            }
            return undefined;
          },
        }),
      ]
    : [];

  return {
    extension: defineExtension({
      name: options.name,
      tools: adapted,
      ...(hooks.length ? { hooks } : {}),
    }),
    tools: tools.map((tool) => tool.name),
    events,
    commands,
    unsupported: [...unsupported],
  };
}

async function importFactory(entry: string, options: LoadOptions): Promise<(pi: unknown) => unknown> {
  if (options.import) {
    const module = (await options.import(entry, { dir: options.dir })) as Record<string, unknown>;
    return pickFactory(module, entry);
  }

  // jiti runs TypeScript in place, exactly as Pi does. Two mappings keep a real
  // Pi extension working from a directory outside this app:
  //   - the host packages Pi provides (typebox, pi-ai, pi-durable) resolve to
  //     OPC's copies, so schema classes and helpers are shared, not duplicated;
  //   - `@earendil-works/pi-coding-agent` is a stand-in: the real package is a
  //     23 MB CLI, and extensions only import helpers and types from it.
  const { createJiti } = await import('jiti');
  const jiti = createJiti(entry, {
    interopDefault: true,
    moduleCache: false,
    alias: hostAliases(),
    virtualModules: { '@earendil-works/pi-coding-agent': codingAgentApi() },
  });
  const module = (await jiti.import(entry)) as Record<string, unknown>;
  return pickFactory(module, entry);
}

/** Packages Pi hands to extensions. Mirrors the list in Pi's own docs. */
const HOST_MODULES = ['typebox', '@earendil-works/pi-ai', '@earendil-works/pi-durable'];

/**
 * Resolve each host package to the file OPC itself would load.
 *
 * `require.resolve` cannot be used: these packages only publish an `import`
 * condition, and the main bundle is CommonJS. Reading `exports["."]` from the
 * package root is both simple and enough for the three packages involved.
 */
function hostAliases(): Record<string, string> {
  const alias: Record<string, string> = {};
  // `__dirname` exists in the bundled CommonJS main process (dev and packaged);
  // the other two cover `electron .` runs and asar layouts.
  const bases = [
    typeof __dirname === 'string' ? __dirname : undefined,
    process.cwd(),
    process.resourcesPath,
    process.resourcesPath ? path.join(process.resourcesPath, 'app.asar') : undefined,
  ].filter((value): value is string => Boolean(value));

  for (const name of HOST_MODULES) {
    const entry = findPackageEntry(name, bases);
    if (entry) alias[name] = entry;
  }
  return alias;
}

function findPackageEntry(name: string, bases: readonly string[]): string | undefined {
  for (const base of bases) {
    let dir = base;
    for (let depth = 0; depth < 8; depth += 1) {
      const root = path.join(dir, 'node_modules', name);
      const entry = readPackageEntry(root);
      if (entry) return entry;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

function readPackageEntry(root: string): string | undefined {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      exports?: unknown;
      module?: string;
      main?: string;
    };
    const dot = (manifest.exports as Record<string, unknown> | undefined)?.['.'];
    const candidate =
      typeof dot === 'string'
        ? dot
        : (dot as { import?: string; default?: string } | undefined)?.import ??
          (dot as { default?: string } | undefined)?.default ??
          manifest.module ??
          manifest.main;
    if (typeof candidate !== 'string') return undefined;
    const resolved = path.resolve(root, candidate);
    return fs.existsSync(resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function pickFactory(module: Record<string, unknown>, entry: string): (pi: unknown) => unknown {
  const candidate = (module.default ?? module) as unknown;
  if (typeof candidate !== 'function') {
    throw new Error(`扩展没有默认导出函数：${entry}`);
  }
  return candidate as (pi: unknown) => unknown;
}

/** The handful of runtime values extensions import from the coding-agent package. */
function codingAgentApi() {
  return {
    VERSION: 'opc-bridge',
    isToolCallEventType: (name: string, event: unknown) => {
      const value = event as { toolName?: string; tool?: string } | undefined;
      return value?.toolName === name || value?.tool === name;
    },
    isBashToolResult: (event: unknown) => hasToolName(event, 'bash'),
    isReadToolResult: (event: unknown) => hasToolName(event, 'read'),
    isEditToolResult: (event: unknown) => hasToolName(event, 'edit'),
    isWriteToolResult: (event: unknown) => hasToolName(event, 'write'),
    isGrepToolResult: (event: unknown) => hasToolName(event, 'grep'),
    isFindToolResult: (event: unknown) => hasToolName(event, 'find'),
    isLsToolResult: (event: unknown) => hasToolName(event, 'ls'),
  };
}

const hasToolName = (event: unknown, name: string) => {
  const value = event as { toolName?: string; tool?: string } | undefined;
  return value?.toolName === name || value?.tool === name;
};

/** pi-durable tools take `(args, api, context)`; Pi's take `(id, params, signal, onUpdate, ctx)`. */
function adaptTool(tool: PiToolLike, owner: string): ToolRegistration {
  const parameters = (tool.parameters ?? Type.Object({})) as TSchema;
  return defineTool({
    name: tool.name,
    description: tool.description ?? '',
    parameters,
    async execute(args, api: ToolExecutionApi) {
      if (!tool.execute) {
        return { output: text(`扩展 ${owner} 的工具 ${tool.name} 没有实现 execute()`), isError: true };
      }
      // OPC has no per-call abort yet; the controller exists so handlers that
      // check `signal.aborted` see a real signal rather than undefined.
      const controller = new AbortController();
      try {
        const result = await tool.execute(
          api.callId,
          args,
          controller.signal,
          (update) => {
            for (const block of blocksOf(update?.content)) {
              if (block.type === 'text') api.output(block.text);
            }
          },
          toolContext(api, owner),
        );
        return {
          output: toOutput(result?.content),
          ...(result?.details === undefined ? {} : { details: toJson(result.details) }),
          ...(result?.isError ? { isError: true } : {}),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        api.diagnostic({ severity: 'error', message: `${owner}/${tool.name}: ${message}` });
        return { output: text(`扩展 ${owner} 的工具 ${tool.name} 失败：${message}`), isError: true };
      }
    },
  }) as ToolRegistration;
}

function minimalContext(owner: string) {
  return {
    cwd: process.cwd(),
    hasUI: false,
    ui: uiStub(undefined, owner),
  };
}

function toolContext(api: ToolExecutionApi, owner: string) {
  const cwd = workspaceOf(api.conversationId) ?? process.cwd();
  return { cwd, hasUI: false, ui: uiStub(api, owner) };
}

/**
 * Pi's `ctx.ui` needs a renderer. Until the bridge exists, every dialog answers
 * "no"/"cancel" and says why, which is the only safe default.
 */
function uiStub(api: ToolExecutionApi | undefined, owner: string) {
  const note = (name: string) => {
    api?.diagnostic({
      severity: 'warn',
      message: `扩展 ${owner} 调用了 ctx.ui.${name}：OPC 暂不支持交互式扩展 UI，已按取消处理`,
    });
  };
  return new Proxy(
    {
      confirm: async () => {
        note('confirm');
        return false;
      },
      select: async () => {
        note('select');
        return undefined;
      },
      input: async () => {
        note('input');
        return undefined;
      },
      custom: async () => {
        note('custom');
        return undefined;
      },
      notify: (message: unknown) => {
        api?.diagnostic({ severity: 'info', message: String(message) });
      },
      setStatus: () => {},
      setWidget: () => {},
      setWorkingMessage: () => {},
      setEditorText: () => {},
      pasteToEditor: () => {},
    },
    {
      get(target, key) {
        if (key in target) return target[key as keyof typeof target];
        if (typeof key !== 'string' || key.startsWith('__')) return undefined;
        note(key);
        return () => undefined;
      },
    },
  );
}

type ContentBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

const blocksOf = (content: unknown): ContentBlock[] =>
  Array.isArray(content) ? (content as ContentBlock[]) : [];

const text = (value: string) => [{ type: 'text' as const, text: value }];

const toOutput = (content: unknown): ToolResultMessage['content'] =>
  blocksOf(content) as ToolResultMessage['content'];

/** `details` must be JSON: Pi extensions routinely pass class instances or functions. */
function toJson(value: unknown): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return {};
  }
}
