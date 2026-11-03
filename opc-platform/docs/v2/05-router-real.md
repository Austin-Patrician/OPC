# Router 要真的像 Super-agent 的 Router

> 靶子：Super-agent 设计探索 §2.1 / §2.2 / §3 / §4.1 / §6
> 前置：`04-superagent-check.md` 是方向核对；这份是**落地口径**。

## 0. 之前哪里是残缺的

上一版的 `router.ts` 有正确的形状，但没有心脏：

| 缺的东西 | 后果 |
|---|---|
| Router 没有模型 | `judge` / `dispatch` 都是注入点，`index.ts` 里什么都没接。真实运行时它是一个"收下所有事件、什么也不派"的队列 |
| 没有会话 | 每一轮都是一次性判断，跨信道、跨任务不连续。你在聊天里说的"A 方案"，下一轮它不记得 |
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
                    │ ① 程序层过滤（可配：噪声 / 名单）        │
                    │ ② 直通判定（threadKey → 订阅者）        │
                    │ ③ 语义门（可配：关 / 分类器）            │
                    │ ④ 攒批：事件 + 未播报的汇报 → 一条输入   │
                    └──────────────┬───────────────────────┘
                                   │ deliver(text)
                                   ▼
                    ┌──────────────────────────────────────┐
                    │ Router 会话（agents/router.sqlite）     │
                    │ 常驻 · 有历史 · 只有 9 个非执行工具      │
                    │ open_line_of_work / reply_to_user /    │
                    │ recall / list_lines / steer_line /     │
                    │ ask_user / close_line / remember /     │
                    │ recall_memory                          │
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
| 全局序点、协调点、记忆 | 会话历史 + `list_lines` + `recall` + **`remember` / `recall_memory`** | 同上 |
| **不直接执行具体任务** | 注册表里没有 bash / 读写文件 / 代码执行 | `routerTools.ts`（有测试锁住） |
| 可以配轻量模型 | 用工作台默认模型，`thinking` 默认 low | `routerHost.ts` |
| 批处理 | 交给 pi 的 inbox：忙时输入排队，下一个 boundary 合成一次调用 | `routerSession.deliver` |
| 内部不必是单会话 / 部分逻辑不调 LLM | tick 里的四件事全是确定性的（语义门那次调用除外，它是可关的） | `router.ts` |
| 「记忆」不只是上下文窗口 | `remember` / `recall_memory` 读写 `memory` 表的 `owner_id='router'`；归档巩固写的就是这个 owner | `routerHost.ts` + `chatService` |
| 「规矩」不只执行体知道 | `fact` 的 global 那几条每轮拼进 Router 的输入 | `router.composeInput(rules)` |

### §2.2 Worker 层

| 原文要求 | 实现 |
|---|---|
| 上下文隔离 | 每个 worker 一个 harness（`agents/<workerId>.sqlite`），B3-2 已落地 |
| 挂载完整执行工具 | `toolSlots` / `buildRegistry`（workService） |
| **不直接与人类交互** | 执行体没有聊天出口；它只能 `reportToThread` |
| 向 Router 汇报、由 Router 统一回复 | `report` 表 → 下一轮进 Router 上下文 → `reply_to_user` |
| 一线多 worker，多对多订阅 | `subscription(thread_id, worker_id)` |

### §3.1 两级过滤：两层都能配，两层都不丢活

| 层 | 花多少 | 谁在判 | 可配成 |
|---|---|---|---|
| 程序层 | 零 token | `router/triage.ts` 三条规则：自己写出来的回环、没有正文、窗口内重复（**人的话不去重**） | `noise`（默认）/ `allowlist` |
| 语义门 | 一次分类调用，按批摊薄 | `router/semanticGate.ts` → `decisions.classify`，一批一次调用、每批最多 10 条 | `router`（不设门，全交 Router）/ `decision`（先过分类器） |
| 主判 | Router 的上下文 | Router 会话：开不开线、派给谁、怎么跟你说 | 不配——它需要连续上下文 |

三个决定是有意为之：

1. **语义判断被拆成两个问题**。①「值不值得占用上下文」廉价、可批量、不需要全局视野，
   交给分类器；②「要不要开线、派给谁」需要连续性，永远是 Router。
2. **两层的失败方向都是"往上交"**：规则拿不准就放行；分类器没配、调用失败、答案缺失
   也一律放行。省钱的层没有丢活的权力——`TriagePolicy` 调的是花多少钱，不是活会不会丢。
3. **配置存 `app_setting`（`router.triage`），每轮重新读**。改完下一轮生效，不需要重启，
   也就不存在"设置了但没生效"这种解释不了的状态。设置页：设置 → 通用 → 调度。

`TickReport` 把两层分开计数（`dropped` / `gated` / `routed`）："没花钱就确定"和"花了一点
钱才确定"是两件事，混在一起就看不出去噪靠的是哪一层。

### §3.2 订阅与直通

- **Fast Path**：事件带 `payload.threadKey` → `threadByKey` → `subscribersOf` 非空 →
  直接 `openLine`（在同一线程上开新任务），**不经过模型**。
- **直通带上人**：`openLine` 收 `workerId`，归属已定就不再按目标挑一次人。不带它的话，
  `pickWorker` 会从全库重新选——单执行体的机器上看不出来，多执行体的机器上就是同一件
  事被两个人各干一半。
- **Slow Path**：其余进 Router 批量判断（先过程序层，再过程序可配的语义门）。
- 多对多：`subscription` 是独立表，主键 `(thread_id, worker_id)`。「一条线一个主执行体」
  是现在的口径：直通取第一个订阅者。多对多的意思是一个执行体可以盯多条线。
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
| 程序层过滤 | 噪声一个 token 都不花 | `triage.test.ts`；探针里的 `noise: {dropped:2}` |
| 语义门 | Router 的上下文窗口与一轮推理 | `semanticGate.test.ts`「一次调用判一批」；探针里的 `gated.gated = 1` |
| 直通 | Router 的决策数、读缓存 token（原文约 −30%） | 「已订阅的线…不经过 Router」 |
| 攒批 | 单条决定分摊的推理时间 | 一批 N 条 → 一次 `deliver`（用例锁住） |
| Inline & Spill | 上下文窗口占用 | 长文本被截断且留召回入口 |
| 稳定系统前缀 | provider 缓存命中 | `section('router-role')`（会变的规矩放在输入里，不放进前缀） |

**直通关掉会怎样？** 功能不丢，只是贵一些：`RouterDeps.passthrough` 可选，缺省时
全部走 Router。**语义门关掉会怎样？** 也一样：`keepAll` 走一遍，全部交给 Router 自己判。
两条都写在用例里——它们证明这两层是优化而非正确性。

## 4. 扩展性：加东西不用改调度循环

| 要加什么 | 加在哪 | 不改什么 |
|---|---|---|
| 新的 Trigger 来源（日历 / GitHub） | 一个适配器往 `event` 里写行，`payload.threadKey` 给出并线身份 | `router.ts` 一行不动；默认策略不会挡它（名单模式才需要登记） |
| 新的 Router 动作（如"合并两条线"） | `routerTools.ts` 里加一个 `defineTool` | 调度循环、会话层 |
| 新的执行体类型 | `WorkerTemplate` + `toolSlots` | Router |
| 换模型 | 设置里换默认模型，下一轮生效（`reconfigure`） | 无 |
| 换过滤策略 | 设置 → 通用 → 调度（`router.triage`） | 重启、代码 |

## 5. 还差什么（诚实清单）

1. **投机执行（§3.4）**：没有。它需要"后台有富余算力"的前提，单机串行跑 worker 时
   提前做只是抢同一个人的时间。
2. **Watchdog 的模型层（§6）**：没有。程序层在，语义层没接。
3. **计算/状态/环境分离（§5）**：不做。本地优先桌面应用三者天然合一；代价是
   「持久」只到进程级（`resumeInterrupted`），关机就停。
4. **多 Router 分片（§2.1 后半）**：不做。单机事件量远没到瓶颈，过早分片会拿
   全局连续性换吞吐。
5. **被程序层丢掉的事件没有界面入口**：`event.triage = 'dropped'` 留在库里，
   `recall <eventId>` 也能取到，但没有任何页面列它们。现在的可见性只有日志里那行
   计数——真要排查"我的文件怎么没动静"，需要一张 events 视图。这是**可见性缺口**，
   不是正确性缺口（事件本身没被删）。

（第 5 条以前的 `employee` 残留已经清完了：工具策略在 `worker.tool_policy`，模型在
`resolveWorkerModelRef`，名单式的 `capabilities()` 改成按执行体查，表在 V33 之后
只剩工作台自己的数据。）

---

## 6. 你中途改方向真的通了（§8.2）

上一版这里是一个**空插座**：`steer_line` 在工具带里、提示词里也写着"改主意用它"，
但 `index.ts` 创建 `createRouterHost` 时根本没传 `steer`，模型每次调用都拿到
「这个环境不支持中途改方向」。双层架构里"介入"只有这一个入口，所以关掉它等于
承诺了一件做不到的事。

现在两件事一起做，覆盖两个不同的时刻：

| 时刻 | 机制 | 你看到 |
|---|---|---|
| **正在跑** | 插进那个会话：`conversation.submit({ whenBusy: 'steer' })`，pi 的 inbox 在下一个 boundary（一次工具调用结束）把它放进上下文 | 「已经插到正在跑的活上，它这一轮就能看到」 |
| **还没开跑 / 要重试** | 写进 `task.steering`（V32）。`produce` 每次尝试都**重新从库里读任务**，所以重试与返工自然继承 | 「记在这条线上了，开跑时会看到」 |
| 已经收尾 | 拒绝，理由说清楚：改方向得开新线 | 「这条线上的活已经收尾了」 |

两处细节值得记住：

- **提示词里的顺序是有意义的**：改方向排在原始说明**之后**，并且明确写着
  "与上面的说明冲突时，以这里为准"。否则话存进库了、执行体照旧按原说明干，
  你会以为自己的话没被听见。
- **不为此开第二条线**：同一件事换个方向还是同一件事，这条规矩写在
  `router-role` 的稳定前缀里（顺带吃到提示词缓存）。

**`whenBusy: 'steer'` 是运行时白给的**：§4.1 的"异步 ReAct Loop"在 pi 里本来就有
inbox 与 boundary，我们不需要自己实现"打断 generation"。


## 7. 三个洞：直通换人、过滤黑洞、Router 没有记忆

这一轮不是加功能，是把"职责里写着但做不到"的三件事补上。三条都有代码位置和验收方式。

### 7.1 直通会把活派给另一个人

`Router` 在 `intentFor` 里算出了 `workerId`，而 `passthrough` 只把 goal 和 threadKey
交给了 `openLine`。`openLine` 内部会重新 `inferTemplate` + `pickWorker(listAllWorkers())`
——从**全库**再挑一次人。

单执行体的机器上永远挑到同一个人，所以用例全绿；多执行体的机器上，一条已经订阅了该线的
事件会被派给不相干的人，原订阅者从头到尾不知道它来过。直通省的是"判断"，这里顺手把
"归属"也重算了。

修法：`OpenLineInput.workerId`，钉住就不挑人；钉住的人不在这条线上（线被重建过）时
才退回正常挑人。用例：`workDispatch.test.ts`「钉住执行体时不再挑人」。

同时把口径写死：**一条线一个主执行体**，直通取第一个订阅者。多对多的意思是"一个执行体
可以盯多条线"，不是"一条线找一堆人抢活"。

### 7.2 程序层过滤是个黑洞

原来那一行是来源白名单（`manual | folder | im`），于是：

- 新接的适配器（日历、GitHub）**静默死在这里**，而文档还写着"加来源不用改 `router.ts`"；
- `drop` 是终态，界面上没有任何 events 页面，IPC 里也没有 `event.list`——丢了以后
  你和 Router 都没有地方看到"它来过"。

现在程序层只挡**确定是噪声**的三类（§3.1 的表），没登记的来源默认放行；把"我只要盯
收件箱"这种偏好交还给 `allowlist` 模式，由你在设置里显式选择，而不是代码替所有人选。

### 7.3 Router 没有记忆

`§2.1` 说 Router 是"全局序点、协调点**和记忆**"。实际情况是：它的注册表只有那 7 个
工具，`recall` 能查 thread / worker / task / event / report，**查不到 `memory`，也查不到
`fact`**。它全部的"记忆"就是自己那点会话历史，压缩一跑就削。

更扎的是写的那一头：归档巩固用 `conversation.memberIds[0]` 当 owner，助手会话的成员是
`router`，所以记忆落在 `owner_id='router'`；而唯一读记忆的人是执行体（读自己的 id）。
**一条完整的记忆生产链，收件人从来没拆过信。**

现在 `remember` / `recall_memory` 读写同一个 owner（`ROUTER_ID`），归档巩固写的行
终于有人读；`fact` 的 global 那几条每轮拼进 Router 的输入——规矩不再只有干活的人知道。

这一条也解释了为什么"跨天记得你说过什么"以前做不到：不是模型不行，是**读的人不存在**。
