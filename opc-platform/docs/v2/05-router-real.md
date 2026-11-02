# Router 要真的像 Super-agent 的 Router

> 靶子：Super-agent 设计探索 §2.1 / §2.2 / §3 / §4.1 / §6
> 前置：`04-superagent-check.md` 是方向核对；这份是**落地口径**。

## 0. 之前哪里是残缺的

上一版的 `router.ts` 有正确的形状，但没有心脏：

| 缺的东西 | 后果 |
|---|---|
| Router 没有模型 | `judge` / `dispatch` 都是注入点，`index.ts` 里什么都没接。真实运行时它是一个"收下所有事件、什么也不派"的队列 |
| 没有会话 | 每一轮都是一次性判断，跨信道、跨任务不连续。老板在聊天里说的"A 方案"，下一轮它不记得 |
| 聊天绕过 Router | `chat.replyWithModel` 让一个执行体用岗位人设直接回答。双层被压成单层 |
| 没有订阅 | 没有"这条事件流已经有主了"的概念，每个事件都要过一遍模型 |
| 没有链式召回 | 模型要么看不到上下文，要么全塞进窗口 |

## 1. 现在的形状

```
        IM 消息 ─┐
        folder  ─┼─► event(source, kind, payload.threadKey)
        calendar─┤            │
        github  ─┘            ▼
                    ┌──────────────────────────────────────┐
                    │ Router.tick  —— 确定性，不花 token      │
                    │ ① 程序层过滤                           │
                    │ ② 直通判定（threadKey → 订阅者）        │
                    │ ③ 攒批：事件 + 未播报的汇报 → 一条输入   │
                    └──────────────┬───────────────────────┘
                                   │ deliver(text)
                                   ▼
                    ┌──────────────────────────────────────┐
                    │ Router 会话（agents/router.sqlite）     │
                    │ 常驻 · 有历史 · 只有 7 个非执行工具      │
                    │ open_line / reply_to_boss / recall /   │
                    │ list_lines / steer_line / ask_boss /   │
                    │ close_line                             │
                    └──────────────┬───────────────────────┘
                                   │ open_line_of_work
                                   ▼
                    ┌──────────────────────────────────────┐
                    │ 执行体（自己的 sqlite、自己的工具集）    │
                    │ 干活 → 验收闸门 → report               │
                    └──────────────┬───────────────────────┘
                                   │ report(level)
                                   ▼
                     下一轮作为「执行体汇报」回到 Router
```

## 2. 逐条对齐

### §2.1 Router 层

| 原文要求 | 实现 | 位置 |
|---|---|---|
| 常驻，承接所有入口的人类交互 | 一个 durable conversation，`Harness.root()` | `routerSession.ts` |
| 全局序点、协调点、记忆 | 会话历史 + `list_lines` + `recall` | 同上 |
| **不直接执行具体任务** | 注册表里没有 bash / 读写文件 / 代码执行 | `routerTools.ts`（有测试锁住） |
| 可以配轻量模型 | 用公司默认模型，`thinking` 默认 low | `routerHost.ts` |
| 批处理 | 交给 pi 的 inbox：忙时输入排队，下一个 boundary 合成一次调用 | `routerSession.deliver` |
| 内部不必是单会话 / 部分逻辑不调 LLM | tick 里的三件事全是确定性的 | `router.ts` |

### §2.2 Worker 层

| 原文要求 | 实现 |
|---|---|
| 上下文隔离 | 每个 worker 一个 harness（`agents/<workerId>.sqlite`），B3-2 已落地 |
| 挂载完整执行工具 | `toolSlots` / `buildRegistry`（workService） |
| **不直接与人类交互** | 执行体没有聊天出口；它只能 `reportToThread` |
| 向 Router 汇报、由 Router 统一回复 | `report` 表 → 下一轮进 Router 上下文 → `reply_to_boss` |
| 一线多 worker，多对多订阅 | `subscription(thread_id, worker_id)` |

### §3.2 订阅与直通

- **Fast Path**：事件带 `payload.threadKey` → `threadByKey` → `subscribersOf` 非空 →
  直接 `openLine`（在同一线程上开新任务），**不经过模型**。
- **Slow Path**：其余进 Router 批量判断。
- 多对多：`subscription` 是独立表，主键 `(thread_id, worker_id)`。
- 退订不删行：`dropped_at` 记时间，排查"为什么这条事件没人接"时有据可查。

### §3.3 Inline & Spill 与链式召回

- `composeInput` 给每个对象内联 **id + 摘要**；超过 600 字截断并留 `recall <id>`。
- `recall` 工具对 thread / worker / task / event / report 都能取，返回里带着
  **下一跳的 id**（线的任务、最近汇报、执行体），模型顺着引用图逐跳展开。
- 系统提示词走 `section`（稳定前缀），让 provider 的提示词缓存能命中。

### §4.1 全双工

派活本身就是异步的：`open_line_of_work` 建任务、`startTask` 启动、**立刻返回 id**。
Router 这一轮推理到此结束，不需要阻塞等一个跑十分钟的活；结果之后作为汇报回来。
这比在工具层做 `start()/stop()` 更彻底——跨进程的 durable task 天然如此。

### §6 Watchdog

程序层（spinning / stalled / orphaned）已有。**模型层还没有**：判断"方向是否偏离"
需要读执行体的过程，等事件量上来再说。这次没做，记在这里。

## 3. 性能：不靠感觉，靠可测量的东西

| 机制 | 省什么 | 怎么验证 |
|---|---|---|
| 程序层过滤 | 噪声一个 token 都不花 | `router.test.ts`「噪声见不到 Router」 |
| 直通 | Router 的决策数、读缓存 token（原文约 −30%） | 「已订阅的线…不经过 Router」 |
| 攒批 | 单条决定分摊的推理时间 | 一批 N 条 → 一次 `deliver`（用例锁住） |
| Inline & Spill | 上下文窗口占用 | 长文本被截断且留召回入口 |
| 稳定系统前缀 | provider 缓存命中 | `section('router-role')` |

**直通关掉会怎样？** 功能不丢，只是贵一些：`RouterDeps.passthrough` 可选，缺省时
全部走 Router。这条也写在用例里——它证明直通是优化而非正确性。

## 4. 扩展性：加东西不用改调度循环

| 要加什么 | 加在哪 | 不改什么 |
|---|---|---|
| 新的 Trigger 来源（日历 / GitHub） | 一个适配器往 `event` 里写行，`payload.threadKey` 给出并线身份 | `router.ts` 一行不动 |
| 新的 Router 动作（如"合并两条线"） | `routerTools.ts` 里加一个 `defineTool` | 调度循环、会话层 |
| 新的执行体类型 | `WorkerTemplate` + `toolSlots` | Router |
| 换模型 | 设置里换默认模型，下一轮生效（`reconfigure`） | 无 |

## 5. 还差什么（诚实清单）

1. **投机执行（§3.4）**：没有。它需要"后台有富余算力"的前提，单机串行跑 worker 时
   提前做只是抢同一个人的时间。
2. **Watchdog 的模型层（§6）**：没有。程序层在，语义层没接。
3. **计算/状态/环境分离（§5）**：不做。本地优先桌面应用三者天然合一；代价是
   「持久」只到进程级（`resumeInterrupted`），关机就停。
4. **多 Router 分片（§2.1 后半）**：不做。单机事件量远没到瓶颈，过早分片会拿
   全局连续性换吞吐。
5. **`employee` 仍在**：执行体的工具策略与模型还长在 employee 行上
   （`tool_policy` / `model_ref`）。这是最后一块，W1 未做。
