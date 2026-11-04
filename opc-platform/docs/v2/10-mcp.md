# 10 · MCP：外部能力接进来的方式

> 「为什么不基于 extension 做」——**pi 自己就是基于 extension 做的**。
> `pi.dev/docs/latest/sdk`：CLI 把 `codemode` / `tool_search` / MCP 都当内置扩展，
> SDK 会话则要显式 `createMcpExtension()` 加进 resource loader。我们照同一个形状做。

---

## 1. 三道选择题，答案都是"照抄"

| 问题 | 答案 | 为什么 |
|---|---|---|
| 用什么连？ | `@earendil-works/pi-mcp`（官方独立客户端，1.5.0，只依赖 `cross-spawn`） | stdio / streamable HTTP、`tools/*`、`resources/*`、OAuth、超时、进度全在里面。自己手写 JSON-RPC 是在重写一个别人已经调通的东西 |
| 怎么挂？ | 一个 pi-durable 扩展 `opc.mcp`，每个服务器工具一个 `defineTool` | 平台就这么挂：deferred 工具是**注册表里的东西**，不是运行时凭空长出来的 |
| 工具怎么到模型面前？ | 默认 `deferred`（`tool_search` 搜到再调），服务器可选 `direct` / `hidden` | 一个服务器十来个工具的 schema 就是几千 token，而大多数轮次一个都用不上 |

## 2. 照抄的具体清单

| 维度 | pi 内置 MCP | 我们 |
|---|---|---|
| 命名 | `mcp__<server>__<tool>`，非字母数字换 `_`，撞名加哈希 | 同（`mcp/contract.ts`） |
| 传输 | stdio + streamable HTTP；SSE 明确不支持 | 同，SSE 的条目在读取时就拒绝并说明原因 |
| 暴露 | `codemode`（默认）/ `deferred` / `direct` / `hidden` | `deferred`（默认）/ `direct` / `hidden`（我们没有 codemode） |
| 截断 | 文本 > 20 KB 挖中间，全文存盘 | 同（`truncateMiddle`） |
| 资源 | `list_mcp_resources` / `read_mcp_resource` / `list_mcp_resource_templates` | 前两个（第三个等有人要再加） |
| 配置 | `~/.pi/agent/mcp.json` + 项目 `.mcp.json` | `<userData>/mcp.json` + `~/.pi/agent/mcp.json`（读 pi 的那份是白送的） |

**不读项目的 `.mcp.json`**：那是"仓库自带"的配置，打开一个陌生仓库就连上它声明的服务器，
等于让 `clone` 变成一次安装。要用项目级的服务器，写进我们自己的文件。

## 3. 落到了哪

| 东西 | 在哪 |
|---|---|
| 配置形状、命名、截断、审批判据 | `mcp/contract.ts` |
| 连接（`McpClient` + transport、目录缓存、进程级共享） | `mcp/connection.ts` |
| 挂载成 pi-durable 扩展（工具 + 资源 + 提示词段） | `mcp/extension.ts` |
| 读 `mcp.json`（含 JSONC 注释、坏条目跳过） | `mcp/config.ts` |
| 真子进程探针 | `mcp/probe.ts`（`OPC_MCP_PROBE=1`） |

## 4. 三个实现判断

**① 连接是进程级共享的，不是每个执行体一条。**

一百个执行体各连一次同一个服务器 = 一百个子进程。所以 `sharedMcpConnection` 按
（名字 + 命令/URL）缓存；改配置就是另一个 key，旧连接留着只会让人困惑。共享的东西不该
由某一次挂载关掉——`mountMcp` 只关它自己开的那些。

**② 建注册表时就要连上，因为工具必须在注册表里。**

这不是洁癖：pi 的 deferred 工具是注册表的成员。代价是一个服务器卡住会拖慢建注册表，
所以每台服务器自己的 `timeoutSeconds` 管住它，坏的那台只记一条 `error`。

**③ 提示词里只说"有这些服务器"，不列工具名。**

列了就等于把 schema 的一半塞回上下文——那正是 `deferred` 要避免的。模型需要工具时用
`tool_search` 搜。

## 5. 探针

```
OPC_MCP_PROBE=1 electron .
```

真起一个 stdio 子进程（fixture 写在临时目录里），握手、列工具、调一次、**收尸**：

```json
{ "ok": true, "tools": ["mcp__fixture__echo"], "answer": "echo: 你好", "closed": true, "elapsedMs": 140 }
```

写成探针而不是用例，因为它要证明的是"能连上真进程"——内存 transport 的用例证明不了
子进程、stdin/stdout 的 JSON 行、以及退出时有没有漏进程。

## 6. M2 已落地：设置页

一页在「设置 → 模型 → MCP」：列出服务器、点一下测试、加一台、删一台。

**存储还是那个文件**（`<userData>/mcp.json`）。不用数据库的理由：这份配置是 MCP 生态的
公共格式，手写得、能进版本库、换台机器拷过去就能用；设置页只是它的编辑器，不是它的所有者。

三个实现判断：

1. **改完不重启**。`WorkServiceDeps.mcp` 是一个**取值函数**而不是一份快照：`mcp: () =>
   readMcpConfig(...).servers`。设置页保存之后 `closeAllMcpConnections()` +
   `invalidateAllHarnesses()`，下一次建注册表就读到新的那几台。
2. **"测试"用独立连接**，不碰共享池：点一下按钮不该在进程里留一条连接，也不该让一份
   写错的配置污染正在干活的那一份。
3. **删到一台不剩就把文件删掉**，而不是留一个 `{"mcpServers":{}}`——空文件会让人以为
   哪里坏了。

## 7. M2b 已落地：OAuth

这是 MCP 里唯一**有状态**的部分。三件事必须做对，每一件都对应一个具体的失败：

| 要求 | 为什么 | 落在哪 |
|---|---|---|
| token 落盘且**加密** | 它等价于一个能读你数据的密码 | `McpAuthStore`（系统密钥环 `safeStorage`，文件 `mcp-auth.json`） |
| 按**名字**隔离 | 同名换了地址就是另一台服务器，旧 token 不能跟着过去 | 一个名字一份密文条目 |
| 401 之后要么续、要么明说 | 不能静默变成一堆工具调用失败 | `adaptOAuthProvider`（pi-mcp 自带，并发 401 共享一次刷新） |

登录流程就是 pi-mcp README 那一段：先**不带凭据连一次**，撞到 401 才知道要登录；
然后开浏览器、等本地回调、拿 code 换 token。

两个实现判断：

**① 先挂"等人回来"，再开浏览器。** 顺序反了会漏掉浏览器回跳得很快的那一次，
表现是"点了登录、浏览器回来了、界面还是未登录"——而这条路径恰恰是最难复现的。

**② 运行时不给登录。** `runtimeAuthProvider` 的 `redirectUrl` 是一个必然没人监听的
地址：需要人点头的事不该在一次工具调用里发生。token 过期且续不上时它抛
`McpOAuthAuthorizationRequiredError`，工具调用失败并说清"去设置页重新登录"。

用例（`auth.test.ts`，7 条）：密文落盘（文件里看不到明文）、按名字隔离、登出清干净、
解不开就当没登录（换台机器不该在第一次调用里抛）、已登录不开浏览器、要人点头时开浏览器
并换到 token、失败返回原因而不是抛。

测试里注入了一个逐字节取反的"加密"：真加密是 Electron 的 `safeStorage`，vitest 里没有
那件东西。要验的是读写与隔离，不是密码学。

## 8. M3 已落地：动作级审批

MCP 服务器会自己声明 `destructiveHint` / `openWorldHint`——**这是它说的话，不是我们猜的**。
缺的从来不是判据，是"停下来等人点头"那条路。

```
beforeTool 看到要审批的工具、没有放行条
  → 写一条 approval 进注意力队列（decide），线停在「等你」
  → 这次调用被拦，模型收到一句"已经问到队列里了"
你按「允许」
  → 落一张放行条（这件活 × 这个工具）+ 这句话插进它正在跑的会话
它重试 → 放行条在 → 通过
```

**一条最要紧的判断：拦住之后必须由系统去问，不能指望模型记得请示。**
模型被拦之后最常见的反应是换个做法继续，而不是回头报告"我被拦了"——那条话如果只写在
工具返回里，你就永远看不到自己被拦住过。

### 三个定义

| 概念 | 定义 | 为什么 |
|---|---|---|
| 汇报的第三种 | `kind: 'approval'`，收件动词是**允许 / 不允许** | 它和 `question` 不是同一件事：一个要**内容**，一个要**放行** |
| `report.subject` | 审批时是工具名 | 放行要落回**那个工具**上；从标题里抠等于让改文案变成一次事故 |
| 放行条 | （哪件活 × 哪个工具），30 分钟，任务收尾即清 | **不是一次性**：你答"可以"是"这件活上它可以"，不是"这一次可以、下次再问" |

### 两次踩到的坑（都留下了用例）

1. **`report.thread_reply_target` 根本不存在**。V46 重建表时我在 SELECT 里带了它，任何一次
   全新安装都会在迁移时炸。是"放行条"那条用例第一次建库才暴露的。
2. **去重按标题判**。标题是 `要你点头：[fs] write_file`，里面没有工具名——所以同一个工具
   会被问两遍。改成按 `subject` 判。

### 用例

`approval.test.ts`（6 条）：没有放行条就拦且去问人、有就放行、不需要审批/不在任务里都不拦、
空表不装 hook、撤销桥之后不拦、放行条按（活 × 工具）且会过期。

`workThreadReport.test.ts`（+5，端到端）：审批落一条 `approval` 且线停在 `waiting`、
同一件活同一个工具只问一次、允许后落条且回 `running`、不允许不落条并告诉它别再试、
放行条不跨活。
| 动作级审批（许可票） | 判据已经有了（`needsApproval`，读服务器自报的 `destructiveHint` / `openWorldHint`），缺的是"停下来等人批"的那条路 |
| `tools/list_changed` 的热更新 | 现在目录在挂载时读一次。服务器换了工具要等下一次重开 |

## 9. 两个小口子已经补上

### 服务器换了工具（`tools/list_changed`）

以前目录在挂载时读一次，服务器加了工具要等重开——而模型看到的是那份旧列表：新加的搜不到，
删掉的点了报"未知工具"。**这两件事它都不会说，它只会换条路走**，你看到的是"它怎么不用那个工具"。

现在：`McpConnection.onToolsChanged` 订阅那条通知 → 重读目录 → **用同一个 `build()`**
再造一份扩展 → `mount.refreshTarget(extension)` 交给宿主，`registry.install()` 就地替换
（pi：同名安装即替换，在途的调用保持旧代码，下一轮用新的）。

`refreshTarget` 是**可设置的字段**而不是构造参数：注册表会重建（换栈、改配置），而挂载是
复用的——每次重建都把这里指向新的那一个。

### 按执行体开关

`opc.mcp` 以前是建注册表时直接装的，绕过了槽位，所以 `toolPolicy` 停不到它。现在它是一个
**槽**：`stack()` 里看得见、关得掉，关掉的方式有两条——

- 关整个扩展（`disabledExtensions: ['opc.mcp']`）；
- 关一个服务器的全部工具（`disabledTools: ['mcp__github__*']`）。

第二条需要前缀规则，`toolPolicy` 加上了（和 pi 的 `--tools 'mcp__radius__*'` 同一个写法）。
理由不是方便：MCP 服务器的工具会变，逐个枚举等于"今天关完了、明天它加一个就又开了"，
而漏一次没人会发现。

没配置服务器时它也**不是不出现**，而是一行写着 `no-mcp-servers` 的槽——不出现的话，界面上
就没有地方能说明"这个应用能接 MCP"，而那正是新用户最先问的事。

## 10. 一个构建上的坑，记下来

`@earendil-works/pi-mcp` 是 **ESM-only**（`exports` 里没有 `require` 条件），而主进程包是
CommonJS。`require('@earendil-works/pi-mcp')` 会报 `No "exports" main defined`。

修法在 `electron.vite.config.ts`：把它从 `externalizeDepsPlugin` 的 external 列表里排除，
让 Rollup 打包进来。**别的 pi 包不用这么处理**，因为它们的 `exports` 有 `default` 条件。
