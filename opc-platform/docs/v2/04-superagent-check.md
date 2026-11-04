# 对着 Super-agent 的设计核一次方向

> 靶子：Super-agent 设计探索（DeepSeek Harness 团队），
> https://zhuanlan.zhihu.com/p/2099987320443237060
>
> 这份文档的用途：**每做完一块就回头对一次**。v2 的每一步都该能从那张图里
> 指出它对应哪个模块；指不出来的，要么是残留，要么是新需求。
>
> 下游：`05-router-real.md` 是 Router 层的落地口径，`07-memory.md` 是记忆，
> `08-worker.md` 是 **Worker 层的落地口径与分期（E0–E4）**，`09-worker-spec.md` 是
> **执行体的完整规格**（不变量、五个面、缺口 W-G1–G5、分期 E5–E8）。

## 0. 文章说了什么（五模块 + 四特征）

四个特征：**连续**（跨信道像一个 Agent）、**高效**（不等上一条就跑下一条）、
**主动**（观察事件而非等指令）、**持久**（长期在线、异常自愈）。

| 节 | 模块 | 一句话 |
|---|---|---|
| §2 | 双层架构 | **Router 层**常驻，承接人类交互与分派，**不直接干具体活**；**Worker 层**上下文隔离并发执行，**不直接与人交互**，向 Router 汇报 |
| §3 | 事件驱动 | 主要输入是环境事件（Trigger），不是逐条 prompt。两级过滤（程序 Fast Path + 语义 Slow Path）、订阅直通、Inline & Spill 与链式召回、投机执行 |
| §4 | 面向人的交互 | 异步 ReAct Loop（`start()`/`stop()`）让前台不被后台阻塞；不同信道匹配不同带宽 |
| §5 | 计算 / 状态 / 环境分离 | 计算无状态上云，状态进库；执行环境留在原地，端侧只放轻量 daemon |
| §6 | Watchdog | 主系统**之外**的独立 Control Loop，判断 Worker 是否真有进展、是否偏离目标 |

两条最容易被忽略、但文章反复强调的话：

- §2.1：「Router 层在设计上**不直接执行具体任务**，只负责人类交互与任务分派，
  甚至可以不配备 Bash 工具。」—— Router 是**序点**，不是**人手**。
- §2.2：「Worker **不会直接与人类交互**，其推理过程和工具调用不会直接输出到
  外部信道，而是向 Router 层汇报状态、由 Router 层统一向用户回复。」

## 1. 逐条对照：我们做到了哪

### ✅ 已经对齐（而且是承重的）

| 文章 | 我们 | 证据 |
|---|---|---|
| §2.1 Router 不做成聊天窗口 | `router/router.ts` 第一句注释就是这件事 | `tick` 是循环 + 队列，不是会话 |
| §2.1 批处理 | `judgeBatch` 一次判一整批，注释直接引原文 | 一次 LLM 调用摊薄 N 条决定 |
| §3.1 两级过滤 | `prefilter`（程序，零 token）+ `judge`（语义） | 被 drop 的事件永远不会碰模型 |
| §3 Thread 是事件流单位 | `thread` 表 + `openOrJoin`（判定说要并入就并入） | 同一个 PR / 话题的后续事件落在同一条线 |
| §3 事件而非 prompt 是输入 | `event` 表 + `FolderWatcher`（`source: 'folder'`） | 人不动手也会有事进来 |
| §6 Watchdog 在主系统之外 | 独立 `watchdog/watchdog.ts` | 判 spinning / stalled / orphaned |
| §8.2「以聊天窗口为中心是路径依赖」 | 首页改成注意力队列 `/attention` | 这是照文章做的，不是拍脑袋 |

### ⚠️ 故意简化（记下理由，不假装做到了）

| 文章 | 我们的做法 | 为什么可以暂时不做 |
|---|---|---|
| §3.2 订阅与直通（多对多） | 只有 Router → worker，没有「订阅」概念 | 原文 7.1 实测：去掉直通，完成时间基本一致，只是 Router 决策数 +30%、token +37%。单机、十级数量的事件流远没到瓶颈。**是性能优化，不是正确性** |
| §3.3 Inline & Spill、链式召回 | 对象有 ID，但注入时没有内联相邻对象 ID | 需要 worker 上下文组织到位之后才有意义，现在事件量小，全文注入还不吃亏 |
| §3.4 投机执行 | 没有 | 依赖「后台有富余算力」这个前提；单机串行跑 worker 时提前做只会抢同一个人的时间 |
| §4.1 异步 ReAct Loop | Router 与 Worker 已异步（Router 是循环、worker 跑 durable task），但 worker **内部**的工具调用仍是同步 | 工具级 `start()`/`stop()` 要改 harness，属 worker 内部事务 |
| §5 计算/状态/环境分离 | 本地优先桌面应用，三者天然合一 | 产品定位差异。代价是「持久」这条只做到进程级：靠 `runner.resumeInterrupted` 恢复，关机就停 |
| §6 Watchdog 是完整 Agent Session | 纯程序判断，不是 LLM 会话 | 程序能判的（无进展、超时、孤儿）先判掉；「方向是否偏离」需要模型，等有真实负载再说 |

### ❌ 真正的偏差（这一条是本轮发现的）

**聊天窗口里的对面是一个 worker，不是 Router。**

```
chat.sendMessage
  → pickResponders(conversation)          // 从 dm.memberIds 找 agent
  → buildReply(agent, text)
  → chat.replyWithModel({ agent, text })  // index.ts
      systemPrompt: `你是「${agent.name}」，岗位是 ${agent.role}。`
```

三处被违反：

1. §2.2「Worker 不会直接与人类交互」—— 这里一个 worker 正在直接对用户说话，
   而且用的是它的岗位人设。
2. §2.1「Router 是序点，不是人手」—— 用户的每句话都落进某个执行体的上下文里，
   Router 完全不在人机路径上。**`chat` 和 `router` 现在是两条平行的路。**
3. §2 双层架构的意义在于「Worker 的推理与工具调用被隔离在内部」—— 而现在
   Worker 的上下文就是用户看到的那个窗口，等于把双层压回单层。

原文 7.1 的实验正是在量这件事：带 Subagent 工具的单 Session，p95 = 29.5 分钟；
双层架构 p95 = 15.7 分钟。**方向反了，不是因为实现糙，是因为层次压扁了。**

### 这一条已经关掉（P0）

1. **聊天只剩一条会话**：`ensureAssistant` 是唯一的入口，对面永远是 Router；
   `openDirect(agentId)` 整个删了，连同 `pickResponders` / `buildReply` /
   `replyWithModel`（那句「你是「X」，岗位是 Y」的 systemPrompt）。
   现在 `sendMessage` 不管落在哪条会话上，都只是给 Router 的一条 Trigger。
2. **验证它的探针改了**：`OPC_CHAT_PERSIST_PROBE` 以前靠 `openDirect` 造一条
   执行体私聊、再等它回话——那等于用一个用例给违规行为背书。现在它在库里装一个
   执行体，然后断言**这个执行体没有开过口**（`workerSilent`）。

## 2. 我之前说错的那一条

上一轮我提：「**助手 = 默认执行体那一个 worker**，其余 worker 只在工作线上下文出现」。

这句话要解决的是一个**我自己虚构出来的难题**——「worker 随工作线临时存在，
而助手会话需要一张稳定的脸」。真实情况是：**助手会话不需要 worker 的脸，
它需要的是 Router 的脸。** Router 常驻，本来就有稳定身份，问题不存在。

而且代码里早就写对了，是 `chat/chatService.ts` 里 `ensureAssistant` 的注释：

> 员工彻底消失之后，它会变成 **Router 的那张脸**。

我上一轮的提案跟这句注释是矛盾的。以文章为准，注释对，提案错。

## 3. 另一条我说错的

上一轮我说 org 的剩余引用者「缺的是同一个东西：一份『谁能干活』的名单」。

不准确。`deps.org` 的真实用途分两类，只有一类是名单：

| 用途 | API | 落在哪 | 该搬到哪 |
|---|---|---|---|
| 挑人干活 | `everyone()` / `list()` | employee 行 | **worker**（真需要一张名单） |
| **执行体的工具集与模型** | `toolPolicyOf(id)` / `modelRefOf(id)` / `setStack(id)` | `employee.tool_policy` / `employee.model_ref` | **worker**（这是 §2.2 说的「Worker 挂载完整的执行工具」） |
| 部门路由 | `list()[].headEmployeeId` | department 行 | **删掉**（群已经创建不出来，纯死路径） |
| 聊天对象 | `agentsFromOrg` → `chat` | employee 行 | **删掉**（对面是 Router） |

第二类才是真正挡路的：它不是「一张名单」，是**两列数据长在了 employee 上**。
`worker` 表已经有 `model_provider` / `model_id` / `skills` / `template`，只缺
`tool_policy`。

## 4. 修正后的顺序

```
W1  worker 拥有工具策略                  worker.tool_policy（V28）
    ├─ capabilities() / toolStackOf 改读 worker
    └─ setStack 改写 worker
W2  chat 的对面是 Router，不是执行体      ✅ 4bf1f31
    ├─ ensureAssistant 不再依赖 agents[0]
    ├─ 新增 replyAsRouter 注入点，与 replyWithModel 分开
    └─ 连带删掉「选一个同事」的入口：通话按钮 / 加成员 / 档案抽屉 /
       Composer 的三个死按钮 / 标题栏 `+` 开始菜单
W3  chat 消息成为 Trigger                  §3.2 未订阅 → Router 判
    └─ source: 'im'；Router 决定「直接答」还是「开线派活」
W4  删 comm 的部门负责人路由              群已无法创建
W5  删 org/ + 12 张表
    └─ ensureDefaultExecutor → 「实例化一个 worker 模板」
```

W2 必须在 W5 之前，否则删表时 chat 没有身份可用。**已做**：`ensureAssistant`
不再读 `agents[0]`，聊天的身份来自 Router 而不是 employee 行。
W1 必须在 W5 之前，否则 worker 不知道自己的工具集。
W3 可以晚于 W5（那时 chat 已经只依赖 Router）。

**不做的**：直通、投机执行、链式召回、云端存算分离、LLM Watchdog。理由见 §1 的表。
