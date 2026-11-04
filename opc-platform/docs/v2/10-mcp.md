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

## 8. 还没做的（M3）

| 缺口 | 为什么还没做 |
|---|---|
| 动作级审批（许可票） | 判据已经有了（`needsApproval`），缺的是"停下来等人批"的那条路——它要接到注意力队列的 `answer` 上 |
| 动作级审批（许可票） | 判据已经有了（`needsApproval`，读服务器自报的 `destructiveHint` / `openWorldHint`），缺的是"停下来等人批"的那条路 |
| `tools/list_changed` 的热更新 | 现在目录在挂载时读一次。服务器换了工具要等下一次重开 |

## 9. 一个构建上的坑，记下来

`@earendil-works/pi-mcp` 是 **ESM-only**（`exports` 里没有 `require` 条件），而主进程包是
CommonJS。`require('@earendil-works/pi-mcp')` 会报 `No "exports" main defined`。

修法在 `electron.vite.config.ts`：把它从 `externalizeDepsPlugin` 的 external 列表里排除，
让 Rollup 打包进来。**别的 pi 包不用这么处理**，因为它们的 `exports` 有 `default` 条件。
