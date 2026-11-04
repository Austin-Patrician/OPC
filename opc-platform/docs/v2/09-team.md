# 09 · 团队：拆开之后谁收口

> 原文 §2.2 的一句话我们只做了一半：
>
> 「每个 Worker Session 在内部也不必局限于单个会话……也可以本身就是一个 Agent Team。」
>
> 前半句（拆思考）是 `08-worker.md` 的 E2。这一篇是后半句（一个执行体就是一支队伍）。

---

## 1. 差在哪：拆开之后没有人收口

`decompose_task` 会出现，是因为一个交付物常常要几件不同的活。它做对了三件事：子任务落在**同一条
线**上（一件事还是一件事）、各开一个执行体（各自的存储与工具集）、各自过闸门（谁也别替谁通过）。

它漏掉的是**拆开之后**：

| 该有的 | 以前 | 后果 |
|---|---|---|
| **等** | 父把子任务派出去就继续往下走 | 父的交付物里没有子的产物，而闸门只判父自己的目录——它会**通过** |
| **收** | 父看不到子交了什么 | 想汇总只能靠"它自己去翻这条线"，翻到的是子的**请求**，不是子的**产物** |
| **谁说** | 任何任务跑完都改线状态 | 父还在等子，线已经 `done`；子再失败，线变 `failed`。你看到的是最后写进去的那一条 |

三件里最贵的是第三件：它不是"信息少了"，是**线在说谎**。一条线说 `done` 的时候，如果还有一个
子任务在跑，那么"这一件事做完了"这句话就是错的。

## 2. 三个面，各自的判据

| 面 | 判据 | 落在哪 |
|---|---|---|
| **等** | 拆解过的任务至少收口一次；有子任务没交回就继续等；等有上限 | `workTaskDefinition` 的 `collect` 阶段 |
| **收** | 子任务给的是**结论 + 产物路径**，不是一段叙述 | `work/children.ts` 的 `buildChildren` + `WorkTask.children` |
| **谁说** | 一条线的状态由它的**根任务**决定，子任务只留记录 | `workService.reportToThread` 的 `isChild` |

三条判据都能落到一句话上：

- **等**：父不是在等时间，是在等别人的算力；
- **收**：收口只能靠产物，不能靠"它说它做完了"；
- **谁说**：团队只有一个收口人，那个人是根任务。

### 「至少收口一次」不是保守，是必须

子任务**已经跑完**的时候，父如果直接去验收，交付物就是一份不含子任务成果的东西——而且它会
通过验收。所以 `joined === 0 && 有子任务` 时无条件收口一次：这一次的用途不是等，是**让下一轮
看得见它们**。

## 3. 为什么没有用 pi 的 child task join

`pi-durable` 1.4.0 有现成的 join 原语：

```ts
return { status: 'waiting', checkpoint: { phase: 'decide', payments }, on: payments, policy: 'allSettled' };
```

它没有用，理由是一条硬约束：**`on` 里的任务必须在同一个 Harness 里**。而我们的隔离粒度是
「一个执行体一份存储」（`agents/<workerId>.sqlite`）——团队成员天然在**别的 Harness** 里。
用 `waiting` 就得把团队塞进一个 Harness，那等于放弃 E-A2 的隔离，为了一个语法糖烧掉存在的理由。

所以 join 落在唯一跨得过去的那一层：**我们的账本**（`task.parent_task_id`）。而等待仍然用平台
原语——`runtime.sleepUntil()`：

- 睡是**一次提交**，不占进程、不占 invocation；
- 重启之后接着睡，醒来还在同一个 checkpoint；
- 对照组是 `await new Promise(setTimeout)`：重启之后什么都不剩。

一句话：**等子任务不占进程、不丢状态，但也不假装它们是一棵树。**

## 4. 落到了哪

| 东西 | 在哪 |
|---|---|
| `TaskChild`（id / title / status / verdict / reason / artifacts）与 `WorkTask.children` | `packages/shared/src/domain.ts` |
| 交回判据、上限、状态的说法 | `work/children.ts` |
| `collect` 阶段（睡 750ms 看一眼，最多等 20 分钟） | `workTaskDefinition.ts` |
| 汇总那一轮的注入点（`注入 N 条子任务产出`） | `workTaskDefinition.produce` |
| 提示词里的那一段 | `harnessBrain.buildPrompt`，排在原始记录之后、要求之前 |
| 根任务决定线状态、子任务一律 `silent` | `workService.reportToThread` |
| 父的等待额度（45 分钟，其余 10 分钟） | `durableWorkRunner.awaitOutcome` |

## 5. 三处容易写错的地方

**① 收口一次 ≠ 等一次。** 见 §2。把 `mustJoinOnce` 去掉，最常见的那条路（子任务秒回）就会交出
一份没有子任务成果的交付物，而且它通过验收。

**② 子任务的 `decide` 要降级成 `silent`。** 子任务失败的时候，能判断该怎么做的不是你是父（父
知道全局，你只知道这一条）。让它直接进你的队列，等于把一个**中间状态**当成**结论**端上来。
唯一的例外是 `escalate`：执行体问的是"只有你能给的信息"，那本来就该打断你。

**③ 等要有上限，而且父的额度要单独放宽。** 两条都是同一件事的两面：挂着不动的任务是最糟的账
（`08-worker.md` §14 那句），所以 20 分钟等不到就带着"还有几个没回来"往下走；而父等的是**别人
的算力**，用 10 分钟判它超时，会把一次正常的团队协作判掉。

## 6. 用例

`children.test.ts`（9 条，纯函数）：交回的五种状态、`review` 不算交回、只报没回来的、产物路径
与结论（没有闸门写成 `null` 而不是"通过"）、按派出顺序、最多八条、状态用工作语域说。

`harnessBrain.test.ts`（+3）：子任务那一段的段序（原始记录 < 子任务产出 < 要求）、没有闸门的
被标出来、没有子任务时不留空标题。

`workThreadReport.test.ts`（+4，真库真 runner 真闸门）：

- **父任务等子任务交回之后才去验收**：子任务挂着的时候父停在"等"，`setStatus(child,'accepted')`
  之后才继续，且"子任务全部交回"排在"自动验收通过"之前；
- **子任务早就跑完了也要收口一次**：`收口 1 个子任务` + `注入 1 条子任务产出`；
- **子任务的终局不动线的状态，也不进你的队列**：线还是 `open`，队列为空，汇报全是 `silent`；
- **真的走一遍 `decompose`**：父汇总之后才交出一份通过验收的活，线由根任务关掉。

## 7. 还没做的（照实记）

| 缺口 | 为什么还没做 |
|---|---|
| 子任务的产物只有**路径**，没有正文 | 父可以 `recall <任务 id>` 取到交付物规格，但正文在子任务自己的工作目录里。跨目录读在沙箱上是放行的（`allow default`），但没有做"把产物正文带进汇总"这一步——那要看真实数据里父到底需不需要它 |
| 团队的 UI | `watchTaskGraph()` 能给出任务树，但我们的账本是自己的 `task` 表。团队面板要等 UI 那一轮 |
| 子代理还在用自造的隔离（`--sub.sqlite`） | 见 §8 |

## 8. 子代理已迁到 owned conversation

`08-worker.md` §13 里子代理跑在**另一份存储**（`<workerId>--sub.sqlite`）、用 `answer.md` 交接
结论、用模块级 `inFlight` 钉深度。当时的理由是"工具调用在等另一轮 generation 时，同一个 harness
里的调度顺序不确定"。

**那条理由没有依据。** 平台自己的示例 `21-subagent-foreground.ts` 就是"一个工具里等另一个会话"；
而我们的 `harnessBrain` 本来就在做同一件事（一个 durable 相位里 `submit` 一个会话再 `wait`）。
平台的写法是：

```ts
const child = await api.commit(async (tx) =>
  (await tx.createConversation({ ownership: { kind: 'task', taskId: api.taskId } })).id);
await api.details({ conversationId: child }, context);   // UI 能挂到子代理上
```

买了三样东西，都是我们手写不出来的：**中止会顺着所有权传下去**、**重启能找回同一个子会话**、
**界面能看见它在干什么**。

所以迁移之前先写了一个探针（`OPC_SUBAGENT_PROBE=1`）：临时库、临时目录、真模型，跑的是
**完整链路**——父任务在跑，`investigate` 里开一个归它所有的子会话，子会话用自己的上下文查
一件事，父拿回结论继续干，最后过真闸门。

三次运行的结果一致：

```json
{ "ok": true, "taskStatus": "accepted", "investigated": true,
  "verdict": "pass", "artifacts": ["server.js"],
  "agentStores": ["<workerId>.sqlite"],
  "steps": ["[查 1] …", "[查 1] 回来了：## 结论 最少 1 行 …", "自动验收通过"] }
```

`agentStores` 只有**一份**：没有 `--sub.sqlite` 了。

### 删掉的自造件

| 删掉 | 换成 |
|---|---|
| `<workerId>--sub.sqlite` | 子会话就在执行体自己那份存储里 |
| `answer.md` 文件协议 + `readAnswerFile` | `settled.answer` 那一条（具体 id，不是"最后一条消息"） |
| `harness.createConversation({ ownership: 'ownerless' })` | `api.commit(tx => tx.createConversation({ ownership: { kind: 'task' } }))` |
| `harness.createConversation` 上手工配 agent | `configure(tx, childId, { model, thinkingLevel, cwd })` |

换来三样手写不出来的：**中止顺着所有权传给子会话**、**重启认得出是同一个子会话**
（`scanConversations({ ownerTaskId })` + `requestId`）、**界面挂得上去看它在干什么**
（`api.details({ conversationId })`）。

### 留着的一个自造件，和为什么

`investigateTool` 里那个模块级的 `inFlight` / `used` 还留着。它管的是**深度 1** 和
**一次任务最多三次**，那是策略，不是平台能力。平台的等价物是给子会话 `configure` 时
`extensions: { remove: [investigate] }`——但我们的扩展对象是每次 `buildRegistry` 现造的，
拿不到稳定的引用，而按名字移除不是 1.4.0 的接口。等它有了，这一处也删。

### 探针本身

`OPC_SUBAGENT_PROBE=1 electron .` 会打印一段 JSON 然后退出，`ok` 的判据是三条同时成立：
模型真的派了子代理、父任务过了验收、`agents/` 下只有一份存储。它跑在临时目录里，
不碰真库、不往任何人的会话里写东西。
