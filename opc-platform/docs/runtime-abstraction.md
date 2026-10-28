# 运行时抽象设计（全局基础环境）

> 目标：为所有 Agent 员工提供**一套公司级基础环境**——统一的 Node / Python 解释器、PATH 与变量。
> 任何员工执行代码、任何验收命令，都走同一套环境解析，而不是各自碰运气。
>
> 本文只描述设计，不改变现有行为；实施按文末阶段推进。

---

## 1. 现状与问题

执行链路目前有三段，各自独立：

| 位置 | 现在做什么 | 问题 |
| --- | --- | --- |
| `apps/main/src/work/workService.ts:923` | `env: ({ cwd }) => new NodeExecutionEnv({ cwd })` | 只传 cwd；没有解释器、PATH、版本的概念 |
| `apps/main/src/work/exec.ts:42` | 把 `node` 映射到 Electron 二进制（`ELECTRON_RUN_AS_NODE=1`） | 只认 Node；验收命令无法换成 Python；Electron Node 没 npm，原生模块 ABI 也不同 |
| `apps/main/src/sandbox/extension.ts` + `workspaces.ts` | `bash` 命令套 `sandbox-exec` / `bwrap` | Linux 只 ro-bind `/usr`、`/bin`、`/lib`；Homebrew / pyenv / venv 里的解释器在沙箱内不可见 |

pi-durable 已经提供了正确的扩展点：

- `ExecutionEnv = FileSystem + Shell`（`@earendil-works/pi-durable/env`），`read/write/edit/bash` 全部经过它；
- `HarnessOptions.env(target, ctx)` 按 conversation 构建环境，`target` 带 `cwd`；
- `NodeExecutionEnv({ cwd, shellPath, shellEnv })` 的 `shellEnv` 会覆盖 `process.env` 后传给子进程。

所以不需要重写工具层，只需要**在环境构建处插入一层"基础环境解析"**。

---

## 2. 概念模型

```
公司基础环境（全局，设置页可见）
   Node   → 选定的 profile（系统 Node / nvm / 自定义）
   Python → 选定的 profile（系统 python3 / venv / conda）
        │
        ▼
RuntimeRegistry（探测 + 校验 + 缓存）
        │
        ▼
ResolvedRuntime（真正可执行的 binary / env / PATH shim / sandboxRoots）
   ├──▶ ExecutionEnv 工厂（bash / read / write / edit）
   ├──▶ runCommand（验收命令、git/npm 等）
   └──▶ prompt section（告诉模型当前环境与正确命令）
```

**全局意味着**：员工不需要、也不能各自选环境；换环境是管理员在设置里做一次的事，
下一次工具调用立即生效。这样也避免了"同一个任务里员工 A 能跑、员工 B 跑不了"的排查成本。

### 2.1 RuntimeProfile

「环境」不是枚举，而是**具名配置**：Node 有系统 / nvm / Volta，Python 有系统 / venv / conda。

```ts
export type RuntimeKind = 'node' | 'python';

export interface RuntimeProfile {
  id: string;              // 'node-system' | 'python-system' | 'rt-<uuid>'
  name: string;            // "Python 3.12 (.venv)"
  kind: RuntimeKind;
  /** 绝对路径；'' = 交给探测（内置 profile 用）。 */
  binary: string;
  /** 追加到 PATH 前面的目录（venv/bin、nvm/.../bin、conda env bin）。 */
  binDirs: string[];
  /** 覆盖到子进程的环境变量（VIRTUAL_ENV、PYTHONUNBUFFERED…）。 */
  env: Record<string, string>;
  /** 内置 profile 由代码提供，不可删除。 */
  isCustom: boolean;
}
```

内置 profile（代码定义，不落库）：

| id | 解析方式 | 说明 |
| --- | --- | --- |
| `node-system` | `which node` | 推荐默认；npm / 原生模块 / `node --test` 正常 |
| `node-bundled` | `process.execPath` + `ELECTRON_RUN_AS_NODE=1` | 系统没 Node 时兜底；只适合无依赖脚本 |
| `python-system` | `which python3` | 推荐默认 |
| `python-venv` | 用户选 `.venv/bin/python` | 自定义 profile 的常见形态 |

> 关键取舍：**Node 优先系统 Node**。Electron 自带 Node 的 `NODE_MODULE_VERSION` 与 npm 安装的原生模块不一致，
> 且不带 npm/pnpm；把它当项目运行时会在 `better-sqlite3`、`sharp` 一类依赖上炸得很隐蔽。

Node 和 Python **各自独立选择**，因为公司会同时存在两类任务；不存在"一个环境包打天下"。

### 2.2 ResolvedRuntime

探测之后、执行之前的结果，缓存 60 秒：

```ts
export interface ResolvedRuntime {
  profile: RuntimeProfile;
  kind: RuntimeKind;
  binary: string;                 // realpath，绝对路径
  version: string;                // '3.12.4' / '22.9.0'
  /** 已合并代理策略的运行环境。 */
  env: NodeJS.ProcessEnv;
  /** app 私有 shim 目录：保证 shell 里的 python/node 指向这个 profile。 */
  shimDir: string;
  /** 沙箱需要只读暴露的根目录（解释器前缀、venv、shim）。 */
  sandboxRoots: string[];
}
```

`shimDir` 是关键小设计：`bash` 执行的是 shell 字符串，`execFile` 也靠 PATH 解析。
只有把 `python` / `python3` / `node` 的符号链接放进一个**app 私有、模型不可写**的目录并置于 PATH 首位，
"指定的环境"才对所有执行路径一致生效。

- 目录：`userData/runtimes/<profileId>/bin`
- 内容：`python -> <binary>`、`python3 -> <binary>`；Node 侧同理，`npm`/`pnpm` 存在时才链
- 不把 workspace 放进 PATH，模型无法用同名文件劫持解释器

### 2.3 解析规则

```
该 kind 选定的 profile（用户设置）
   → 内置可用项（node-system / python-system）
   → node-bundled（仅 Node 兜底）
   → 不可用：任务启动前明确报错
```

没有"员工覆盖"和"任务覆盖"。环境是公司资产，作用域只有一处。

---

## 3. 数据与持久化

刻意做到**零表结构迁移**：基础环境是少量全局配置，直接复用 `app_setting`。

```ts
// app_setting 内的 JSON，和 compaction / proxy 的存法一致
runtime.profiles = RuntimeProfile[]   // 只存自定义 profile
runtime.active   = { node: string | null, python: string | null }
```

- 内置 profile 永远来自代码，升级不会留下脏数据；
- `active` 为 `null` = 自动选第一个可用项，与今天的行为一致；
- 删除自定义 profile 时同时清空 `active` 里的引用，避免悬空；
- 不需要 `employee` / `task` 新列，老库打开即用。

---

## 4. 执行集成

### 4.1 环境工厂（bash / read / write / edit）

```ts
// workService.harnessFor()
env: (target) => {
  const runtime = runtimeService.activeFor(kindOfConversation); // Node 或 Python
  return new NodeExecutionEnv({
    cwd: target.cwd ?? this.deps.paths.workspaceDir,
    shellEnv: runtimeService.envFor(runtime, this.deps.network),
  });
}
```

`env` 每次工具调用时构建，所以**设置里换了解释器立即生效**，不需要重启 Harness。

问题：一个 conversation 该用 Node 还是 Python？v1 采用**双环境共存**，不做"二选一"：

- `shellEnv` 同时把 Node 的 shim 和 Python 的 shim 放进 PATH；
- 模型写 `node` 或 `python` 都落到公司选定的版本；
- 验收模板决定用哪个（Node 模板跑 `node`，Python 模板跑 `python`）；
- 好处：员工中途做 polyglot 任务（Python 脚本 + Node 验收）不需要切换环境；
- 代价：两套 profile 都必须可用？不——按需解析，缺失的那个只在该命令失败时报错，
  并在设置页标红，不阻塞另一套。

`envFor()` 的合并顺序（后者覆盖前者）：

1. `network.childEnv()` —— 代理策略，唯一来源；
2. 清理继承的跨环境变量：`PYTHONHOME`、`PYTHONPATH`、`NODE_OPTIONS`（profile 可显式写回）；
3. **PATH = 所有启用 profile 的 shim + binDirs + 原 PATH**；
4. 各 profile 的 `env`；
5. Python：`PYTHONUNBUFFERED=1`、`PYTHONIOENCODING=utf-8`、`PYTHONDONTWRITEBYTECODE=1`；
   venv 额外 `VIRTUAL_ENV`、`PIP_REQUIRE_VIRTUALENV=true`（避免 `pip install` 污染宿主机 Python）；
6. Node bundled：`ELECTRON_RUN_AS_NODE=1`。

### 4.2 验收命令（`runCommand`）

`runCommand` 增加可选的 `runtime`：

```ts
runCommand(argv, { cwd, timeoutMs, env, network, runtime })
```

- 有 `runtime`：**不再**把 `node` 特判成 Electron；argv 原样 + runtime.env（PATH 里有 shim）；
- 无 `runtime`：保持今天的 Electron `node` 映射，零行为变化；
- `accept()` 按验收模板的 kind 取当前基础环境，验收和员工干活用同一套。

验收模板仍由系统持有（员工改不了）。P0 只接 Node 模板；P1 增加 Python 模板
（pytest / unittest + 非零退出码 + 至少一个用例），与 `VERIFY_NODE_TEST` 对齐。

### 4.3 沙箱

`SandboxPolicy` 增加 `readOnlyRoots: string[]`（来自所有启用 profile 的 `sandboxRoots`）：

- macOS `sandbox-exec`：默认 allow，只需保证 workspace 可写、`deniedReadRoots` 不可读，运行时天然可用；
- Linux `bwrap`：对每个 root 追加 `--ro-bind-try <root> <root>`；
  这解决了 `/opt/homebrew`、`~/.pyenv`、venv 在沙箱内"解释器不存在"的问题；
- 运行时目录**只读**；需要装包的场景，venv 必须建在 workspace 内（workspace 本来可写），
  网络仍受代理策略与 sandbox 双重约束，模型不能自己 `--unshare-net` 绕过。

### 4.4 让模型知道自己在哪

新增 `createRuntimeExtension()`（pi extension）：

- `sections`: 渲染当前基础环境，例如
  `基础环境：Node 22.9.0、Python 3.12.4（.venv）；Node 任务用 node，Python 任务用 python`；
- 模型不会在 Python 任务里写 `node server.js`，也不需要把这段塞进每个任务的 prompt；
- `HarnessBrain.buildPrompt()` 只保留任务语义，环境信息归运行时扩展。

### 4.5 代码位置

```
apps/main/src/runtime/
  types.ts          RuntimeProfile / ResolvedRuntime / RuntimeStatus
  profiles.ts       内置 profile + 自定义 profile 的读写（app_setting）
  detect.ts         which / realpath / --version 探测，带超时与缓存
  shims.ts          shim 目录生成（POSIX symlink；Windows 直接使用 binDirs / PATH）
  service.ts        RuntimeService：list / probe / active / envFor
  exec.ts           runCommand 的 runtime 分支（现在的实现留作 fallback）
  service.test.ts   真实临时目录 + 假解释器的探测 / shim / 持久化测试
```

`apps/main/src/work/exec.ts` 保留，内部委托给 runtime 模块；调用方签名只增不改。

---

## 5. IPC / UI

主进程：

- `runtime.snapshot()` → 内置 + 自定义 profile，附 `RuntimeStatus`（可用/版本/错误）
- `runtime.probe()` → 清空版本缓存并重新探测（设置页"重新检测"按钮）
- `runtime.chooseBinary(kind)` → 原生文件选择器
- `runtime.inspect(kind, binary)` → 保存前预览版本与 venv/conda 变量
- `runtime.saveProfile(draft)` / `removeProfile(id)` / `setActive(kind, id | null)`

渲染进程（**一个全局页面，不碰员工档案**）：

- **设置 → 运行时**：
  - 顶部两张卡：Node 当前版本、Python 当前版本，带可用状态；
  - 每个 kind 一个下拉：选择使用哪个 profile（内置项 + 自定义）；
  - 自定义 profile：选解释器 → 自动填 `binDirs`/`VIRTUAL_ENV` → 检测版本 → 保存；
  - 不可用时显示具体原因（路径不存在 / 无执行权限 / 版本探测超时）；
- 未配置时自动选第一个可用项，页面只做展示，不阻断任何现有流程；
- i18n 新增 `settings.runtime.*`，中英同步。

---

## 6. 失败与安全

| 场景 | 行为 |
| --- | --- |
| 解释器不存在 / 无执行权限 | profile 标记不可用；设置页标红；任务启动前报错「Python 环境不可用：<路径>」 |
| 版本探测超时（3s） | 标记不可用，不阻塞主进程 |
| 选定的 profile 被删除 | 回退该 kind 的第一个可用项，并记录一次 warning |
| 模型在 Python 环境跑 `node` | Node shim 仍存在（双环境），命令正常；若公司没配 Node，则失败并返回 stderr，prompt 已提前说明 |
| 恶意/错误路径 | 只接受绝对路径、必须是可执行文件；只能由用户通过原生文件选择器添加，模型无法写 profile |
| 装包 | venv 位于 workspace 时才允许；`PIP_REQUIRE_VIRTUALENV=true` 防止污染宿主机 |
| 沙箱 | 运行时目录只读挂载；workspace + tmp 可写；网络仍受代理策略与 sandbox 双重约束 |

---

## 7. 关于容器级隔离（结论：v1 不做）

我的建议是**先不做容器**，理由：

1. **已有隔离**：文件越界由 `seatbelt` / `bwrap` 管，出网由代理 + sandbox 管，
   容器在 v1 主要是重复建设；
2. **启动成本**：每次任务拉起容器是秒级开销，而当前任务是"分钟级、频繁重试"的模式，
   体验会明显变差；
3. **与现有模型冲突**：pi 的 `ExecutionEnv` 假设文件系统就是本机路径；容器需要路径映射、
   卷挂载、日志转发，会把一个 1 天的改动放大成 1-2 周；
4. **基础环境的真实诉求**：用户要的是"Node 22 / Python 3.12 / 这个 venv"，
   这是解释器问题，不是内核隔离问题。

但**接口要留缝**：`RuntimeProfile` 增加可选字段

```ts
backing?: 'local' | 'container';   // v1 只实现 local
```

`RuntimeService` 输出 `ExecutionEnv`，后续加 `DockerExecutionEnv` 时只多一个分支，
`bash/read/write/edit`、验收、prompt 全都不用改。

---

## 8. 分阶段实施

**P0 —— 全局基础环境（建议先做）**

1. `runtime` 模块：Node/Python 探测、profile 读写（app_setting）、shim、`envFor`；
2. `HarnessOptions.env` 接入（双环境 PATH）；
3. `runCommand` 支持 runtime，`accept()` 使用当前 Node 环境；
4. 设置页「运行时」：状态 + Node/Python 下拉；
5. 测试：env 合并顺序、PATH/shim、代理变量保留、legacy `node` 行为不变、探测失败降级。

**P1 —— 完整体验**

1. 自定义 profile（venv / conda / nvm）增删与检测；
2. Python 验收模板（pytest / unittest）；
3. 运行时 prompt section；
4. 沙箱 `readOnlyRoots` 与 Linux 验证。

**P2 —— 工程化**

1. 从 workspace 自动识别（`.venv`、`.nvmrc`、`pyproject.toml`）并建议 profile（仍作为全局建议，不自动改）；
2. 安装阶段（npm/pip）独立网络策略；
3. 容器 / 远程环境（`backing: 'container'`）；
4. 每环境资源上限（CPU/内存/进程数）。

---

## 9. 需要记住的取舍

1. **全局，不是员工级**：一处配置，所有员工共享；没有员工/任务覆盖。
2. **Node 优先系统**：内置 Node 只兜底，避免 npm 与原生模块的坑。
3. **Node 与 Python 共存**：PATH 同时挂两套 shim，不做二选一。
4. **零迁移**：全部落在 `app_setting`，不改 `employee` / `task`。
5. **容器留到 P2**：先把解释器与 PATH 这件事做对，隔离沿用现有沙箱。
