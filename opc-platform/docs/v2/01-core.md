# v2 核心契约（S2 产出）

> 上游：`docs/v2/00-audit.md`。本文记录 S2 定下的事实，以及 B3 的迁移边界。
> 代码：`apps/main/src/data/threadRepository.ts`、`apps/main/src/router/router.ts`（迁移 V25）

---

## 1. 四个对象

| 对象 | 一句话 | 它替代了什么 |
|---|---|---|
| `thread` | 一条工作线：目标进，交付物 + 判定出 | `project_group` + `assignment` + `employee`（作为主语） |
| `worker` | 一次性执行体：模板 + 技能 + 当前 thread | `employee` + `position` + 汇报线 |
| `event` | Trigger：环境里发生的事，带两级过滤状态机 | `inbox_item` |
| `report` | 工作线对老板说的话，三级注意力 | `budget_alert` + 各种散落通知 |

**红线**：新代码里不出现 `employee` 这个词。中心实体是 `thread`。

---

## 2. Router 的一次 tick

```
pending events
   │
   ├─① 程序层过滤 ──drop──▶ triage='dropped'（不花 token、不开 thread）
   │
   ├─② 语义层判断（整批一次调用）
   │        └─抛错──▶ 整批留 pending 重试
   │
   ├─③ 接受 ──▶ 开 thread / 并入已有 thread
   │
   └─④ 派发
            delivered      → thread done        → report silent（不入队）
            needs-decision → thread waiting     → report decide（入队）
            failed         → thread failed      → report decide（入队）
            dispatch 抛错  → 同上，可见原因，不重试
```

### 三条不许改的规则

1. **干完活不打扰老板。** `delivered` 永远映射到 `silent`。这是产品承诺，不是默认值。
2. **judge 抛错 ≠ 全部拒绝。** 前者整批留 pending 重试，后者才丢事件。模型抖动不许造成静默丢失（P6）。
3. **executor 抛错不重试。** 已经写过文件的任务重跑会产生重复交付和双份账单——标 `failed` 并让老板决定。

---

## 3. 注意力三级

| level | 含义 | 进队列？ |
|---|---|---|
| `decide` | 需要你拍板（含失败） | ✅ 永远排最前 |
| `notify` | 知道一下就行 | ✅ 排在 decide 之后 |
| `silent` | 干完了，只在记录里 | ❌ |

`thread.attention` 默认 `silent`；`wake_quota` 在 B4 翻转为 `attention_quota`（从"限制打扰员工"改为"限制打扰老板"）。

---

## 4. B3 迁移边界（下一步）

三个消费者从 `org` 迁到 `thread`/`worker`，一次一个，每次都要能跑：

| 模块 | 现在挂在哪 | 迁到哪 | 风险 |
|---|---|---|---|
| `comm/`（1,809） | `employee` 的 inbox / `relationship` 的限流 | `thread` 的消息流；限流按 thread 计 | 会话生命周期（cooling/escalated）要重新定义 |
| `work/`（6,430） | `task.assigneeId → employee` | `task.threadId` + `worker` | 验收流水线**不动**，只换主语 |
| `budget/`（`work/budget*`） | 四轴（company/department/employee/project） | 两轴（thread/global） | billing 刚落地，B5 前别碰计费口径 |
| `memory/`（792） | 六层 × 每人一份 | 三层：全局偏好 / 每 thread / 跨 thread 知识 | `org_fact` → `knowledge` |

**迁移顺序建议**：`work`（收益最大、验收流水线可原样保留）→ `comm` → `budget` → `memory`。

**B4 才能删的东西**：`org/`、`employee`、`department`、`position`、`assignment`、
`relationship`、`evaluation`、`interview`、`employee_package`、`job`、`employment_event`、
`agent_candidate`、`project_group`。
在 B3 全部完成后，这一步应该变成"删掉不再被引用的东西"，而不是"改代码"。

---

## 5. 还没做的

- ~~`Router` 尚未接进 `index.ts`~~ → **已接**（`OPC` 非无头模式启动时）。它跑在
  `<userData>/inbox` 上，每 20 秒一个 tick。
- `event` 的生产者：**已有一个** —— `FolderWatcher`（`router/folderWatcher.ts`）。
  轮询而非 `fs.watch`：一次保存就是一条事件，不需要自己去做去重。
  日历 / GitHub / IM 还没接。
- **语义层（judge）故意还没有**：收件夹里的东西是老板亲手放进去的，
  "模型觉得这事重要吗"没有信息增量。它要跟着**嘈杂的源**（IM / GitHub）一起上，
  那时候才真的省 token。
- `attention_quota` 只是概念，表还没建。
- `resolveAssignee` 是临时实现（第一个在职员工）。B4 之后应改为
  "按线程模板实例化一个 worker"。

### R1 的验收口径

`inbox/` 里放一个文件 → 20 秒内出现一条 thread + 一个 task →
**可自动验收就静默关单，不可验收就在队列里等你拍板**。
日志里只会出现真正到达老板的那几条（`[router] {...}`），其余一律安静。

---

## 7. R2：任务落终态时汇报（`e79277f` / `f03dc11`）

`work/threadOutcome.ts` 把「要不要打扰老板」写成一个纯函数，先写测试后接线。
这是产品的承诺条款，不该藏在回调里。

| 任务状态 | 工作线 | 老板被告知 |
|---|---|---|
| `accepted` | `done` | 不打扰（`silent`，留在记录里） |
| `delivered` | `done` | 不打扰 —— 它**只**由老板终审产生，再问一次是问同一个人同一个问题 |
| `rejected` | `waiting` | `decide`：没通过验收，附原因 |
| `failed` | `failed` | `decide`：跑挂了，附错误 |
| `review` | `waiting` | **不报** —— 负责人还在看，一轮一报等于每轮都打扰一次 |
| `cancelled` | `archived` | 不报 |

接线点三个：跑完、负责人裁决、老板终审；按 status 去重，
避免 `已验收 → 待验收 → 已验收` 的中间态报两次。

**`createTask` 现在会自动开一条工作线**（标题=任务名，目标=brief），
所以派活 → 干活 → 汇报这条链对所有入口成立，队列不再只是文件夹 watcher 的附属品。
线的创建放在预算预留成功之后：被额度挡下的任务不会留下空线程。

顺带把 §8 的轴翻转落了第一步：任务结束时的 token 记到**工作线**上，
越过这条线自己的额度就发一条 `decide`，且只发一次。

---

## 6. B3-1 已落地，以及一个必须先拍板的发现

**B3-1（`9b80b24`）**：`task.thread_id`（V26）。任务能属于一条工作线，`decompose`
的子任务继承父任务的 thread。执行身份**没动**——`employee_id` 仍是执行者。

### 发现：harness 不能按 thread 开库

下一步本该是"运行时身份从 employee 换成 thread"（`agents/thread-<id>.sqlite`）。
但 `WorkService.harnessFor(key)` 在**开库那一刻**就把工具注册表和模型烤进去了
（`buildRegistry(employeeId)`）。而 `decompose` 允许一条线程下有多个执行者。

于是：

```
线程 T 有任务 A（李雷）和任务 B（韩梅梅）
harness 按 thread 开 → 谁先跑，谁的工具和模型就被缓存下来
                     → 另一个人拿着别人的工具跑自己的活
```

这不是可以忽略的边角：它会让"跑错了工具"变成静默错误。

### 两条路，需要选一条

| | 规则 | 代价 |
|---|---|---|
| **A** ✅ 已选 | **harness key = worker id**。一条线程有 1..N 个 worker，各开各的库 | 要先把 `worker` 行建出来并让 `employee` 与 worker 一一对应，B3-2 会大一些 |
| B | 一条线程只允许一个 worker，拆解改由该 worker 内部串行完成 | 组织协作能力回退，层级派活（F4）等于废掉 |

选 A 的理由：它同时是"助手模型"的自然形状——一条工作线由一个执行体负责，
它有自己的上下文；线程的记忆 = 它的 worker 运行轨迹 + 汇报 + 任务，通过
`thread_id` 聚合，而不是把不同人的轨迹塞进一个库。

### A 已落地（B3-2）

- `worker.employee_id`（谁填充这个执行体）+ `task.worker_id`（谁跑的）
- `runtimeIdentityFor(task)`：`runtimeKey = workerId ?? assigneeId`，`employeeId = assigneeId`
- `harnessFor(identity)`：缓存和 `agents/<key>.sqlite` 按 `runtimeKey`，工具注册表和模型按 `employeeId`
- `evictHarness(employeeId)` 改为**扫一遍**而不是查单个 key —— 一个人可能持有多个 worker，
  只关一个会让其余的继续用旧工具集
- 没有 `worker_id` 的旧任务自动退回按 employee 开库：老数据不需要迁移就能继续跑
