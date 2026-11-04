# Worker 层规格：执行体的完整设计

> 靶子：Super-agent 设计探索 **§2.2 Worker 层**，牵连 §3.2（订阅与直通）、§3.3（Inline & Spill /
> 链式召回）、§3.4（投机执行）、§4.1（异步 ReAct Loop）、§6（Watchdog）。
> 前置：`04-superagent-check.md`（方向核对）、`05-router-real.md`（Router 落地口径）。
> 与 `08-worker.md` 的分工：**08 是按时间排的分期与回溯（E0–E4 做到哪了），09 是规格
> （执行体应该是什么样，不按时间排）。** 两份冲突时以 09 为准，08 继续记"哪一步落的、怎么验的"。
>
> 一句话：**执行体的核心不是"能干活的 agent"，而是一个被剥夺了两件事的 agent——
> 它不能自己判完成，也不能自己开口说话。**

---

## 0. 核心思想：文章对 Worker 的四条硬约束

原文关于 Worker 的那一段，拆开只有四个"必须"。缺任何一个，它就不再是执行体：

| 必须 | 缺了会怎样 | 靠什么成立 |
|---|---|---|
| **有自己的目标** | 它退化成聊天窗口 | `WorkTask.brief` + `deliverableSpec` |
| **有自己的隔离上下文** | 一次失败污染同一窗口里的下一件事 | `agents/<workerId>.sqlite` + 一任务一会话 |
| **有完整的手** | 它是 Router 的副本，多花一份钱 | `toolSlots` / `buildRegistry` |
| **只有一条窄的外向通道** | 并发时你会收到五条互相矛盾的进度 | 只有 `report`，注册表里没有聊天工具 |

再补一条最容易读错的地方：

> 「推理过程和工具调用**不会直接输出到外部信道**」≠「不可见」。

文章要的是**不打扰人**，不是**不可观测**。恰恰相反：Watchdog 在系统之外，它只能读库；
界面上的"它现在在干什么"也只能读库。所以正确的形状是三层：

```
对 Router：只汇报结论（report）
对系统：留下完整轨迹（trace）—— 给 Watchdog、界面、复盘
对人：不说话（没有聊天出口）
```

**把结论和过程分开，是这份规格的中心。** 混在一起只有两种结局：Router 变成日志消费者，
或者 Watchdog 什么也判不了。

---

## 1. 六条不变量

不变量是这份规格的地基：任何后续设计如果违反其中一条，就是错的设计，不管它跑得多快。

| # | 不变量 | 违反的后果 | 现在的守卫 |
|---|---|---|---|
| **W1** | 产物必须是**可判定的改变**，不是一段话 | 「模型说它做完了」被当成完成 | `produce → verify → accept`；`acceptanceGate.isUnverified` 不让假通过 |
| **W2** | 隔离的粒度是**任务** | 两个任务互相读到对方的失败 | 一任务一 workspace、一任务一会话 |
| **W3** | 同一执行体同一时刻**只跑一个任务** | 并发写同一 sqlite 会毒化会话，之后每次都失败 | `work/ownerQueue.ts`（串行是正确性，不是调度优化） |
| **W4** | 不与人对话，彼此**不点对点通信** | 解释廉价、干活昂贵；多张嘴互相矛盾 | 注册表里没有聊天工具；`OPC_CHAT_PERSIST_PROBE` 断言 `workerSilent` |
| **W5** | 成本归因到**线** | 「这件事值不值」永远没有答案 | `reportUsage` → `task.tokensUsed` / `costUsd` → `threads.charge` |
| **W6** | 对外可见的状态**先落库**，且**分两档**：结论进 `report`，过程进 `trace` | Watchdog 判不了进展；界面进度是装饰；Router 被日志淹没 | ✅ `report`（结论）+ `task_trace`（过程，见 §3.4） |

W6 是这份规格相对 `08-worker.md` 新增的一条。它的两个失败模式都很具体：

- 只有 `report`、没有 `trace`：`task.steps` 一次尝试只写 4 条（`交给 pi 循环` / `修复上下文` /
  `模型用量` / `pi 循环结束`），于是 Watchdog 的 `spinning` 实际上永远不会触发（三次尝试写不出
  五条重复），「方向是否偏离」更是没有任何材料。
- 只有 `trace`、没有分档：`task.steps` 每一步都进 `report`，Router 就成了日志消费者——
  这和 `07-memory.md` §21 删掉的那条写入是同一个错误。

---

## 2. 结构：五个面

```
          ┌──────────────── Worker（一个执行体）────────────────┐
 目标 ────►│ ① 身份    worker 行 · runtimeKey · 模型钉住          │
          │ ② 上下文  一任务一会话 · 九段提示词 · recall 出口     │
          │ ③ 手      工具带（分层装配）· 沙箱 · 限额 · 技能       │
          │ ④ 轨迹    trace：工具调用/产物/用量（人 + Watchdog）   │
          │ ⑤ 嘴      report(decide/notify/silent) · escalate ·    │
          │           hand_back · 进度永不进 report               │
          └────────────────────────┬────────────────────────────┘
                                   │ 只交两样：产物 + 结论
                                   ▼
                        判据（沙箱外的退出码 / 人的确认）
```

**Router 不在这张图里。** 这不是省略：Router 派完活这一轮就结束了，Worker 干完自己写 `report`。
双层架构的分界线不是"谁有工具"，而是**谁拥有上下文**与**谁拥有终止判定权**。

---

## 3. 逐面规格

### 3.1 身份与生命周期

| 问题 | 规格 | 现状 |
|---|---|---|
| 一个执行体是什么 | `worker` 行（`name` / `template` / `skills` / `thread_id` / `owner_id` / `model_ref` / `tool_policy`）+ **独立的 `agents/<workerId>.sqlite`** | ✅ `runtimeIdentityFor`：`runtimeKey = workerId ?? assigneeId` |
| harness 按什么开库 | 按 **worker**，不是按人、不是按线 | ✅ `harnessBrain.harnessFor(identity)` |
| 何时创建 | 开线时按模板挑人：技能匹配，目标文本里点名的技能权重 ×10 | ✅ `workerPool.pickWorker` |
| 何时退休 | 线收尾时 `unsubscribe` + `retireWorker` | ✅（但见 §7 W-G4：收线前没检查还有没有活在跑） |
| 模型 | **创建时钉住**；改公司默认不会偷偷换掉它的脑子 | ✅ `resolveWorkerModelRef` |
| 思考档位 | 跟全局设置走（执行体不单独配） | ✅ `deps.thinking()` |
| 跨任务连续性 | **不靠会话，靠交接 + 记忆** | ✅ 设计如此，见下 |

**「连续」在这层的准确含义**：一任务一个新 conversation。下个任务通过「这条线之前发生过什么」
的交接块 + 线级记忆获得连续性，而不是接着上一份会话往下跑。

为什么：会话连续 = 上下文单调膨胀 = 上一件事的失败细节永久稀释注意力。文章说 Worker
上下文隔离，隔离的是**任务**。线的连续由 Thread 和记忆承担，不是由会话承担。

### 3.2 上下文：九段提示词 + 一个按需出口

一次尝试的提示词是**契约**——段序有测试锁住（`harnessBrain.test.ts`），因为顺序本身在表达优先级：

| 序 | 段 | 来源 | 为什么在这个位置 |
|---|---|---|---|
| 1 | 任务 / 说明 / 交付物 | Router 派活时写的 `title` / `brief` / `deliverableSpec` | 先知道要什么 |
| 2 | **原始记录**（ID + 摘要） | `task.records`（这条线的事件 / 汇报 / 历史任务） | 它是**证据**，不是要求；放前面模型会以为那是任务本身 |
| 3 | 要求（写文件、离线检查、及时结束） | 静态 | 行为底线 |
| 4 | **你中途改的方向** | `task.steering` | 后说的、优先级最高，明写「冲突时以这里为准」 |
| 5 | 常驻约束 | `task.standing`（记忆 L0） | 他刚说的 |
| 6 | 做事规矩 | `task.procedural` | 他对**输出**的要求 |
| 7 | 工作台规定 | `task.facts`（global） | 配置的默认值，最容易被覆盖 |
| 8 | 相关经验 | `task.memories` | 建议不是约束，放最后 |
| 9 | 上次验收反馈（stdout / stderr 尾部） | 重试时 | 修错要看到真实错误 |

**按需出口**：`recall <id>` 取原文——分页、限长、作用域收在「我这条线」。和 Router 用同一个
`spillText`，两层看到的是同一段文字（`05-router-real.md` §5 立下的原则）。

**必须不进上下文**（是设计，不是巧合）：

- Router 的推理、别的线的任何内容、Watchdog 的判断；
- 全量事件正文（只给 ID + 摘要）；
- 上一次任务的完整会话（只给交接块）。

### 3.3 手：工具带分层装配

| 层 | 内容 | 规则 |
|---|---|---|
| essential | `coding-tools`（read / write / edit / bash） | 永远装 |
| 系统 | `opc.work`（durable task 定义）、`opc.sandbox`、`opc.limits` | 永远装；`opc.work` 少了，恢复会 `blocked: missing_task` |
| 条件 | `opc.image` / `opc.speech` / `opc.decision` / `opc.ocr` / `opc.memory` / `opc.skills` / `opc.investigate` / `opc.decompose` | **能跑才装** |
| 常驻 | `opc.recall` / `opc.escalate` / `opc.handback` | 查库或写库，不会失败 |
| 外部 | 用户开启的 pi extensions | 最后装，沙箱与限额仍看得见 |

**一条装配规则**：**装一个只能失败的工具，比不装更糟。** 每个条件槽带 `available` + `reason` 码，
`capabilities()` / `stack()` 和 `buildRegistry()` 读同一份槽——所以页面不可能描述一个模型拿不到的工具。

**权限三层叠加，各管一件事**：

| 层 | 管什么 | 位置 |
|---|---|---|
| `tool_policy` deny-list | 裁菜单（哪些工具对它可见） | `toolPolicy.ts` |
| `opc.sandbox` | 管路径可写根与出网 | `sandbox/workspaces`、`beforeTool` 单一收窄点 |
| `opc.limits` | 管次数（默认 12 次/会话，可 `OPC_MAX_TOOL_CALLS` 覆盖） | `sandbox/toolLimit.ts` |

限额的失败方式是**返回一句「已达上限，请基于已有文件结束」**，不是抛错——因为抛错会拖垮任务，
而"被拦住"能让模型自己收尾。

### 3.4 轨迹：`trace`（规格新增）

**问题陈述**（不是推测，是读代码的结论）：一次 LLM 尝试只往 `task.steps` 写 4 条系统旁白
（`harnessBrain.ts` 的四个 `log` 调用），工具调用、改了哪个文件、读了什么——一条都没有。
所以现在：界面进度近乎装饰、Watchdog 的 `spinning` 形同不触发、判偏离没有材料。

**规格**：

```ts
// 新表 task_trace（不复用 task.steps：那个是人读的叙述，这个是结构化的过程）
{
  id, task_id, seq,
  at,
  kind: 'tool' | 'file' | 'decision' | 'usage' | 'error',
  name: string,          // 'bash' / 'write' / 'escalate' / 'read'
  argsDigest: string,    // 参数摘要：长命令取头 + 长度，不落全文
  ok: boolean | null,    // null = 不知道（见下）
  ms?: number,
  tokens?: number,
}
```

六条规则：

1. **不进 Router。** 结论走 `report`，过程走 `trace`；混了就有一条路要塌。
2. **必须裁剪**：每任务保留头 50 + 尾 200 条，中间折叠为一行「略去 N 步」。长任务不能撑爆库。
   裁剪**只删中间**，所以 `seq` 会留空洞——那正是「略去 N 步」的依据，不能重编号。
3. **可召回**：`recall task:<id>` 给轨迹摘要，顺着 ID 取全文（和事件链同一个模式）。
4. **来源只有一处**：pi 的 `tool_execution_start` / `tool_execution_end` 事件流
   （`watchEvents(harness, conversationId, ctx)` 已在依赖里），**不靠模型自述**。
5. **失败也记**：工具被沙箱拒绝、被限额拦住、超时，都是最有信息量的那几步。
6. **成败是三态，不是二态**（下面单列，因为这是真跑一次才发现的）。

它的三个消费方，一个都不能少：

| 消费方 | 用它做什么 |
|---|---|
| 界面 | 「它现在在干什么」——真实动作，不是旁白 |
| Watchdog | 判「有没有实质进展」「是不是在绕同一圈」的材料 |
| 复盘 | 事后回答「它为什么这么干」 |

#### 落地之后改掉的一条：`ok` 必须是三态

第一版把它写成 `ok: boolean`（`NOT NULL DEFAULT 1`），理由是"成败当然只有两种"。真跑一次
就发现不是：

- pi 在**工具任务 faulted**、以及**调用所在的运行结束了**这两种情况下，都会发一个
  **不带结果行**的 `tool_execution_end`，而我们无法区分这两件事；
- 前者是真失败，后者常常什么都没发生。

于是「不知道」被写成了「成功」——界面上出现一条 ✓，而那一行后面什么都没有。这和
`acceptanceGate` 里"没有闸门就说验不了"是同一个错误：**系统替自己没验证过的事下结论。**

所以：`ok` 可空，`null` 渲染成 `·`（不是 ✓ 也不是 ✗）。真正的失败另有来源——
`task_failed` 事件给的是确定的 `ok: false`。

另外一条实现细节值得记：`tool_execution_start` 的 `args` 来自工具任务的 checkpoint，
**调用开始后那个 checkpoint 会被清掉**，于是有些 `bash` 动作只剩一个空参数。可靠的
参数来源是助手消息里的 `toolCall.arguments`（`message_end`），所以两处都读、先到先得。

#### 落到了哪

| 东西 | 在哪 |
|---|---|
| 表与迁移（V42 建表、V43 把 `ok` 改成可空） | `data/schema.ts` |
| 读写、`seq` 续号、只删中间的裁剪 | `data/taskRepository.ts`（`appendTrace` / `listTrace` / `maxTraceSeq` / `pruneTrace`） |
| 事件 → 一行动作、参数摘要、三态判定 | `work/trace.ts`（`applyAgentEvent` / `digestArgs` / `readOutcome`） |
| 接到执行体的一次尝试上 | `work/harnessBrain.ts`（`attachTraceStream`，在 `finally` 里 stop） |
| Router 的 `recall task:<id>` 也读它 | `router/routerHost.ts` |
| 界面「动作」一节 | `pages/issues/IssueListPage.tsx`（`data-testid="issue-trace"`） |
| IPC | `IPC.work.trace` / `WorkBridge.trace` |
| 渲染（界面与 `recall` 共用一份） | `packages/shared/src/trace.ts`（`describeTrace` / `renderTrace`） |

**观测不能拖垮任务**：事件流接不上、写不进库，都只是"这次没有轨迹"，只 warn 一次，
绝不抛进执行路径。这条有专门用例（`trace.test.ts`「写不进库也不抛」）。

### 3.5 嘴：三个动作，一条通道

| 动作 | 什么时候用 | 落到哪 | 线的状态 |
|---|---|---|---|
| `report`（终局） | 任务结束 | `threadOutcomeFor` 纯函数映射（下表） | 见下表 |
| `escalate` | 中途卡住、需要人拍板 | `report(decide)` + 步骤 `请示[subject]：…` | `waiting` |
| `hand_back` | 这活不该我做（超出当前任务范围） | 退订 + `report(decide)` + 线回 `open` | `open`，**不算失败** |
| `close_line`（Router 的动作） | 这件事结束了 | 线 `done` + 一条 `silent` 记录 | `done`——**但有活没跑完时收不了** |

**终局映射就是产品承诺**，所以它是纯函数 + 逐状态用例（`threadOutcome.test.ts`）：

| 结局 | 线状态 | 说话级别 | 理由 |
|---|---|---|---|
| 闸门过 + 有闸门 | `done` | **`silent`** | 正常干完不该打断人 |
| 过了但没有可执行闸门 | `waiting` | `decide` | 只证明文件落了，不能声称判定过 |
| 闸门没过 | `waiting` | `decide` | 带原因，人决定下一步 |
| 跑挂 | `failed` | `decide` | 必须是一句人话 |
| 静默线 + 闸门过 | `done` | `notify` | 投机成功才值得说 |
| 静默线 + 没过 / 无闸门 | `archived` | `silent` | 「我试过了，不值得」本身是结论 |
| 已交回 | — | — | 不是失败，不消耗尝试 |
| 待人工确认（`review`） | `waiting` | 不说 | 确认一次就好，不要每轮都看一眼 |
| 已取消 | `archived` | 不说 | — |

**三条硬规则**：

1. **进度永不进 `report`**。这是两层架构的分水岭。
2. **同一件事请示第二次起降级为 `notify`**——一件事要你拍两次，说明它不该接这件事。
   判据是**同一个 `subject`** 数过几次（`请示[deploy.target]：…`），不是"这条任务问过几次"：
   按任务数会把**两个不同的问题**当成一件，第二个真正的新问题就被静音了（W-G5）。
   没写 subject 的老请示与带 subject 的新请示互不干扰。
3. **静默线永远不 `decide`**。投机的前提就是这件事还没有确定性价值，反过来向你要决定是自相矛盾。
4. **有活没跑完就不收线**（W-G4）。收线会把执行体 retire，而任务还在后台跑——它的汇报之后
   落到一条已经结束的线上，界面上表现为"一件刚从没存在过的事"。这条判据只有一处
   （`router/threadBusy.ts`），外部结束信号（PR 合并）和 `close_line` 共用它。

`report` 会带上这条线的**原始信道地址**（`thread.reply_target`，V41），由 Router 决定回桌面还是回
GitHub / 飞书 / 钉钉。执行体自己不知道也不需要知道"人从哪来"。

### 3.6 判据：谁有权说"完成"

```
produce（干活，带 durable checkpoint）
   └─► verify（沙箱外跑 acceptanceCommand，看退出码）
          ├─ pass ───────────────────► accepted
          └─ fail 且 attempts < 3 ───► 回到 produce（带 stdout/stderr 尾部）
                └─ attempts 用尽 ─────► rejected
```

**判据永不在执行体手里。** 它写文件、它跑离线检查，但：

- 「过没过」由**沙箱外的退出码**判（模型在沙箱内跑，验收在沙箱外跑）；
- 「值不值得」由**人**判。

推论：**没有可执行验收条件的任务，结论只能是「需要人看一眼」**，不能是「通过」。
这条是 W1 的直接后果，也是这套系统最容易被自己骗过去的地方。

### 3.7 失败分类

现在只有一句 `error` 字符串。规格要求分类，因为**每一类的重试语义不同**：

| 类别 | 例子 | 会不会重试 | 线状态 | 说话 |
|---|---|---|---|---|
| `retryable` | 运行时被打断 / 阶段抛了 / 跑它的进程没了 | 可能好，值得再点一次 | `failed` | `decide` + 「再跑一次通常就好」 |
| `rejected` | 闸门退出码非 0 | 已经在任务内部带反馈重试，用尽才停 | `waiting` | `decide` |
| `unverified` | 没有可执行闸门 | ❌ 重试没有意义（缺的是判据） | `waiting` | `decide` |
| `needs_decision` | `escalate` | ❌ | `waiting` | `decide` |
| `handed_back` | `hand_back` | ❌（不算失败） | `open` | `decide` |
| `blocked` | 没模型 / 前置未完成 | ❌ 重试一万次也不会好 | `failed`（立刻） | `decide` |
| `cancelled` | 线被收 / 人取消 | ❌ | `archived` | 不说 |

**为什么必须有这条**：分类之前，「缺模型」和「闸门没过」都写成 `failed`，前者会得到一个永远
不会好的重试，后者被说成"跑挂了"。于是用户看到的是一个**反复失败的任务**，而它其实一次都
没真正跑起来——这是账本最坏的一种状态。

后两类（`needs_decision` / `handed_back`）是**线的状态**而不是任务的失败，由线程与汇报表达；
放进同一个词表是为了让界面只有一套话。

#### 落到了哪

| 东西 | 在哪 |
|---|---|
| 七个种类 | `packages/shared/src/domain.ts` 的 `TaskFailureKind`；`WorkTask.errorKind` |
| 存储 | `task.error_kind`（**V44**），仓储读回时只认那七个，别的当"没分类" |
| 判定（纯函数） | `work/failure.ts` 的 `classifyTerminal({ outcome, verdict, unverified })` |
| 落点 | `durableWorkRunner.awaitOutcome`（终态）、`resumeInterrupted`（缺 durable 记录）、`workService.refuseToStart`（没模型 / 前置未完成） |
| 变成人话 | `threadOutcome.ts`：原因 + **所以呢**（`FAILURE_ADVICE`），静默线仍然只说一次 |
| 界面 | issues 详情里的失败标签（`data-testid="issue-failure-kind"`） |

**没做的一件事，和它的理由**：`retryable` 不会自动重跑。自动重投一个 faulted 的 durable 任务
需要先想清楚"重投几次、重投时那条线的预算怎么算"，贸然加一个循环只会把一次失败变成一串失败。
现在它被**标出来**，人（或 Router）点一次就行——而"该不该重试"这个问题已经被回答过了。

#### 一个只有测试会发现的坑

`repairOwnershipColumns` 重建 `task` 表时用的是**固定的列清单**（`TASK_WITH_OWNER` + `carried`）。
加一个列却忘了同步这两处，重建就会把那一列悄悄丢掉，或者在老库上报 `no such column`。
V44 加 `error_kind` 时就踩到了：`companyDatabase.test.ts` 立刻红。**以后给 `task` 加列，
这两处必须一起改。**


### 3.8 成本：只记账，不封顶（判断）

- 每次尝试结束 `reportUsage` → `task.tokensUsed` / `costUsd` → `threads.charge`；
- **每线预算上限：不做。** `thread.budget_tokens` 保持 `null`，`charge()` 因此永远不会
  真的拦下任何东西——这是有意的，不是没做完。

为什么不做，说清代价：

1. **上限只有在"该不该停"能判的时候才有意义。** 一条正在收敛的长任务和一个在原地打转的
   任务，花的钱一样多；用同一个数字去拦，前者被冤枉、后者照样能绕过去（换条线接着花）。
   真正该判的是「还在不在往前走」——那是 Watchdog（§6）和失败分类（§3.7）的事。
2. **硬上限和本项目的 P6 直接冲突。** 杀掉一个马上要成功的运行是明确禁止的聪明；而
   "越线只发一条 decide、不真的停"其实等于没有上限，只是多一条打扰。
3. 单机、一个人、事件量小，成本失控**目前不是**这个产品的主要风险。

代价照实说：**"这笔活值不值"这个问题，现在只能靠人看数字回答，系统不会替他拦。**
界面上 tokens / 成本一直看得见（`task.tokensUsed`、`costUsd`、线的 `spentTokens`），
只是没有任何东西会因为数字变大而停下来。

如果哪天要做，正确的形状大概率不是"给每条线一个数字"，而是"发现它在原地打转就叫人"——
那件事挂在 §3.4 的 `trace` 上，不在这个数字上。

### 3.9 自我延伸

| 能力 | 是什么 | 限制 | Router 看得见吗 | 账记在谁头上 |
|---|---|---|---|---|
| `investigate` | 把一段**思考**交给干净上下文，只拿回结论 | 深度 1（串行即深度）、每任务 ≤3 次、空问题不派 | **透明**，只留 `[查 n]` 步骤 | 父任务 |
| `decompose` | 拆**交付物**成子任务 | 至少还有另一个执行体 | **看得见**（子任务各自汇报） | 各自任务 |

**这两件事不能混。** 拆思考不落库、没有闸门；拆交付物新任务新线、各自验收。混在一起会得到一个
既贵又慢的东西——每条线都变成多执行体，Router 要为每个子任务各说一次话。

---

## 4. 与 Router 的契约

| # | 契约 | 守在哪 |
|---|---|---|
| 1 | Router 只传**目标 + 验收规格 + 并线键**，不传执行细节 | `open_line_of_work` 的参数面 |
| 2 | 执行体**不回调 Router**，只写 `report` | `threadOutcomeFor` |
| 3 | 执行体**不能改线的目标**；要改只能 `escalate` 或 `hand_back` | 工具带里没有 `set_goal` |
| 4 | 执行体**不能自己判完成** | 判据在沙箱外 + 人 |
| 5 | 同线新事件**直通**给订阅的执行体，由它自己的 FIFO 队串行消费 | `subscription` + `ownerQueue` |
| 6 | 执行体**可以退订**（`hand_back`）——这是文章明写的出口 | `handBackFor` |
| 7 | 进度**永不**出现在 Router 输入里 | `escalateFor` 的注释即规范，有测试 |
| 8 | Router 换模型 / 思考档，**不影响**已在跑的执行体 | 模型创建时钉住 |

第 5 条的准确口径：直通不是"往正在跑的上下文里插话"，而是"在这条线上落一条新任务，排进这个
执行体的队"。原因是 W3——两轮 run 并发写同一份 sqlite 会把会话毒化。

---

## 5. 状态机

```
task:    open ──► running ──► accepted ──► delivered（人的确认）
                    │  ▲          │
                    │  └─ rejected（< 3 次，带反馈重试）
                    ├──► failed（blocked / 尝试用尽）
                    └──► cancelled

thread:  open ──► running ──► waiting（等人拍板）──► running …
                         └──► done / failed / archived（收线）

worker:  idle ──► running ──► idle ──► retired（线收尾时）
```

**最坏的状态是「卡在进行中」**：所以每个出口都必须落一句人话，包括"我不知道为什么"。

---

## 6. 对照文章：Worker 核心思想逐条

| 文章要求 | 本规格 | 现状 |
|---|---|---|
| 各 Worker 彼此上下文隔离 | 一执行体一 harness，一任务一会话 | ✅ |
| 并发执行 | 并行在**线之间**，不在执行体之内 | ✅ |
| 挂载完整执行工具 | 分层装配 + 条件槽 + deny-list + 沙箱 + 限额 | ✅ |
| 通常配置能力最强的模型 | 模型跟执行体走、创建时钉住 | ✅（Router 已有独立轻量档） |
| 不直接与人交互 | 注册表无聊天工具，只有 `report` | ✅ |
| 推理与工具调用不输出到外部信道 | 但**必须落 `trace`**（W6） | ✅ `task_trace`（E5） |
| 向 Router 汇报状态 | 终局 `report` + 中途 `escalate` | ✅ |
| 少数跨任务协同由 Router 中转 | `decompose`：子任务各自成线、各自验收 | ✅ |
| 内部可再开 Subagent / 本身是 Agent Team | `investigate`（深度 1、透明、≤3 次） | ✅ 简化版；Agent Team 不做（§9） |
| §3.2 超出范围可取消订阅 / 交回 | `hand_back`：退订 + 线回 `open` + `decide` | ✅ |
| §3.3 召回内联下一跳 ID | `records` 给 ID + 摘要，`recall` 顺着跳 | ⚠️ 线级一跳有，任务内轨迹还跳不过去 |
| §3.4 投机执行 | 只做后一半（静默线），见 §9 | ✅ |
| §4.1 异步 ReAct Loop | 派活本身异步；执行体内工具调用仍同步 | ❌ 判断不做（§9） |
| §6 Watchdog 判「实质进展 / 方向偏离」 | `trace` 给了判据 | ⚠️ 程序层有；语义层还没接，但材料（动作流）已经在了 |
| §5 计算 / 状态 / 环境分离 | 本地优先，三者天然合一 | ❌ 不做（已记代价） |

---

## 7. 真实缺口

按「用户能不能感觉到」排序。

| # | 缺口 | 症状 | 修法 |
|---|---|---|---|
| ~~**W-G1**~~ | ~~没有 `trace`~~ | ✅ **已修（E5）**：界面「动作」一节、`recall task:<id>`、库里的 `task_trace` 都读同一份 | 见 §3.4 |
| ~~**W-G2**~~ | ~~失败不分类~~ | ✅ **已修（E6）**：七个种类落库、判定是纯函数、汇报带「所以呢」 | 见 §3.7 |
| ~~**W-G3**~~ | ~~线的成本上限没人设~~ | **不做**（判断，不是缺口）：只记账，不封顶。理由与代价见 §3.8 | — |
| ~~**W-G4**~~ | ~~收线不检查还有活在跑~~ | ✅ **已修（E8）**：判据抽成一处（`router/threadBusy.ts`），`close_line` 与外部结束信号共用 | 见 §3.5 |
| ~~**W-G5**~~ | ~~`escalate` 归并粗糙~~ | ✅ **已修（E8）**：按 `subject` 数「同一件事问过几次」 | 见 §3.5 |

**Worker 层没有遗留缺口了。** 剩下没做的都是判断过的（§9），不是没做完。

---

## 8. 分期

| 阶段 | 内容 | 交付判据 |
|---|---|---|
| **E5 · trace** ✅ | 落 `task_trace`、裁剪、`recall` 读、界面「它现在在干什么」 | 一个真实任务能在 1 秒内回答「最近 20 步做了什么」；Watchdog 判据从 3 条变 4 条 |
| **E6 · 失败分类** ✅ | 七类落库 + 重试语义 + 界面区分 | 「缺模型」不再重试；`rejected` 带反馈重试仍 ≤3 次 |
| **E7 · 成本闸门** | ❌ **不做** | 只记账、不封顶；理由与代价见 §3.8 |
| **E8 · 收尾加固** ✅ | 收线检查在建任务；`escalate` 按 subject 归并 | 收线后不会再有任务往这条线汇报 |

**E5 已落地**（§3.4 的「落到了哪」）。真实库跑过一次的读数：一条任务留下 5 行动作
（`write server.js` / `write README.md` / `bash node --check …` / `read server.js` / `模型用量`），
其中 `bash` 那条是**确定的失败**（`ok: 0`）——这正是以前完全不存在的证据。

顺带发现两件只有真跑才会暴露的事，已写进 §3.4：`ok` 必须三态（见那一节），以及
`tool_execution_start` 的参数可能为空、要靠助手消息里的 `toolCall.arguments` 补。

**E6 已落地**（§3.7 的「落到了哪」）。真实库升到 V44，`task.error_kind` 就位；老任务读回来是
"没分类"，按各自的 `status` 走原来的措辞，不猜。

**E7 已取消**：预算封顶这件事判断为不做（§3.8）。

**E8 已落地**：两处都会把「已经结束」和「还在跑」搞混，修的是正确性不是外观——

1. **`close_line` 现在会拒绝**：线上还有 `open`/`running` 的任务就收不了，并把是哪几件说清楚。
   判据抽到 `router/threadBusy.ts`，和外部结束信号（PR 合并）**共用同一份**——分开写迟早会漂移。
2. **请示按 `subject` 归并**：`请示[deploy.target]：…`。等级从"这条任务问过几次"变成
   "**同一件事**问过几次"，于是第二个真正的新问题照样能打断人。
3. 顺带修掉 E6 留下的一个错位：durable 任务被 `aborted` 时，status 原来是 `rejected`
   （会触发一条 `decide`），现在按分类落 `cancelled`，由 `threadOutcomeFor` 静默归档。

**这一层到这里就齐了。** 剩下的空白不在 Worker 内部：Watchdog 的语义层（§6，判据已由
`trace` 提供）、跨月长程记忆（§8.1）、链式召回的完整引用图。

---

## 9. 判断为不做的

| 不做 | 理由 |
|---|---|
| **Agent Team（执行体内多角色）** | 文章说「可以」，不是「应该」。它把 Lead 的推理做重了，而文章自己说 Router 只管任务之间。`investigate` 覆盖了「一次能处理多复杂」的实际需求，代价是深度只有 1 层 |
| **工具级 `start()` / `stop()`** | 收益是「同一会话内并行推进多件事」，而 W3 规定一个执行体一次只推一件；真正的并行在线之间。为它改 harness 的相位语义（durable checkpoint 假设工具同步）是拿正确性换一个不想要的形状 |
| **执行体之间点对点通信** | 共享事件流已经给了有序交集；点对点要重答「谁先、死了怎么办、丢了怎么补」 |
| **每个执行体独立进程** | 隔离靠 harness + workspace 已经够；独立进程会把 durable checkpoint 和 sqlite 锁变复杂，收益在单机单用户下看不见 |
| **投机执行的前半（提前跑）** | 单机串行执行体时提前做只是抢同一个人的时间。后半（说不说）已用静默线做了 |
| **执行体自己决定汇报级别** | 级别是产品承诺，必须由 `threadOutcomeFor` 这类纯函数按结局算出，不能让模型自评 |
| **每线预算上限（成本闸门）** | 只记账、不封顶（§3.8）。上限只有在"该不该停"能判的时候才有意义：一条在收敛的长任务和在原地打转的任务花的钱一样多，同一个数字拦不住后者也冤枉前者。硬停又和 P6 冲突。代价照实说：**"这笔活值不值"只能靠人看数字，系统不会替他拦** |

---

## 10. 验收：每条不变量都要有能红的用例

| 不变量 | 用例 |
|---|---|
| W1 | 无闸门任务 → `waiting` + `decide`，**绝不** `done` |
| W2 | 同线两个执行体互相 `recall` 不到对方的事件 |
| W3 | 同一 owner 两个任务并发入队 → 第二个不覆盖第一个（已有） |
| W4 | 装进去的执行体 `workerSilent`（已有） |
| W5 | 一次尝试的 token 同时落在 task 与 thread 两层 |
| W6 | `report` 队列里**没有**任何 progress 行；`trace` 里**有**工具调用 |

W6 那条是 E5 的验收标准：两个断言必须同时成立，缺一个就说明结论和过程又混在一起了。

---

## 11. 一页纸

- 执行体 = **一个目标 + 一份隔离的上下文 + 一整套工具 + 一条收窄的外向通道 + 一份可判定的产物**。
- 它被剥夺了两件事：**判完成的权力**（在沙箱外的退出码和你手里）和**说话的权利**（只有 `report`）。
- 它对 Router 只汇报结论，对系统留下轨迹，对人保持沉默。
- 隔离的粒度是任务；串行是正确性；成本归因到线（**只记账、不封顶**）；每个出口都要有一句人话。
- 有活没跑完就不收线；同一件事请示第二次才降级。**这两条是"别把还在跑的说成结束了"。**
- 六条不变量现在都有守卫、也都有会红的用例。剩下的空白不在这一层（Watchdog 语义层、
  跨月记忆、完整的召引用图）。
