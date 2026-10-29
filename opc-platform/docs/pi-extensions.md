# 本机 Pi 扩展（发现·信任·装载）

> 目标：让别人用 Pi 写的扩展（`~/.pi/agent/extensions` 里那些 .ts 文件）在 OPC 里也能用，
> 但不因为"扫一下就执行了陌生代码"而把主进程交给它们。

---

## 1. 为什么要分两步

Pi 的扩展是**模块加载即执行**：`export default (pi) => { pi.registerTool(...) }`，import 的那一刻
作者的代码就在主进程里跑起来了，能看到数据库文件、工作区、API Key、会话历史。

所以 OPC 把"发现"和"执行"拆开：

| 阶段 | 做了什么 | 会不会执行第三方代码 |
| --- | --- | --- |
| 扫描 | 读目录、读 `package.json`、读 `settings.json` | 不会，纯文件读取 |
| 列出 | 名字、版本、作用域、入口路径 | 不会 |
| 启用（首次） | 弹信任框 → 记下 id → import 模块 | **会**，且权限等同 OPC 自身 |
| 启用（之后） | 直接 import（已信任） | 会 |

未启用的行只显示"代码在哪"，不显示"注册了什么工具"——因为那需要先把代码跑一遍。
这条规则也写在 UI 文案里，避免"看起来像扫描结果其实是执行结果"的误导。

## 2. 发现规则（与 Pi 对齐）

扫描根目录固定两个，顺序即优先级：

```
<home>/.pi/agent/extensions     全局
<project>/.pi/extensions        当前项目
```

每个根目录只看一层，支持三种布局：

| 布局 | 说明 |
| --- | --- |
| `name.ts`（或 `.js` / `.mts` / `.mjs` …） | 单文件扩展 |
| `name/index.ts` | 目录扩展，入口按 `index.ts → index.mts → … → index.cjs` 找 |
| `name/package.json` 里 `pi.extensions: ["./src/main.ts"]` | 清单扩展，`name` / `version` / `description` 从清单读 |

另外读 `~/.pi/agent/settings.json` 的 `extensions: [...]`（支持 `~/` 展开），pi 的全局安装列表
就记在这里。隐藏目录和 `node_modules` 跳过。

**id 是 POSIX 化的绝对路径**（`C:/Users/.../opc-demo`），而 `entry` / `dir` 保留原生路径。
这么做是因为 UI、`pi-extensions.json`、测试都在不同平台上比较 id，原生分隔符会让它们各自
`replace(/\\/g,'/')` 一遍；统一在扫描出口做一次更省事。**不要从 id 反推路径再去读文件。**

## 3. 装载：从 Pi 的 API 降到 pi-durable 的 API

两套 SDK 的扩展模型不一样：Pi 是命令式的（加载时调 `registerTool`），pi-durable 是声明式的
（`Extension` 是纯数据，由 registry 安装）。`apps/main/src/extensions/shim.ts` 负责翻译：

| Pi 侧 | OPC 侧 | 说明 |
| --- | --- | --- |
| `registerTool({ name, description, parameters, execute })` | `Extension.tools` | 参数 schema 两边都是 typebox，直接透传 |
| `on('tool_call', handler)` | `ToolTask.beforeTool` hook | `{block: true, reason}` 拦截；`{input}` 改写参数 |
| `on('session_start' / …)` | 无 | 记进 `unsupported`，UI 标"部分支持" |
| `registerCommand` | 无 | 只记录名字（命令面板还没有） |
| `registerProvider` / `registerShortcut` / `registerFlag` / `appendEntry` | 无 | 记进 `unsupported` |
| `ctx.ui.confirm/select/input/custom` | 无 | **fail closed**：`confirm` 返回 `false`，其余返回 `undefined`，并发一条 warn 诊断 |

Postel 原则：不认识的 API 不抛错，记一笔然后返回空函数——一个半支持的扩展仍然能贡献它的工具，
UI 也有足够信息告诉用户"它不是完整支持"。

### 模块解析

扩展目录通常不在 OPC 的 `node_modules` 链上，所以 jiti 会失败。三件事解决：

1. **`virtualModules`** 顶掉 `@earendil-works/pi-coding-agent`。真的包是 23.4 MB / 1279 文件的 CLI，
   而扩展只从里面拿几个类型和 `isToolCallEventType` 这类判断函数。顶一个 8 行的实现即可。
2. **`alias`** 把 `typebox`、`@earendil-works/pi-ai`、`@earendil-works/pi-durable` 指到 OPC 自己
   那份的入口文件。不能共用两份 typebox（`Type.Object` 生成的 schema 要靠 `Symbol` 认身份），
   也不能共用两份 pi-durable（`defineTool` 的实例检查会失败）。
3. 入口按 `__dirname` → `cwd` → `process.resourcesPath` → `app.asar` 的顺序找包根，覆盖
   dev、`electron .`、打包三种布局。

jiti 冷启动约 250 ms（实测），只在启用/文件变更时发生，不在热路径上。

## 4. 装进哪个位置

`WorkService.buildRegistry` 的安装顺序是安全边界，外部扩展排在最后：

```
coding-tools（essential）
opc.sandbox          ← 所有工具调用的唯一入口（路径/命令策略）
opc.limits
opc.image / speech / decision / ocr / memory / comm / decompose …
外部 Pi 扩展（pi.<slug>）   ← 最后
```

放最后意味着外部扩展自己的工具调用也要经过沙箱和调用上限；反过来（先装）它们就能绕过去。

外部扩展是**公司级**开关，安装给每个在岗员工；单个员工不想用，就在员工档案的工具策略里
关掉 `pi.<slug>`（复用已有的 `EmployeeToolPolicy.disabledExtensions`，没有新概念）。

开关变化后 `invalidateAllHarnesses()` 会清掉缓存的 harness——registry 在 harness 打开那一刻就
固定了，不清就等于要重启才生效。

## 5. 缓存与持久化

| 状态 | 位置 | 失效条件 |
| --- | --- | --- |
| 启用 / 已信任 | `<userData>/pi-extensions.json` | 用户操作 |
| 扫描结果 | 内存，2s TTL | 时间到了；`list()` / 开关强制重扫 |
| 已装载模块 | 内存，按 `id` | 入口、清单、目录三者 mtime 变了 |

mtime 取"入口 + 清单 + 目录"三者最大，所以只改 `package.json` 也会重新 import。
装载失败不重试（同一个 mtime 下），错误信息直接进 `view.error` 给用户看。

## 6. 已知边界

- **不是沙箱**。启用的扩展和 OPC 同等权限，这是信任框存在的唯一原因。
- **没有进程隔离**。Electron `utilityProcess` 是下一步；现在和 Pi 自己一样跑在主进程。
- **无交互式 UI**。`ctx.ui.*` 一律按取消处理，因为渲染进程 ↔ 扩展的桥还没建。
- **不支持 `pi install` 的包目录**。`~/.pi/agent/npm/` 之类要等 Pi 的解析器搬过来。

技能（`~/.agents/skills` 的 SKILL.md）走的是另一条路，见 `docs/skills.md`：纯文本，
不需要信任，也不会在这里被 import。
