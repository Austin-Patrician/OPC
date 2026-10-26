# OPC Agent 工作台

本地优先的 **Electron 桌面应用**：一个"公司模拟器"的前端外壳与主进程骨架。
UI 1:1 还原 `../OPC Agent IM平台` 的 Figma 设计；业务按 `AI员工平台-完整方案设计-v1.0.md` 推进。

**当前阶段：G0 已通过**（Electron 骨架 + 原生模块 + 打包 + 持久化冒烟）。
不做 Web 端 —— 渲染层只由 Electron 主进程加载。

## 工程装配

```
opc-platform/
├── apps/
│   ├── main/src        Electron 主进程 + preload（Node 侧；所有系统能力都在这里）
│   └── renderer        React 19 界面（纯视图，只能通过 window.opc 访问主进程）
├── packages/shared     主/渲染共用的领域类型与 IPC 契约（无依赖）
├── electron.vite.config.ts   main / preload / renderer 三段构建
└── electron-builder.yml      三平台打包配置
```

**为什么根目录是"应用包"**：`electron-builder` 无法可靠跟随 pnpm 的符号链接布局，
所以 `.npmrc` 使用 `node-linker=hoisted`，并把 `better-sqlite3` / `sqlite-vec` 声明在
**根 `dependencies`**（它们必须进入安装包）。`apps/main`、`apps/renderer`、
`packages/shared` 只放源码，构建由根目录的 `electron-vite` 统一编排。

## 命令

```bash
pnpm install          # 会自动执行 electron-builder install-app-deps（按 Electron ABI 重编译原生模块）
pnpm dev              # electron-vite dev：主进程 + 渲染层 HMR
pnpm build            # 产出 out/{main,preload,renderer}
pnpm start            # 用构建产物启动 Electron
pnpm pack:mac         # 打 .app（arm64，未签名）
pnpm dist:mac         # 打 dmg
pnpm typecheck        # 三个包分别 tsc --noEmit
pnpm lint             # 一个根配置，含分层与进程边界规则
pnpm test             # vitest（只测纯函数）
```

无头验证（CI 友好，不弹窗）：

```bash
./node_modules/.bin/electron . --self-test        # G0 六项探针，输出 JSON，失败退出码 1
OPC_SMOKE=1 ./node_modules/.bin/electron .        # 真开窗口跑一遍 preload + IPC + 渲染
```

## 进程与安全边界

| 项 | 设置 |
|---|---|
| `contextIsolation` | `true` |
| `nodeIntegration` | `false`（渲染层 `window.require === undefined`） |
| `sandbox` | `true`（preload 因此必须是 CJS） |
| 暴露面 | 仅 `window.opc`（`app` / `chat` / `diagnostics`），IPC 入参在主进程校验 |
| 外链 | 一律 `shell.openExternal`，应用内不允许导航离开 |
| CSP | 打包态注入 `default-src 'self'`（禁止远程脚本/资源） |
| 单实例 | `requestSingleInstanceLock()`，避免两个写者争同一个 SQLite |
| 关闭 | `before-quit` 先释放 IPC 与业务服务 |

窗口 chrome：macOS 用 `hiddenInset` 保留原生红绿灯，Windows 用 `titleBarOverlay`，
Linux 暂用系统边框；应用内 42px 标题栏在 Electron 下自动隐藏装饰性红绿灯并让出原生按钮占位。

## 分层与全局抽象

```
app → pages → widgets → features → entities → shared      （由 ESLint 强制）
```

- 渲染层额外禁止 `electron` / `node:*` / `fs` / `better-sqlite3` / `sqlite-vec` / `@earendil-works/*`。
- 主进程禁止依赖 `react` / `@/**`；`packages/shared` 只允许纯类型与纯函数。

| 抽象 | 位置 | 扩展方式 |
|---|---|---|
| 主题（浅/深/跟随系统） | `styles/tokens.css` + `shared/theme` | 加 `[data-theme]` 变量组，组件零改动 |
| 字体 / 界面字号 | `[data-font]` + `FONT_SCALES` | 加一个选择器 + 一个 preset |
| 背景（渐变/网格/动态光晕/自定义图或 GIF） | `shared/ui/BackgroundLayer` | 加一个 `BackgroundKind` + CSS 类 |
| 多语言 | `shared/i18n`（zh-CN / en-US） | 加 `locales/xx.json` 并注册 |

主题切换只改 `<html>` 的 `data-*` 与 CSS 变量，不触发 React 重渲染；首帧由 `index.html`
内的 pre-paint 脚本回放偏好，无闪白。

## 数据层

```
shared/api/chatTransport.ts   渲染层唯一接口（快照 + 意图）
shared/api/ipcTransport.ts    经 window.opc 的主进程实现
apps/main/src/chat/*          主进程业务（当前为内存实现，Phase 0 换 SQLite）
packages/shared/src/ipc.ts    IPC 通道名、快照/入参/诊断类型
```

## G0 验证结果（打包后的 .app 内实测）

| 探针 | 结果 |
|---|---|
| SQLite（better-sqlite3 原生模块） | ✅ SQLite 3.53.4 · journal=wal · 写入回读 · quick_check=ok |
| sqlite-vec（向量扩展） | ✅ v0.1.9 · KNN 命中 rowid=1 · 从 `app.asar.unpacked` 加载 |
| pi-durable（跨重启持久化） | ✅ entry 在 Harness `close()` 后重开仍存在（entries=1） |
| 用户数据目录可写 | ✅ `~/Library/Application Support/OPC Agent 工作台` |
| 渲染进程隔离 | ✅ 窗口 `contextIsolation+sandbox`；渲染层 `require/process` 均为 undefined |
| 打包状态 | ✅ `app.isPackaged = true` |

端到端冒烟（打包态）：`window.opc` 存在 → 读 5 个会话 → 发消息 → 主进程快照回流（3→4 条消息）
→ 渲染层无 Node 能力 → 六项诊断全绿。

产物：`.app` 385 MB（Electron 基线）；渲染 bundle 约 415 kB / gzip ≈ 120 kB（已压缩）。

## Phase 0 第一个切片（已跑通）

> 老板派活 → 员工执行 → 系统自动判定 → 老板看到交付物（带证据）

| 环节 | 实现 |
|---|---|
| 派活 | 输入框「派活」→ 表单（交付物必填 + 预估 tokens + 指派）→ 写入 `task` 表 |
| 员工执行 | 每员工一个 pi Harness（`agents/<id>.sqlite`），逐条 step 写入 transcript；产出落在 `workspace/tasks/<taskId>/` |
| 文件边界 | 所有写入经 `resolveWithin`（拒绝绝对路径与 `../` 越界），暂不做容器 |
| 自动验收 | 检查脚本由系统写入 `checks/<taskId>/verify.mjs`（员工不可改），以工作区为 cwd 启动交付物并发起真实 HTTP 请求 |
| 证据 | `acceptance.evidence` = argv / 退出码 / stdout 尾部 / stderr / 耗时，随任务卡展示 |
| 账本 | `budget_ledger` 表已建（真实预留在下一片，脚本化大脑暂无 token 消耗） |
| 实时性 | 主进程广播 `work:taskChanged`，会话里同一张任务卡就地更新（open → running → accepted） |

验证（都在 Electron 里跑，dev 与打包态一致）：

```bash
# 正向：写 server.js → 起服务 → GET / 返回 ok → accepted
OPC_WORK_PROBE=1 ./node_modules/.bin/electron .
#   status=accepted verdict=pass exit=0 artifacts=server.js

# 反向：故意写错交付物 → 验收必须拒绝（证明门真的会关）
OPC_BRAIN_VARIANT=broken OPC_WORK_PROBE=1 ./node_modules/.bin/electron .
#   status=rejected verdict=fail exit=2  stdout: GET / -> "nope"

# 端到端（真窗口）：bridge → 建任务 → 执行 → 任务卡出现在会话里
OPC_SMOKE=1 ./node_modules/.bin/electron .
#   "task":{"status":"accepted","verdict":"pass","artifacts":1,"exitCode":0},"cardVisible":true
```

### Slice B：预算硬停（已跑通）

原则：**先预留、再执行、后结算**。派活被拒时不产生任务、不花钱。

| 机制 | 实现 |
|---|---|
| 双作用域 | 每次派活同时校验 `employee`（默认 30 万/月）与 `company`（默认 500 万/月） |
| 预留 | `reserved_tokens += est`，同事务写 `budget_reservation(active, expires_at)`；任一作用域不足即拒绝 |
| 结算 | 运行结束 `reserved -= est`、`used += 实际消耗`，写 `budget_ledger`；失败则 `release`（不扣费） |
| 硬停 | `used / limit ≥ hard_stop_at` → `is_stopped = 1` 并**锁死**；之后所有派活返回 `BUDGET_STOPPED` |
| 拒绝 | 主进程返回结构化 `{ ok:false, error:{ code, message, budget } }`，不是异常字符串 |
| 界面 | 派活弹窗显示「本月额度 / 可用 / 本次预估 → 派后剩余」，不足或已停用则按钮禁用并说明原因；员工档案里也有额度行 |

```bash
# 预留拦截 → 结算释放 → 硬停
OPC_BUDGET_EMPLOYEE_LIMIT=10000 OPC_BUDGET_PROBE=1 ./node_modules/.bin/electron .
#  firstOk=true  secondRefused=BUDGET_EXCEEDED
#  thirdAfterSettleOk=true  stoppedRefused=BUDGET_STOPPED
#  reserved: 6000 → 0，available: 4000 → 10000
```

端到端（真窗口）也会验证拒绝能到达渲染层：
`"budget":{"limit":300000,...,"available":294000},"refused":"BUDGET_EXCEEDED"`。

**预算这一片的口径**：脚本化大脑不消耗 token，所以 `used` 目前恒为 0——**预留拦截与释放是真的，
"按实际用量停用"的闸门要等模型接上后才会有数据触发**（`evaluateBudget` 的 warn/stop 已有 6 个单测）。
另外三处已知缺口：调整额度还没有界面（当前额度在首次创建时固化）、过期预留没有回收器、
停用只拦新派活、不会中断正在跑的任务。

### Slice A：真实模型 + 模型设置页（已跑通）

**能力边界（来自 `pi-ai` 源码，不是猜的）**

| 方向 | pi 支持 | 落点 |
|---|---|---|
| LLM | ✅ `ModelType: chat` + `completeSimple/streamSimple` | 默认大脑，写交付物 |
| Image | ✅ `ImageModel` + `generateImages()` | 设置页可选默认图片模型；生成管线下一片 |
| Video | ❌ 全库无 video 类型/接口 | 设置页明确写"pi 不支持"，不放假入口 |

**设置 → 模型**（`apps/renderer/src/features/models`）

- 左侧 provider 列表（内置 6 个预设 + 自定义 + 从 pi 导入），右侧编辑 `baseUrl / api / Key`。
- 两种 API 族：`openai-completions`（覆盖 DeepSeek / Moonshot / OpenRouter / Groq / 自建 relay）与
  `anthropic-messages`，走 pi-ai 的同一套 provider 抽象。
- **Key 用 Electron `safeStorage` 加密**（macOS Keychain / Windows DPAPI / libsecret），
  渲染层只能看到 `hasKey`，明文永不出主进程。
- 「测试连接」对 OpenAI 兼容端点是 `GET /models`，成功即把模型列表导入，供选择默认 LLM / Image。
- 「从 pi 配置导入」读取 `~/.pi/agent/models.json`（显式点击才执行）。

**模型大脑 = pi 的循环**（`apps/main/src/work/harnessBrain.ts`）

> 不手写 agent loop，也不嵌 `pi-coding-agent`（那是 CLI 应用）。循环本来就在
> `pi-durable` 里：给一个装了工具的会话 `submit()`，它会以 `pi.generation` /
> `pi.tool` 任务的形式自己跑"模型 → 工具 → 模型"，带 checkpoint、replay 策略和用量统计。
> 我们只负责给工作区、模型和目标。

- 每次尝试创建**一个属于该 durable 任务的会话**，`cwd` = 任务工作区；
  registry 装 `createCodingTools()`（read / write / edit / bash）+ 我们的任务定义。
- 模型用工具真的写文件、真的启动检查；验收脚本仍在工作区之外，模型改不到。
- 用量取 `harness.usage()` 的**增量**，计入 `task.tokens_used` → 预算结算。
- 主执行器抛错（坏 Key / provider 不可用）→ 回退脚本化大脑并在步骤里注明。

**A + B 的真实联动**（打包态实测）：

```
OPC_MODEL_PROBE=1 "…/OPC Agent 工作台.app/…"
  brain: model            # 真的调用了 test/deepseek-v4.1-flash-1017
  steps: 模型用量：in 143 / out 203 tokens
  status: accepted · verdict: pass · exit: 0
账本：budget_ledger → note=settled, tokens_in=346
预算：employee used=346, reserved=0（结算后预留归零）
```

**已知缺口**：provider 的模型条目 `cost` 记为 0（`/models` 不返回价格），所以账本记
token 不记金额；图片/视频生成管线未接。

### Slice D：验收反馈修复循环（已跑通）

员工不再"一次写错就失败"：验收不通过时，**系统把证据回传给大脑**，让它带着证据重写。

```
写文件 → 跑检查器 → 失败？把 (命令/退出码/stdout/stderr/上一版全文) 回传 → 重写 → 再验收
```

| 决定 | 理由 |
|---|---|
| 循环上限由大脑声明（模型默认 3，`OPC_MAX_ATTEMPTS` 可调） | 修复必须有界，否则一次坏任务能烧穿预算 |
| 检查器始终在工作区之外 | "修代码"永远不能变成"修测试" |
| 每次尝试**替换**产物记录 | 任务卡显示当前文件，不堆历史副本 |
| `attempts` 落库并在任务卡显示「修复 N 轮」 | 老板要知道这单是一次过还是返工的 |
| 模型失败（异常）→ 回退脚本化并注明 | 坏 Key 不能看起来像坏员工 |

验证（打包态）：

```bash
# 第一次故意写错，凭证据修复（确定性用例，不依赖模型）
OPC_BRAIN_VARIANT=repair OPC_WORK_PROBE=1 <app>
#   attempt1: 自动验收未通过：退出码 2
#   第 2 次尝试（上限 3）→ 根据验收证据修复：GET / -> "nope" → accepted（attempts=2）

# 一直错：3 次后停止，状态必须 rejected
OPC_BRAIN_VARIANT=broken OPC_WORK_PROBE=1 <app>   # status=rejected, attempts=3

# 真模型同样走这个循环
OPC_MODEL_PROBE=1 <app>   # accepted, 模型用量 in 143 / out 290 tokens
```

顺带修掉一个只在"应用开着时"才暴露的问题：**探针模式原本会被单实例锁挡掉**（第二个进程静默退出、
输出为空）。现在诊断/探针模式绕过锁，CI 里可以随时跑。

**D 的边界**：每次尝试新建一个会话（不沿用上一轮对话历史），修复靠"证据 + 上一版文件"
重新提交；如果要做"同一会话里连续修正"，把 `createConversation` 换成按 workTaskId 复用即可。

### Slice C：崩溃续跑 + 预留回收（已跑通）

执行不再是内存里的 promise，而是 pi-durable 的状态机：

```
produce ──▶ verify ──(未通过，还有次数)──▶ produce
                  └──(通过 / 次数用尽)──▶ terminal
```

| 机制 | 实现 |
|---|---|
| 阶段 checkpoint | 每个阶段结束 `runtime.commit()` 落盘；重启从最后一个 checkpoint 继续，不重头再来 |
| 业务状态先行 | 启动前先把 `task.status` 置 `running` 并写 `durable_task_id`，崩溃后能认领 |
| 启动对账 | `recover()`：`running` 有 durable id → 续跑；`open` 未启动 → 重新派发；`running` 无 durable id → 失败并释放预算 |
| 预留回收器 | 启动时 + 每 10 分钟：任务已终态/丢失，或超过 `expires_at` 的 active 预留，一律释放 |
| 任务定义注册 | Harness 的 registry 安装 `opc.work` 扩展（含 `WorkTaskDefinition`），否则续跑会 `blocked: missing_task` |
| 用量随任务持久化 | `task.tokens_used` 逐次累加，续跑后结算仍按真实消耗扣费 |

```bash
# 启动 → 3 秒后 kill -9（模拟崩溃）→ 重启续跑（dev 与打包态都验证过）
(OPC_CRASH_PROBE=start OPC_BRAIN_SLEEP_MS=6000 <app> &) ; sleep 3 ; kill -9 <pid>
OPC_CRASH_PROBE=resume <app>
#   runningBeforeRecovery: 1
#   status: accepted · attempts: 1 · exitCode: 0
#   resumedSteps: ["启动恢复：从 durable checkpoint 继续"]
#   orphanReservation: "released"     ← 孤儿预留被回收器释放
```

**过程里修掉的真实问题**（都是"只有真崩溃才暴露"的）：
1. `waitForTask` 在任务不在本进程 live 集合时会**立刻返回当前记录**（不是终态），直接读
   `state.outcome` 会崩——改成轮询到 `state.status === 'terminal'`。
2. 续跑早期把任务标成 `rejected` 后，durable 任务仍在后台继续跑 → 状态与事实不符。
3. `TaskId` 是品牌类型，落库要 `String()`、读回要显式断言，否则续跑找不到任务。
4. 崩溃前已创建但从未启动的任务会永远 `open` 并占着预留 → 对账逻辑补了"重新派发"分支。

**C 没做的**：checkpoint 粒度是"阶段"，模型请求本身不能从中断处续（会重新请求一次，
因此可能重复计费）；回收器是 10 分钟轮询，不是精确过期。

### 沙箱：作为 pi extension 实现（macOS / Linux，Windows 不支持）

用 pi 的扩展机制，而不是在工具外面包一层：`hook(ToolTask, { beforeTool })` 是**所有工具调用的
唯一入口**，安全策略放在那里才不会被绕过。

| 项 | 实现 |
|---|---|
| 后端选择 | macOS `sandbox-exec`（Seatbelt）· Linux `bwrap`（bubblewrap）· Windows 明确 `none` 并**拒绝执行** |
| 路径策略 | `read` / `write` / `edit` 的 `path` 必须落在该会话登记的工作区内，越界直接 `block` |
| 命令策略 | `bash` 的 command 被改写成 `sandbox-exec -f <profile> /bin/sh -c '…'`（Linux 换成 bwrap） |
| 文件写入 | 只允许工作区 + `/private/tmp`、`/private/var/folders`（Node 需要 scratch） |
| 敏感读取 | 拒绝 `~/.ssh`、`~/.aws`、`~/.pi`、`~/.config`、Keychains、应用数据目录 |
| 出网 | `deny network-outbound`：阻断外传，但保留本地 bind/inbound（开发服务器能起来） |
| 失败策略 | 没有后端、或会话未登记工作区 → **fail closed**（拒绝执行），不裸跑 |

自检探针（真跑，不是模拟）：

```
OK | sandbox | sandbox-exec · backend=seatbelt · 越界写入 exit=1（已阻止） · 工作区写入 exit=0
```

真模型跑完整链路（打包态）：`accepted`，`模型用量：20000 tokens`。

**顺带发现并修掉的成本 bug**：接上沙箱后一次 hello-world 从 1.5k tokens 飙到 **99k**——模型在
"write → read → edit → `node --check`"里反复打转，每轮都重发整段上下文。加了一个
`opc.limits` 扩展，把单会话工具调用限制在 12 次（超限时返回一条工具结果让模型收尾），
token 降到 **18–20k**。

### 设置页（四个页面按设计稿重做）+ 模型图标

结构照 `OPC Agent IM平台/src/components/settings` 还原：220px 分组导航（可展开子菜单）、
880px 内容列、底部「修改后自动保存」。

| 页面 | 对齐设计稿的内容 |
|---|---|
| 通用 · 外观与语言 | 主题卡（带三格缩略预览 + 选中态）/ 界面字号 / 字体 / 壁纸（含 URL 与上传）/ 语言 / 恢复默认 |
| 通用 · 工作区与压缩 | 当前大脑模型 + 上下文窗口；自动压缩、触发阈值（给出按窗口计算的推荐值）、保留最近、后台提前量 |
| 模型 · LLM | 「默认模型」卡（分组下拉 + 思考强度）+「模型服务商」双栏：236px 分组列表（搜索、图标、状态点）＋ 详情（凭据 / Base URL / **模型列表：名称 + ID + 推理与视觉徽标 + 上下文 + 悬浮「设为默认」**） |
| 模型 · Image | OpenRouter 图像 Provider 卡 + 厂商筛选 chips + 图像模型列表（与设计同构） |
| 自检 | 7 项现场探针 |
| 关于 | 应用卡（渐变图标 + 版本）/ 版本信息表 / pi 项目三链接 |

**Provider 目录直接取自 pi 内置目录**（`shared/providers/catalog.ts`，18 个精选 Provider、
模型名/上下文/推理/视觉标记与 pi 一致）。列表里点「设为默认」或填 Key 时，才会把该 Provider
写进本地库（含模型与上下文窗口），所以 UI 与运行时是同一份事实。

**思考强度**不是摆设：`defaultThinkingLevel` 存进主进程设置，`HarnessBrain` 建会话时作为
`agent.thinkingLevel` 传进 pi。

**压缩是真的接上去的**：`compaction.enabled / reserveTokens / keepRecentTokens /
backgroundTokens` 存进 `app_setting`，每次打开 Harness 时透传给
`settings.compaction`；模型条目里的 `contextWindow` 也真的进入 provider 的模型定义
（压缩阈值与 `maxTokens` 都以它为准），不再是写死的 128k。

**Image 页的品牌图标**：图像模型都走 OpenRouter，但每行按**厂商**显示图标
（`vendorProviderId('ByteDance Seed') → bytedance`），没有图标的厂商回退成品牌首字母；
「在 LLM 中查看」会真的跳到 LLM 页并选中 OpenRouter。

**按钮不再被挤成竖排**：`buttonClass` 统一加 `shrink-0 + whitespace-nowrap`，输入框用
`min-w-0 flex-1`。smoke 会断言保存按钮尺寸是 `49×30`（横向）。

**Provider 图标（38 个）**：放在 `apps/renderer/public/provider-icons/`，由
`shared/providers/visuals.ts` 统一解析（别名、`-color` 后缀、前缀匹配、首字母兜底），
`<ProviderMark providerId size />` 是全站唯一入口 —— 以后聊天气泡、模型选择器、员工档案
要显示 provider，直接复用，不用再拼一次路径。

> 踩到的坑：图标路径必须是**相对路径**（`./provider-icons/…`）。打包后渲染层走 `file://`，
> 绝对路径 `/provider-icons/…` 会指向文件系统根目录，图标全部 404 且静默降级成首字母。

**顺带修掉的恢复问题**：3 个任务在旧版本里卡在 `running`，它们的预留一直占着额度。
现在启动对账多了两道保险：durable 任务**最多等 60 秒**（超时标失败），以及「10 分钟无进展的
running 行」清扫。验证后 `running=0`、`active 预留=0`。

### E：价格表 + 图像生成

**价格（USD / 1M tokens）**

- LLM 页每个 Provider 下方新增「计费单价」表：逐模型填 `in / out`，存进模型条目。
- 运行时把单价写进 `ModelCost`，`HarnessBrain` 用**输入/输出增量 × 单价**自己算钱（不依赖 provider 是否上报 cost）。
- 金额随任务持久化（`task.cost_usd`），结算写进 `budget_ledger.cost_usd`，任务卡直接显示 `$0.0004`。
- 打包态实测：一次 2038 tokens 的运行 → 账本 `cost_usd=0.000352`。

> 踩到的坑：`clamp()` 里带了 `Math.round`，把 0.14 的单价取整成 0，账本一直是 0。
> 定价这种小数不能用整数 clamp。

**图像生成**

- 主进程 `generateImage()`：`POST {baseUrl}/images/generations`（OpenAI 兼容），支持
  `b64_json` 与「只返回 url 再下载」两种返回；产物写入 `userData/images/`，返回 data URL 供即时预览。
- Image 页新增「生成图像」：提示词 + 生成按钮 + 预览（显示模型与字节数）；未配 Key / 未选模型时给出明确原因。
- **验证方式**：4 个集成测试跑在本地 mock HTTP 服务上——b64 解码、url 回退下载、HTTP 500 透传、
  非 JSON 拒绝；全部在 `pnpm test` 里。

### B 片：负责人拆解 + 三条硬约束

| 机制 | 实现 |
|---|---|
| 任务树 | `task.parent_task_id` + `depth`（老板派的活 depth=0） |
| 拆解工具 | `decompose_task(subtasks[])`，**只装在"有直接下属"的负责人身上**（`position.reports_to` 决定） |
| 硬约束 1 深度 | `parent.depth + 1 >= maxDepth(3)` → `DECOMPOSE_DEPTH` |
| 硬约束 2 扇出 | 子任务 > 5 → `DECOMPOSE_FANOUT` |
| 硬约束 3 预算守恒 | Σ子任务预估 > 父任务剩余（est − used）→ `DECOMPOSE_BUDGET` |
| 汇报线 | 子任务接收人必须是负责人的直接下属 → `DECOMPOSE_NOT_SUBORDINATE`；派给自己 → `DECOMPOSE_SELF` |
| 子任务 | 走**同一条** pi 循环 / 验收 / 预算，创建后立即派发（不需要再点一次） |

```bash
OPC_DECOMPOSE_PROBE=1 electron .
#  created: ["韩梅梅:写页面@1"]          ← depth 1
#  refusals: subordinate=DECOMPOSE_NOT_SUBORDINATE · fanout=DECOMPOSE_FANOUT
#            budget=DECOMPOSE_BUDGET · self=DECOMPOSE_SELF · depth=DECOMPOSE_DEPTH
#  children: ["写页面:accepted"]         ← 子任务真的跑完并验收
```

**子任务树（已补）**：父任务卡里出现「N 个子任务 ▸」，展开后按行列出子任务（标题 / 负责人 / depth /
状态），并显示 `已完成/总数`。数据来自 `work:subtasks`，按需加载。

**组织架构页（对齐设计稿）**：目录 220 → 工具栏（**四视图切换** + 面包屑 + 缩放）→ 视图 → 详情 336。

| 视图 | 形态 |
|---|---|
| 组织视图 | **画布**：点阵背景、拖拽平移、缩放 60–140%；CEO 根卡（320）→ 竖干 → **共享横向总线** → 每个部门一根下引线（设计稿同款连接线）；部门卡 248 宽、可折叠 |
| 项目视图 | 横向看板（成员卡 hover 有 **1v1 私信**、列头有**部门群**入口），照设计 1:1：部门列 280（范围外 220、`opacity-70`）、列头色块+人数+`负责人 X · $日薪/d`、成员卡（头像/姓名/等级/负责人标/岗位/模型行/状态胶囊+日薪+单量）、**拖拽调岗**（悬停高亮 + "松开即调岗至「X」"占位）、列底 **「＋ 增聘 Agent 员工」**、范围外的列自动滚到视口居中 |
| 名单 | 表格：成员 / 岗位 / 部门 / 汇报对象 / 在跑任务 / 累计 tokens（表头粘性） |
| 名片墙 | `repeat(auto-fill, minmax(216px,1fr))` 网格名片 |

- **员工档案照设计重做**：部门色渐变头图 + 叠压头像（可点击上传）→ 姓名/等级/负责人标 → 状态胶囊 + 部门色标签 →
  **汇报关系链**（CEO → 上级 → 当前，竖线连接，"当前"标记）→ **履职数据三格**（累计交付 / 算力日薪 / 入职）→
  **底层模型与工具链** → **技能栈** → 岗位职责（persona）→ **人事操作**（调岗下拉、汇报对象下拉、解雇二次确认）；
  部门档案同理：色块图标 + 名称 + 编号 + 描述 + 增聘按钮 → 部门指标四格 → 负责人行 → 成员行（可点进员工档案）；
- **聊天入口是真的**：`chat.openDirect(employeeId)` 首次使用就建 1v1（复用已有），
  `chat.ensureDepartmentGroup(departmentId)` 按当前编制建部门群并复用；两个入口从看板成员卡、列头、
  员工档案、部门档案都能进，落到 `#/chat/<id>`；
- **画布支持触控板/滚轮缩放**：`⌘/Ctrl + wheel`（非 passive 监听，屏蔽页面缩放），缩放条在右下角；
- **员工档案齐全**：头像（可上传，128px 裁剪后存 data URL）、入职时间、状态、底层模型、技能栈、
  **汇报关系**（上级 + 下属名单）、**履职数据**（已完成交付 / 在跑任务 / 累计 tokens / 当日算力花费）；
  `costTodayUsd` 来自任务账本（`COALESCE(finished_at, created_at)` 落在今天的 `cost_usd` 求和），不是编的日薪；
- **人事操作合并成一个入口**：`org.personnel({action})` 支持 `transfer`（调岗到部门）、`set-manager`（换汇报对象/取消）、
  `terminate`（离职）、`reinstate`（复职），右栏一个下拉搞定，不再散落成按钮；
- **画布缩放真的生效**：外层按 `自然尺寸 × zoom` 预留空间，内层 `scale`，所以放大不再只是像素拉伸；
  缩放条固定在**右下角**（设计同款），**左下角**是状态图例（在岗 / 执行中 / 离职 + 有任务在跑的部门数）；
- **名单表可滚动**：表头 sticky，`min-h-0 + overflow-auto` 在面板内滚动；
- **部门卡补齐细节**：成员状态小圆点（在岗/离职）、**技能标签**（`employee.skills`，由 demo 迁移回填）、
  **按汇报线缩进的成员树**（负责人 → 下属可折叠）；
- **"未分配"不再是部门**：它其实是"没有岗位的人"，所以移到 **人才市场**（`/market`）的
  「待安置」池里，组织图不再被它占位。`org.unplaced()` / `org.place()` 支持一键安排回部门（自动恢复在岗）；
- **页面骨架**（照设计 1:1）：
  - **第一行**：`HR 组织架构图 (N人)` / `Agent 人才聘用市场` 两个模式 tab，右侧 `+ 新增部门`、`自定义招募 Agent 员工`；
  - **第二行**：左侧 `组织目录`（可**收起**的侧栏：部门色块标签 + 人数 + 编制概览）｜中间 canvas（顶部视图 tab、范围面包屑、
    状态下拉改成分段计数、搜索、缩放）｜右侧**只在 canvas 上点击时**出现的 `部门档案` / `员工档案`；
  - **左目录点击的语义按视图区分**（照设计）：**树视图**只剩选中部门（`scopeDept ? [scopeDept] : 全部`）；
  **看板 / 名单 / 名片墙**仍渲染**全公司**，选中的部门高亮（ring / accent 行底），其余部门降透明度并标注
  **「不在当前查看范围」**，顶部提示「正在聚焦「X」，其余部门显示为不在当前查看范围」；
- **部门标签颜色互不相同**：`DEPARTMENT_COLORS` 调色板，`createDepartment` 取第一个未被占用的颜色，
  `ensureDistinctColors()` 启动时修复历史同色数据（首个保留）；
- **右栏点 X 关闭后中间占满全宽**（`panelBeforeClick=false → 点卡片 true → 关闭 false`）。
- **左侧组织目录**照设计改成**树形**：`OPC 一人公司`（蓝色图标）→ 缩进 + 左侧竖线的部门列表（色点/人数），
  点击切换范围；底部是**编制概览卡**（部门数、在岗大数字、按部门着色的堆叠条、在岗/离职计数）；
- **工具栏**：四视图 tab、面包屑、搜索、**状态下拉（全部/在岗/离职）**、树视图的缩放、右侧「招聘」；
- **自定义招募是真向导**（`HireWizard`，4 步：身份 → 汇报线 → 能力 → 确认）：
  姓名/岗位/职级/部门 → 汇报对象/是否负责人 → 模型/技能标签/岗位职责 → 汇总提交；
  技能与职责落 `employee.skills` / `employee.persona`，**职责真的进 prompt**（`buildPrompt` 前置注入）；
- **市场「待聘」= 本地 Agent 包导入**：`market.importPackage`（文件选择器，`.json`）走
  `parseAgentPackage` 校验（`format: 'opc-agent-package@1'`，缺 name/role 的条目丢弃，空包报错），
  命中后进 `agent_candidate` 表；「聘用入职 →」直接建 employee（带技能/职责）并从市场移除；
- 详情面板（336）：选中成员看档案，未选中看部门概览 + 成员列表。

视图选择持久化在 `opc.org.view`。

打包态 smoke：`views: 4`、`canvas: true`、`tree members: 15`、`roster: 15`。

**还没做的**：
"模型自己决定拆解"这条路径已接线（工具 + 提示），本轮验证走的是服务层直调，没跑真模型拆解。

### 组织落库：部门 / 岗位 / 汇报线（A 片）

组织不再是占位页，也不再只存在于 demo 数据里：

| 表 | 作用 |
|---|---|
| `department` | 部门（名称/编号/描述/负责人） |
| `position` | 员工在哪个部门、什么岗位、**向谁汇报**（软删除保留历史） |
| `employee` | 已有，加上了 `status`（`active` / `terminated`） |

`OrgService` 提供 `list / createDepartment / hire / transfer / fire`：

- **hire**：一个事务里写 employee + position + 预算，`isHead` 会把部门负责人一起更新；
- **transfer**：旧 position 软删除 + 新 position，`employee.department_id` 同步；
- **fire**：`status=terminated`、position 软删、**在跑任务取消并释放预留**——离职员工不能继续花钱；
- 派活侧加了一道闸：`createTask` 只接受 `active` 员工，离职后返回结构化
  `ASSIGNEE_UNAVAILABLE`（而不是抛异常）。

组织页（`/org`）是真实视图：左侧部门（人数）、右侧成员表（岗位/汇报对象/在跑任务/调岗/解聘）
+ 招聘表单；首次启动会把 demo 员工**按岗位安放到部门**（幂等，不产生重复员工）。

```bash
OPC_ORG_PROBE=1 electron .
#  departments: [研发部(4), 增长情报部(1), 交付部(0), 未分配(4)]
#  dispatched: true · taskStatus: accepted
#  afterFireRefused: ASSIGNEE_UNAVAILABLE（员工不在岗: agent-…）
```

打包态 smoke 也断言了组织页：`orgMembers: 4`、`orgDepartments: 7`。

### 全量接入 pi 的 Provider 目录

| 项 | 数据（来自 `pi-ai` 生成目录） |
|---|---|
| Provider | **42**（全部列出，不再是手挑的 18 个） |
| 文本模型 | 1599 |
| 图像模型 | 63 |
| 分类模型 | 51 |
| API 类型 | **14**：anthropic-messages / openai-completions / openai-responses / azure-openai-responses / bedrock-converse-stream / google-generative-ai / google-vertex / mistral-conversations / openai-codex-responses / pi-messages / openrouter-images / typesafe-system-one / cloudflare-workers-ai-system-one / openai-decisions |

主进程 `models/catalog.ts` 把整个目录拍平成 `{provider, apis, counts, models, price}` 暴露给 UI；
运行时 `apiFor(kind)` 把每种 API 映射到 pi 自己的 lazy 实现，并按 `model.api` 组成
`Record<api, ProviderStreams>`，所以**混合 API 的 provider 也能工作**，不再只有两种。

「添加 Provider」改成 **modal**（名称 / ID / Base URL / API 类型），API 下拉直接来自目录里的
14 种，而不是硬编码两项。

**OAuth 登录（已接入）**

- 凭证存储：`apps/main/src/models/credentialStore.ts`，`userData/credentials.json`，
  每 provider 一个凭证、写操作串行化、tmp+rename 原子落盘、文件权限 0600。
- 登录流程交给 pi：`models.login(providerId, 'oauth' | 'api_key', interaction)`，
  pi 负责 PKCE / 设备码 / token 交换；我们只实现 `interaction`——
  `prompt()` 转发到渲染层弹窗（text / secret / select / manual_code），
  `notify()` 里的授权 URL 由主进程 `shell.openExternal` 打开并显示在面板上。
- OAuth 实现来自 pi 的 `builtinProviders()`（Claude 订阅、Copilot、Codex 等），
  按 provider id 挂到我们的 provider 定义上；`Models` 用同一个凭证存储解析请求。
- UI：Provider 详情里「OAuth 登录 / 用 API Key 登录 / 退出登录」，带状态与提示。
- 读 Key 时先看我们加密的 SQLite 列，再回落到 pi 的 `credentials.json`，两条路径都能用。

> 验证边界：凭证存储有 4 个真实文件读写测试；登录的**交互桥**与 IPC 面已打通，
> 但真正的 OAuth 往返需要 provider 账号 + 浏览器授权，本机无法端到端验证。

### 定价：用 pi 的完整成本模型

- 常用模型改成 **表格**：名称 / 上下文 / 输入 / 输出 / 缓存读 / 缓存写 / 默认，
  价格直接从 pi 目录预填，**单元格内即可修改**（首次编辑会把该 Provider 落库）。
- 数据来源优先用 pi 内置目录（`getBuiltinModel().cost`，含 `cacheRead/cacheWrite` 与
  `tiers.inputTokensAbove`）。Provider 详情里有「用 pi 官方价格」一键写入。
- 运行时把完整 `ModelCost` 交给 pi，**金额优先取 pi 自己算的 `usage.cost.total`**
  （它会应用缓存价与分档），只有 provider 没价格时才回退到我们的简单算术。
- 头部文案改成「已列出 18 个精选 Provider，pi 共内置 41 个」，不再把 41 当成已接入数量。

**峰谷价（DeepSeek 按时间段折扣）目前表示不了**：pi 的 `ModelCost` 只有 token 维度
（输入/输出/缓存 + 上下文分档），没有时间维度。要支持只能由我们自己记账（按请求时间戳选费率），
这会绕开 pi 的成本聚合，需要单独设计——已作为已知缺口记录，没有假装支持。

### 自定义 Provider（做 `generate_image` 工具之前必须先有）

原先的两个硬编码已经拆掉：

| 位置 | 之前 | 现在 |
|---|---|---|
| LLM 页 | 只有 pi 目录里的 18 个 Provider，无法添加自定义端点 | 底部「添加 Provider」→ 内联表单（id/name/Base URL/API），可填 Key、手动加模型、设默认、删除 |
| Image 页 | 写死 OpenRouter + 静态目录 | 列表来自**数据库里所有 `capability: 'image'` 的模型**，可按 Provider 筛选、手动添加、删除、设默认 |
| ImageService | 默认 provider 写死 `openrouter` | 从 `defaults.image` 解析；任何配好 Key 且拥有 image 模型的 Provider 都能出图 |

OpenRouter 的 63 个图像模型只作为**一次性种子**写入数据库（`IMAGE_MODELS`），之后一切以配置为准，
自定义图像端点与它完全平等。图标仍按模型自身品牌显示（`openai/gpt-image-1` → OpenAI 图标）。

**为什么这步在工具之前**：`generate_image` 工具需要回答"用哪个 provider、哪个模型"。如果图像
provider 还写死，工具就只能服务一种后端。现在工具只需要读 `defaults.image` + 该 provider 的
Base URL/Key，逻辑与设置页完全一致。

### `generate_image` 工具 + Image 页对齐 LLM

工具（`apps/main/src/work/imageTool.ts`）：

- `defineTool` + TypeBox schema：`prompt`（必填）、`filename`（可选，默认时间戳名）；
- 通过 `api.env.writeFile()` 写进**任务工作区**，所以产物自然进入 artifact / 验收 / 交付物卡；
- 文件名扁平化（目录被剥掉、补 `.png`），防止模型用 `../../etc/passwd` 逃出工作区；
- 仅在存在「有 Key 且拥有图像模型」的 provider 时才注册，避免给模型一个必然失败的工具；
- 3 个单测覆盖：写入并回显、路径扁平化、失败返回 `isError` 而不写文件。

协议：图像模型带 `api` 字段，支持 `openai-images`（OpenAI 兼容 `/images/generations`）与
`openrouter-images`（pi 原生）。目前两者都走同一 HTTP 管线（pi 的 image API 需要 OpenRouter
OAuth/Key 才能实跑），UI 里可以看到并选择模型所用的协议。

Image 页改成与 LLM 一致的**左 Provider / 右模型表**：

- 左侧只列「拥有图像模型」的 Provider（图标 + 模型数 + 凭证状态点）；
- 右侧顶部是生成区块（提示词 + 生成 + 预览），下面是模型表（名称+品牌图标 / 协议 / 默认 / 删除）；
- 模型表 `max-h-22rem` + 内部滚动 + 粘性表头，**卡片不会被模型数量拉长**；
- 表下是「添加图像模型」：模型 id + 协议下拉；
- 顶部「添加 Provider」复用同一个 modal，自定义图像端点添加后即出现在左侧。

**图像任务的验收（按你的口径）**：只要"图片能通过 HTTP 以 200 返回"就算通过，质量交给模型判断。

- 第二个系统检查器 `VERIFY_IMAGE_200`：在任务工作区里找一个 `png/jpg/webp/gif`，起一个
  本地静态服务，`fetch` 它，断言 `status === 200` 且 `content-type` 以 `image/` 开头；
- 派活弹窗新增「验收模板」：`HTTP 服务返回 ok` / `图片可访问（200）`，随任务落库
  （`task.acceptance_template`），verify 阶段按模板写入对应检查器；
- 独立验证过（不依赖模型）：有 PNG → `PASS image-200`（exit 0）；空目录或只有文本 →
  `FAIL 工作区没有图片文件`（exit 1）。

**全局默认生图模型**：Image 页顶部新增一个 `default.image` 选择器（按 Provider 分组列出全部
图像模型），它同时驱动设置页的"生成"按钮和 Agent 的 `generate_image` 工具——不再只能靠行内
「设为默认」猜。

**端到端验证（本地 mock 图像端点，不需要真 Key）**：

```
OPC_IMAGE_LOOP_PROBE=1 electron .
  status: accepted · verdict: pass · template: image-200 · exit: 0
  artifacts: ['icon.png (70B)']
  steps: 交给 pi 循环 → 模型用量 7599 tokens · $0.0022 → 自动验收通过
```

即：派图片任务 → 模型自己调用 `generate_image`（写进工作区）→ 系统起本地静态服务
`fetch icon.png` 拿到 200 + `image/png` → 通过 → artifact 与金额进账。

**交付物预览：网格 + 大图 + 下载**

- 图片 artifact 以**网格**呈现（1 张单列、多张 2–3 列，`max-h-48`），非图片仍是文本 chip；
- 点缩略图打开**大图查看器**（`max-h-[80vh]`，Esc / 点背景关闭，底部显示文件名与字节数）；
- 查看器里的「下载」走 `artifacts:saveAs`：原生保存对话框 + 文件复制，`file://` 下也可靠；
- 读取仍经过 `artifacts:read` 的守卫：路径越界拒绝、扩展名白名单、8MB 上限。

> 验证：`artifacts:read` 的守卫有 4 个单测（含 `../../etc/passwd.png` 越界）；
> 读取路径曾在打包态 smoke 中实测 `thumbnailOk: true`。`saveAs` 会弹系统保存框，
> 无法在自动化里点，故只做了类型与接线验证。

**还没做的**：图像生成的线上行为仍需真实图像 Key（本机只有 mock 服务的测试证据）；
`openrouter-images` 尚未走 pi 原生实现。

**沙箱的边界（必须说清楚）**：Seatbelt 不是虚拟机，仍与宿主共享内核；没有 CPU/内存配额；
Linux 的 bwrap 路径只做了 argv 构造与单测，**未在真机验证**；`sandbox-exec` 已被 Apple 标记弃用；
出网是"全有/全无"，还没有域名白名单代理。

## 打包过程中修掉的两个真实问题

1. **sqlite-vec 在打包后无法 `dlopen`**：`require.resolve` 指向 `app.asar` 内部，改成指向
   `app.asar.unpacked` 后才可用（`apps/main/src/data/sqliteVec.ts`）。
2. **渲染层未被压缩**：`electron-vite` 默认不压缩 renderer，产物 665 kB 未压缩；
   显式开 `minify: true` 后降到 263 kB（react chunk）。

## 已知取舍 / 未做

- macOS 未签名（无 Developer ID）：本机可运行，分发前需签名+公证。
- 未设置应用图标；Windows/Linux 的打包尚未实机验证（配置已就绪，`--win`/`--linux` 待 CI）。
- 应用体积未裁剪（Electron 多语言资源可裁到 ~200 MB）。
- HR 组织架构 / 人才市场 / 频道等页面仍是占位页，等 Phase 0 的数据契约。

## 下一步：Phase 0（设计文档 §1.4 唯一验收标准）

> 老板派一个活 → 员工干完 → 系统自动判定"真的干完了" → 老板看到交付物并认可。

范围（不含组织/记忆/市场）：

1. `company.db` 建必要表：`company` / `employee` / `position` / `task` / `artifact` /
   `acceptance` / `budget` / `budget_ledger` / `employee_run`（按 §4 的 DDL 裁剪）。
2. 派活表单（交付物 + 验收标准 + 预估 token）+ `Task` 状态机 + 原子签出。
3. 每员工一个 `agents/<id>.sqlite` + `Harness`（本 G0 已验证其持久化能力），工具集先给
   `read/write/edit/run_command`，命令在 workspace 内执行。
4. 自动验收：跑命令看退出码 + 收集证据；预算预留→结算→硬停。
5. 崩溃恢复：杀进程重启后 `harness.resume()` 继续未完成 run。

## 通信与唤醒：inbox / 配额 / 心跳（F5、F6、P5）

员工不再"只有被派活才动"。四张表 + 两个服务把「有自己的节奏」落成可审计的状态：

| 表 | 作用 | 关键约束 |
|---|---|---|
| `inbox_item` | 下班后要处理的事 | `priority` 0..3；同一来源只能排队一次（部分唯一索引）；`requires_wake` 绕过心跳 |
| `wake_quota` | 每人每天的唤醒配额 | `(employee_id, quota_date)` 唯一，跨日自动重开 |
| `guard_event` | 每一次"被拒绝"都留痕 | 配额耗尽 / 频率超限 / 无法回答，老板看得到沉默的原因 |
| `relationship` | 关系强度 + 频率窗口 | 有向边，`strength` 随互动 +0.05；`window_started_at/count` 支撑"A→B 10 条/小时" |

`CommService`（准入与路由）与 `CommScheduler`（心跳）分工明确：

- **准入顺序有讲究**：未知/离职 → 频率闸 → 配额 → 才写消息。频率先于配额，防止用别人的配额刷屏。
- **配额记账在路由之前**：先扣再投递，崩溃不会白送一次唤醒。
- **无配额降级为留言**：消息仍在队列里（priority 3），只是不立刻唤醒，并写 `wake_quota` guard。
- **空 inbox 不唤醒**：心跳 tick 对没有待办的员工零动作 —— 闲置公司零 token（守住 R2）。
- **context 从 `message` 表重建**：`ChatService.readTranscript` 直接读 message 行，
  所以对方睡着期间新到的三条它也能看见（§5.4 的核心洞察）。
- **一次唤醒只回一次**：回复不把原发送者再入队，两个人不会互相点燃（守住 R4）。

员工工具（`opc.comm`）：

| 工具 | 作用 |
|---|---|
| `send_direct_message` | 给同事发消息；不创建任务（P4：消息 ≠ 任务），花的是**对方**的配额 |
| `ack_message` | 只确认不回复（零 token），让"不话痨"成为可执行的选择 |

```bash
OPC_INBOX_PROBE=1 electron .
#  firstWokeRecipient: true（priority 1 + 立即唤醒）
#  quotaDegradesToQueued: true（第 2、3 条降级 priority 3）
#  transcriptFromDb: true / visibleToBoss: true / inboxDrained: true
#  wakeQuotaGuard: true / noModelGuard: true（没配模型时不编回答，留痕）
#  idleCostsNothing: true / rateBrake: true / relationshipGrew: true
```

单测（`comm/commService.test.ts`）覆盖同样十二条不变量，跑真实 SQLite，不需要启动 Electron：

```bash
pnpm test   # 15 个文件 / 82 用例
```

**还没做的**（Step 1 的剩余护栏）：会话 `turn_count` 与 `cooling` 状态还挂在 `ChatService`
侧未接；老板侧的"通知 / 关系"页面仍是占位页（`/notifications`），guard 与 inbox 目前只能
通过探针和档案抽屉看到。

## 老板侧可见性：/notifications（收件箱 + 护栏 + 关系 + 配额）

Step 1 把"谁在等、谁被拦下"写进了数据库，但老板看不到 —— 那是日志，不是可见性。
这个页面把四张表投成一块看板，渲染层不做任何估算：

| 区块 | 数据来源 | 老板能回答的问题 |
|---|---|---|
| 待办收件箱 | `inbox_item`（pending）+ `message` 预览 | 谁的桌上还有事？是"立刻唤醒"还是"等心跳"？ |
| 被拦下的动作 | `guard_event` | 谁今天被配额/频率/没模型挡住了？为什么沉默 |
| 关系 | `relationship` | 谁和谁在说话、什么方向、关系强度多少 |
| 今日唤醒配额 | `wake_quota` | 谁的配额已经用满，后面的消息只能排队 |

契约与实现：

- `IPC.comm.overview` 只读一次投影（`comm/commOverview.ts`），不写库、不带业务规则；
- `CommService.subscribe` 在有变化时发一个**信号**（不带 payload），主进程 150ms 合并突发，
  渲染层收到后自己重读投影 —— 一次 inbox 批处理会连续完成多条，不该连续推四次全量；
- guard 的 `detail` 是 JSON，投影时只保留基本类型并把 `fromEmployeeId/toEmployeeId` 解析成
  人名，页面上不会出现裸 uuid；无法解释的行直接把原始 detail 打出来，不隐藏；
- 收件箱行点"打开对话"直接跳 `#/chat/<conversationId>`，看到的就是 `message` 表里的真实对话。

`IPC.comm` 之后接的是 `CommBridge`（`overview()` + `onOverviewChanged`），渲染层
`window.opc.comm` 是唯一入口，仍然没有 Node/fs/SQLite。

验证：

```bash
pnpm test        # 17 个通信用例（含 3 个投影用例：预览/人名解析/配额方向）
pnpm build       # main 318 kB · preload 9.9 kB · renderer 251 kB（页面参与打包）
```

**还没做的**：这个页面目前只读 —— 老板不能在这里手动补一次唤醒、也不能清空某人的护栏；
`turn_count`/`cooling` 仍未接线，所以"轮数超限"这一格暂时不会有数据。

## 轮数与生命周期：turn_count / cooling / escalated（§7.3 ②、§7.5）

三层防护的最后一道补上了，护栏四类现在都有真实数据：

| guard kind | 触发点 | 后果 |
|---|---|---|
| `wake_quota` | 收件人当日唤醒配额用尽 | 消息降级为留言（priority 3），不丢 |
| `dm_rate` | 同一对员工一小时内超过上限 | 直接拒绝发送，消息不写库 |
| `message_dropped` | 没配模型 / 模型调用失败 | 前者关掉条目，后者退回队列重试 |
| `turn_limit` | 员工之间的轮数用完，或线程已升级 | 线程 `escalated`，自动回复停止 |

轮数怎么数：`Conversation.turnCount` **只数员工发出的消息**（`appendAgentMessage`），老板的消息不计数也不清零 —— 老板可以随便聊，员工之间才会互相点燃。每次计数后立刻检查预算：

```
turn <  limit  → 照常投递
turn >= limit  → conversation.status = 'escalated' + guard_event('turn_limit', {reason:'limit_reached'})
                  之后任何员工再想发 → 结构化拒绝 CONVERSATION_ESCALATED（不写库）
```

生命周期（§7.5）：

```
open ──(闲置 1h)──→ cooling ──(闲置 24h)──→ archived（顺带巩固）
 │                     ↑                        │
 └──(轮数超限)──→ escalated ─(老板发一句话)──→ open（turnCount 归零）
```

- **cooling**：只是停掉自动回复，线程照常可读；有人写进来就自动回暖（`appendAgentMessage` 会 warm）。
- **escalated**：只有老板能解除。老板在该会话里发一句话即解除并把轮次清零 —— 这正是文档里 `escalated →(老板处理)→ open`，不需要额外按钮。
- 侧边栏会话标题旁会显示 `冷却中` / `已升级` 小标签，老板在 IM 里就能看到哪种线程等他决定。

```bash
OPC_INBOX_PROBE=1 electron .
#  19 项全绿，含：
#  turnLimitEscalates: true（turns=2, status='escalated'）
#  turnLimitRefuses: true（第 3 条 CONVERSATION_ESCALATED，未写入 transcript）
#  turnLimitGuard: true（turn_limit / reason=limit_reached）
#  bossReopensThread: true（turns=0, status='open'）
#  coolingReachable / warmingReopens: true
#  guardKindsSeen: wake_quota, message_dropped, turn_limit, dm_rate
```

单测新增 6 例（`comm/commService.test.ts`）：到达上限即升级、升级后拒绝且不写库、
回答的 run 在升级线程里不回复、老板解除后恢复、冷却/回暖、状态跨重启还在。

**与文档的偏差（明确记录）**：§7.3 说轮数超限时创建 `approval_request(kind='turn_limit')`。
`approval_request` 表属 Phase 3，本轮用 `conversation.status='escalated'` + `guard_event` 承担
同样的"告知老板"职责，`/notifications` 的护栏区就是它的信箱；等 Phase 3 落表时再挂上队列。

## 从看板到控制台：手动唤醒 + 处理护栏

`/notifications` 现在能动手了，两个动作都刻意保持窄：

| 动作 | IPC | 语义 |
|---|---|---|
| 立刻唤醒 | `comm.wake(employeeId)` | 走与心跳**完全相同**的 claim → run 路径，但绕过心跳时钟与配额（§7.2 P0：老板特权，不计配额） |
| 标记已处理 | `comm.dismissGuards(ids?)` | 不传 ids = 全部；**标记时间戳，不删除记录** |

为什么"已处理"是 `dismissed_at` 而不是 DELETE：一次被拦下是审计事实，老板认可它不代表它没发生。
适配这条，schema 走到 **v3**：

```sql
ALTER TABLE guard_event ADD COLUMN dismissed_at INTEGER;
CREATE INDEX idx_guard_open ON guard_event(employee_id, dismissed_at, created_at DESC);
```

`guards()` 与 `/notifications` 的投影只看 `dismissed_at IS NULL` 的行，历史上限仍在库里可查。

唤醒的实现要点：

- `CommScheduler.wakeNow(employeeId)` 与心跳 tick 共用一次 run，失败同样把批次 `requeue`，
  所以"手动唤醒"不会比自动唤醒更脆；
- 它**不消耗**收件人的每日配额 —— 老板找人不需要排队；
- 收件箱为空时返回结构化"没有待办"，而不是假装成功；
- `WakeInput.reason` 多了 `'manual'`，探针里能看到是谁把人叫醒的（`signal` / `heartbeat` / `manual`）。

```bash
OPC_INBOX_PROBE=1 electron .
#  21 项全绿，新增：
#  bossCanWake: true（手动唤醒处理掉 2 条待办）
#  guardsDismissable: true（标记后 guards() 归零，行仍在库里）
```

单测新增 4 例：手动唤醒不花配额、空收件箱拒绝、标记后从 `guards()` 消失但库里有
`dismissed_at`、投影排除已处理项。

**还没做的**：页面不能改配额/阈值（那是设置页的事），也不能从这里给某个线程"解除升级"
—— 解除方式是老板在会话里说一句话（§7.5），有意不做成两个入口。

## 部门群 @ 路由（§7.4）

老板在部门群里说话，现在走和私聊一样的队列，只是"谁该醒"由规则决定：

| 情形 | 唤醒谁 | priority | 计配额 |
|---|---|---|---|
| 没人被 @ | 只叫部门负责人 | 1 | 老板是 P0，不计 |
| 有人被 @ | 只叫被点名的人 | 2 | 不计 |
| @ 了不在群里的人 | 谁都不叫，返回 `ignored` | — | — |
| 1v1 私聊 | 不走群路由（保持原来的直接回复） | — | — |

实现要点：

- `CommService.routeGroupMessage()` 只决定"谁该醒"，消息本身早已写进 transcript（`ChatService`），
  所以 `sendMessage` 在有 `routeGroupMessage` 时**不再**安排 760ms 的定时回复 —— 否则群里会出现两次回答；
- 负责人判定：优先 `department.head_employee_id`，回落到 `position.is_head`，再回落到该群最资深的在职成员；
- 重复投递被 `inbox_item` 的部分唯一索引挡住：同一条消息对同一个人只会有一条 pending；
- `CommScheduler.nudge()`：信号到达后 50ms 内跑一次 tick（内部合并突发），
  不然"立刻唤醒"要等下一次心跳（最多 15 分钟）。

```bash
OPC_INBOX_PROBE=1 electron .   # 23 项，新增
#  groupRoutesToOwner: true      （无 @ → 只有负责人，priority 1）
#  groupRoutesToMentions: true   （@ 两人 → 只有这两人，priority 2）
```

单测新增 6 例（`comm/commService.test.ts` 的 `group routing`）：无 @ 只叫负责人且其他人 inbox 为空、
@ 后只叫被点名的人且负责人不被叫、非成员 @ 被忽略并返回、老板不吃配额、私聊不走群路由、
负责人被唤醒后在群里回话且该轮被计数（同时断言没有走定时回复）。

**还没做的**："由负责人决定：自己答，还是点名下属答" 目前只到前半句。负责人在群里的回复由模型给出；
真正把活派给下属需要 `decompose_task` 这类管理工具，而工具集目前只挂在**任务 run** 的 harness 上，
inbox run 还没有工具。那一步要等 inbox run 能用 pi-durable 的 harness 跑（Phase 1 尾巴）。
