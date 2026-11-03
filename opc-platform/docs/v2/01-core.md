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
| `report` | 工作线对你说的话，三级注意力 | `budget_alert` + 各种散落通知 |
| `memory` / `fact` | 记住的事 + 定过的规矩（V33 改的名） | `employee_memory` / `org_fact` |

**红线**：新代码里不出现 `employee` / `org` / `boss` 这三个词。中心实体是 `thread`；
这个工作台里只有**你**和**它**（词表与 V33 迁移见 `06-vocabulary.md`）。

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

## 8. R3：首页可以丢目标（`1926d54`）

注意力队列页顶上一个输入框：一句话 → 开一条工作线 → 入队一条 `manual` 事件 →
立刻推一次 Router。**不直接建任务**：这件事值不值得做、该给谁做，仍然是 Router
的决定；UI 只负责把目标交出去。

Router 现在尊重**事件自带的 `threadId`**（`verdict.threadId ?? event.threadId`）：
老板打的字已经开好线了，再开一条会把同一件事拆成两条。

### 验收是分层的，不是一种（R4 修正了上一版的判断）

上一版这里写着「非软件类目标会一直验收没过」，并给了 A/B/C 三个选项。**那三个选项问错了问题**——它们都假设验收只有一种机制。对照三家之后：

| | 交付前怎么把关 | 谁判定"对不对" |
|---|---|---|
| **Super-agent** | 投机执行：「结果有价值就交付，没有价值就丢弃」；只交付自己能确认有价值的东西 | **人**。开放任务只做「备好草稿，待用户过目后确认发出」，从不宣称已验收 |
| **MUSE**（arXiv 数据科学 meta-agent） | 四层：摘要 / 监控 / **验证** / **steering**。验证是脚手架式的——按步骤临时生成验证计划和脚本 | **人**（steering 层）。验证计划人可读可改，不是退出码 |
| **Meta Muse**（消费级） | 常驻 VM + 浏览器，活动全程可回看，权限逐项授权 | **人**（"you can intervene at any point"） |

三家一致的结构：

```
① 进展监督（Watchdog）    → 别跑飞、别转圈         你还没有
② 可执行闸门（exit code）  → 能机器证明的才用        你有，但以前当成了全部
③ 人的确认（steering）     → 开放任务的最后一公里    你有 decide 报告，缺"确认后交付"的动作
```

所以 `workDispatch` 现在**按事件带不带闸门分两条路**：

- 事件带了 `acceptanceCommand` → 真闸门 → 通过就是 `delivered` → 静默关单
- 没带 → 用一个不判对错的空闸门（`node -e process.exit(0)`，流水线自己的
  「有没有产出文件」检查照跑）→ **必定 `needs-decision`**：
  「做完了，但我没有可执行的验收条件，判定不了对错。产出：summary.md」

好处是**不再浪费三轮重试去证明一个错误的判决**，也不假装"验收通过"。
空闸门不等于放弃验收——它只是把「对不对」交给唯一有资格判的人。

**还缺的一层**（下一步）：

1. ~~**steering 动作**~~ ✅ 已落地（`e5a9377`）：队列上「认可 / 重做」。
   认可 = 老板终审，工作线关掉；重做 = **新建**一个任务（旧任务预算已结算、
   验收已定案，重开会让账本和历史互相矛盾），brief 带上老板的话。
   为了让这条路走得通，「有没有闸门」这个知识从 dispatcher 挪到了**任务上**
   （`acceptanceGate.ts`）——否则老板返工时新建的任务不知道按哪种方式汇报。

2. ~~**Watchdog（进展监督）**~~ ✅ 已落地（`1dd0c0c`）：程序层，不花 token。
   `spinning`（最近 20 步里 5 步同一句）/ `stalled`（30 分钟无新步骤）/
   `orphaned`（开了 2 小时没开工）。它只**上报**不杀任务——诊断变成工作线上的
   一条 `decide`，由老板决定。同任务同问题只报一次。

### 三层验收现在齐了

```
① 进展监督（Watchdog）    ✅ 程序层，判「还在不在往前走」
② 可执行闸门（exit code）  ✅ 只用于能机器证明的活
③ 人的确认（steering）     ✅ 认可 / 重做
```

**还没做**：Watchdog 的模型层（「这段输出还在原目标上吗」）。
它更贵、更容易误判，应该在程序层证明抓得准之后再上。

---

## 10. B4 的实际形状（`75d9bf9` 是第一刀）

先说清楚：**整块删掉 `orgService` 不是一次提交能做完的事。**

剩余耦合实测（不含 org/ 自身与测试）：

| 文件 | org 相关行 | 为什么难删 |
|---|---|---|
| `index.ts` | 127 | 装配点，9 处 `new WorkService` 传 `org` |
| `ipc/register.ts` | 98 | 组织页/招聘页的通道（页已删，通道还在） |
| `work/workService.ts` | 28 | `resolveEmployeeModelRef` / `toolPolicyOf` / `subordinatesOf` / 部门预算轴 |
| `seed/firstCompany.ts` | 16 | `agentsFromOrg` |
| `comm/commService.ts` | 13 | 群聊路由按负责人 |
| `work/payroll.ts` + `budgetCenter.ts` | 12 | 部门/员工预算轴 |

**已做（`75d9bf9`）**：把「谁来做」从「第一个在职员工」换成 `pickWorker` 按模板匹配技能，
并且 `workerId` 变成任务上被记录的事实。这一步本身就除掉了员工体系最坏的症状。

**已做（`a1d37fe`）B4-1**：删掉 22 个组织/招聘 IPC 通道 + 只服务于它们的辅助函数
（`refreshOrg` / `readModelRef` / `readSkills`），净删 303 行，零行为变化。
`org.list` 当时留了下来——onboarding 还要用它显示"当前有几个人"；B4-3 把它换成了
`workers.list`（读 `ThreadRepository.listAllWorkers()`）。

**已做（`7c0c231`）B4-2**：首启自动建**一个**「小助手」。
删掉组织页之后，界面上已经没有任何办法创建执行体，而派活仍然需要一个
（工具注册表和模型还从 employee 上取）——不建人的话，全新安装丢第一个目标
只会得到「没有可用的执行者」，产品在第一次使用时就死了。
刻意不是以前那个六人的演示公司。

**已做 B4-3（最后一步）**：

- `index.ts` 的建公司逻辑换成一个 `seedExecutor(db)`：调
  `ThreadRepository.createWorker()` 建默认执行体「小助手」（template `research`），
  幂等，已有 live worker 就返回第一个。`firstCompany` / `defaultExecutor` 退役。
- `org/`、`models/employeeModel.ts` 整个删除；`WorkService` 不再接收 `org`，
  能力清单读 `listAllWorkers()`，可派对象是"除自己以外的 live worker"。
- **V31 删 13 张表**：文档里那 12 张之外，还有 `department_job`——它是
  `repairJobCatalogue()` 动态建出来的关联表，删掉 `job` 之后会变成孤儿。
- 连带清掉残留的 `budget_reservation` / `budget` 操作（表在 V29 就没了）。

**剩下的建议顺序**（每一步都要能跑）：

1. ~~`workService` 的三处 `org` 调用~~ 部分完成（`01084f7`）：**模型**已挪到执行体上
   （`worker.model → employee.model → 公司默认`，建 worker 时钉住）。
   还剩两处：
   - **工具策略** → `worker.template`（需要先定"研究型/工程型/运维型各拿哪些工具"）
   - **`subordinatesOf`** → 见下面的发现
2. `comm` 的群聊路由改挂 `thread`
3. `budget` 两轴（thread / global），删部门轴
4. `seed/firstCompany` + `setup/companySetup` 退役
5. 删 `org/` + 12 张表

### 更正 + 处理：`decompose` 与汇报线（`1476a11`）

上一版这里写着「模型会反复尝试拆解、反复拿到拒绝，白烧 token」。**那是错的。**
registry 里有一行 `if (!slot.available || !slot.extension) return;` ——
工具在没人可派时根本不会装进去，模型看不见它。

真正留下的是 `subordinatesOf`：拆解能不能做，由**汇报线**决定。后果两个：
平级同事不能互相派活；一个人时永远拆不了。

v2 里没有经理，只有执行体，所以规则简化成一条：

```
公司里除了自己，还有没有人
```

- `decomposition.ts`：`subordinates` → `assignable`；错误码
  `DECOMPOSE_NOT_SUBORDINATE` → `DECOMPOSE_NOT_ASSIGNABLE`
- `workService.assignableTo(employeeId)`：拆解校验与工具可用性共用它
- 一个人时工具仍不装，但理由从含糊的 `no-subordinates` 改成 `sole-executor`，
  能力页说的是实话：「公司里只有你一个人」
- 补了 8 条用例（此前 `decomposition.ts` **没有任何测试**），
  覆盖深度 / 扇出 / 预算 / 派给自己 / 不存在的人 / 平级可派

**工作线内的并发仍然要小心**：同一 (thread, employee) 派两个子任务会共用同一个
worker，也就共用同一个 harness。真要并行，`ensureWorker` 得按
(thread, employee, **template**) 去重。这一步还没做。

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
