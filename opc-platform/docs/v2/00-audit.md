# Stage 0 · 重构分类审计

> 基线：`ff2106b` · 主进程 35,925 行 · 渲染层 30,366 行 · shared 2,352 行 · 35 张表 / schema.ts 1,206 行
> 用途：这是 Stage 1 拆除的**唯一依据**。不在这张表里的东西不许动。

---

## 1. 判定口径

只有三档，按优先级从上到下判定：

| 判定 | 含义 | 测试问题 |
|---|---|---|
| **留** | 只依赖平台能力，与「公司/员工」隐喻无关 | 删掉它，是不是等于重写一个已经跑通的桌面应用？ |
| **改** | 概念仍然需要，但**主体**要从 `employee` 换成 `thread` / `worker` | 换个主语，这段逻辑还成立吗？ |
| **拆** | 只服务「模拟经营」，助手形态里没有对应功能 | 助手需要「面试」「职级」「同事关系」吗？ |

判定的是**概念在助手形态里还存不存在**，不是这行代码写得好不好。

---

## 2. 必须先接受的一个结论：`employee` 是中心外键

耦合热力（引用该标识符的文件数，已排除 `schema.ts` 自身）：

| 标识 | 文件数 | 性质 |
|---|---|---|
| `company` | 50 | 假象——多数是 `companyId` 当作用域参数，可机械替换 |
| `employee` | 49 | **真耦合——它是主语**。memory / budget / run / inbox / workspace 全挂在它下面 |
| `department` | 33 | 组织 |
| `position` | 15 | 组织 |
| `assignment` | 11 | 组织 × 预算 |
| `job` | 11 | 招聘 |
| `interview` | 6 | 招聘 |
| `relationship` | 5 | 模拟 |
| `evaluation` | 5 | 薪酬 |
| `employment_event` | 4 | 组织 |
| `agent_candidate` | 3 | 招聘 |
| `employee_package` | 2 | 招聘 |

**结论：`employee` 不能"藏"，只能换。** 而且换法不是重命名，是**降级**：

> 从「持久主体」（有身份、有职级、有汇报线、有自己的节奏、有不可读的私人记忆）
> 降为「一次性执行体」（模板 + 技能标签 + 当前 thread + 额度）。

这条不变，重构就是白做。

---

## 3. 主进程逐目录（35,925 行）

| 目录 | 行数 | 判定 | 去向 |
|---|---|---|---|
| `work/` | 6,430 | **改** | 劈成两半：验收流水线（`acceptanceTemplate` / `durableWorkRunner` / `workTaskDefinition` / `exec` / `brain` / `harnessBrain`）**留**；`decomposeTool` + `workService` 里的组织部分重写 |
| `models/` | 4,426 | **留** | 模型目录 / 鉴权 / 图像 / 语音 / 决策分类器 |
| `data/` | 4,411 | **改** | `schema.ts` 重写（35 → ~24 张，见 §5），repo 跟改 |
| `org/` | 3,459 | **拆** | 组织架构 + 项目组，助手形态无对应物。`projectService` 的「项目组」被 `thread` 取代 |
| `comm/` | 1,809 | **改** | 三条原则保留（对话共享 / 唤醒决策 / 三层防护），主体换 `thread` |
| `extensions/` | 1,507 | **留** | pi 扩展宿主 |
| `network/` | 1,452 | **留** | 代理 / 客户端 |
| `cache/` | 1,418 | **留** | |
| `ipc/` | 1,269 | **改** | 通道表随领域对象重写 |
| `runtime/` | 1,224 | **留** | Node / Python 探测 |
| `skills/` | 903 | **留** | |
| `ocr/` | 822 | **留** | |
| `memory/` | 792 | **改** | 六层 → 三层（全局偏好 / 每 thread / 跨 thread 知识） |
| `market/` | 789 | **拆** | 招聘市场 + 面试 + 人才包 |
| `chat/` | 786 | **改** | 会话从挂 `employee` 改为挂 `thread` |
| `sandbox/` | 514 | **留** | |
| `company/` | 303 | **改** | 引用了 `evaluation` / `employment_event`，瘦身成 `workspace` 单例 |
| `setup/` | 293 | **改** | 公司配置向导 → 极简初始化 |
| `seed/` | 212 | **改** | `firstCompany` 是"造 20 个员工" → "造 1 个 Router + 3 个 worker 模板" |
| `diagnostics/` | 206 | **留** | |
| `smoke/` | 40 | **留** | |

**小计：留 12,266 行 · 改 ≈ 18,000 行 · 拆 4,248 行**

---

## 4. 渲染层逐目录（30,366 行）

| 目录 | 行数 | 判定 | 去向 |
|---|---|---|---|
| `features/settings/` | 8,964 | **留** | 计费 / 模型 / 运行时 / OCR 全与隐喻无关 |
| `pages/org/` | 4,485 | **拆** | `OrgPage` 3,024 + `JobTemplates` 753 + `HireWizard` 565 + `PersonaEditor` 143 |
| `features/onboarding/` | 2,491 | **改** | 5 步 → 3 步（选模型 / 起个名字 / 完） |
| `pages/projects/` | 1,768 | **改** | → `thread` 视图 |
| `pages/issues/` | 1,440 | **改** ⭐ | 已经是「全公司工作项台账，高亮需要老板的那条」——**它离注意力队列只差一个排序键**，这张页面是资产不是负担 |
| `pages/capabilities/` | 1,180 | **留** | Skills / MCP / Tools |
| `features/chat/` | 905 | **改** | |
| `pages/market/` | 717 | **拆** | |
| `features/employee-stack/` | 708 | **拆** | `ToolPolicyEditor` 可并入 worker 设置后再删 |
| `pages/budget/` | 599 | **改** | 双轴 → `thread` + 全局 |
| `features/models/` | 542 | **留** | |
| `pages/notifications/` | 379 | **改** | → 注意力队列（decide / notify / silent） |
| `features/task/` | 297 | **改** | |
| `features/appearance/` | 235 | **留** | |
| `features/agent-dossier/` | 189 | **改** | 员工档案 → worker 卡 |
| `features/diagnostics/` | 110 | **留** | |
| `pages/chat/` | 101 | **改** | |

**小计：留 10,921 行 · 改 ≈ 7,100 行 · 拆 5,910 行**

---

## 5. 数据表逐表（35 → 目标 ~24）

> 更正：上一轮我说过「34 → 约 13」。那个数字太乐观了——保留了 `conversation` / `message` /
> 验收三件套 / 预算三件套之后到不了 13。真实目标是 **~24**。
> 但真正的收益不是表数量，是**12 张组织/招聘表归零**，且中心实体从 `employee` 换成 `thread`。

### 5.1 保留原样（11 张）

`task`(38) `task_step`(7) `task_link`(8) `artifact`(9) `acceptance`(11)
`message`(7) `conversation`(9) `model_provider`(13) `guard_event`(9) `app_setting`(5) `app_user`(7)

> 验收三件套 + 对话二件套是这个项目**已经做对的部分**，一行不改。

### 5.2 保留但换轴（4 张）

| 表 | 行数 | 换法 |
|---|---|---|
| `budget` | 14 | 维度从 `(company / department / employee / project)` 四轴 → `(thread / global)` 两轴 |
| `budget_ledger` | 12 | 记账主体从 `assignment` 改为 `thread` |
| `budget_reservation` | 10 | 同上 |
| `inbox_item` | 16 | ⭐ 语义翻转：从「发给某员工的信」→ `event`（待处理的 Trigger） |

### 5.3 改造（8 张）

| 旧 | 行数 | 新 | 改法 |
|---|---|---|---|
| `employee` | 23 | **`worker`** | 去掉 `position` / 汇报线 / `status` / 组织字段；保留 template + skills + 额度 |
| `employee_memory` | 23 | **`thread_memory`** | 记忆归属从「人」改为「工作线」 |
| `org_fact` | 18 | **`knowledge`** | 去掉 `department` 作用域，改为跨 thread 事实 |
| `wake_quota` | 10 | **`attention_quota`** | ⭐ 最关键的一次轴翻转：从「限制打扰员工」→「限制打扰老板」 |
| `budget_alert` | 12 | **`report`** | 并入汇报（decide / notify / silent 三级） |
| `consolidation_run` | 14 | — | 并入记忆巩固，不单独立表 |
| `company` | 9 | `workspace` | 单例，去掉组织含义 |
| `assignment` | 12 | — | 由 `task.assignee` + `worker.thread_id` 取代 |

### 5.4 拆除（12 张，共 208 行 DDL）

`department`(19) `position`(16) `assignment`(12→5.3) `relationship`(16) `evaluation`(19)
`interview`(20) `employee_package`(15) `job`(13) `employment_event`(20)
`agent_candidate`(11) `project_group`(13) `company`(9→5.3)

### 5.5 新增（4 张）

**`thread`** ⭐ 工作线。老板视角的唯一对象：目标 / 状态 / 注意力级别 / 额度 / 最后活动时间
**`event`** Trigger。source / payload / triage_state / thread_id
**`report`** 汇报。level ∈ {decide, notify, silent}
**`memory_profile`** 全局偏好（你的口味、约定、禁忌）——一份，不是每人一份

---

## 6. Stage 1 拆除顺序（依赖已排好，不能调换）

关键约束：`interview` / `evaluation` / `employment_event` 的**使用者是 `orgService`**，
所以表必须等 `org/` 拆完才能删。顺序错了会先把组织层断掉。

| Batch | 删什么 | 预计净删 | 出口验证 |
|---|---|---|---|
| **B1** | `main/market/` + `pages/market/`（**表先留**） | ~1,500 | 应用能起，侧栏无市场入口 |
| **B2** | `pages/org/` + `features/employee-stack/` + `main/org/` | ~8,600 | 应用能起，无组织页；`pnpm test` 里 org 用例全部消失 |
| **B3** | `work/payroll*` + 组织相关预算轴 | ~700 | 预算页只剩 thread/全局两轴 |
| **B4** | 12 张表 + `schema.ts` 重建 + `employee`→`worker` | ~1,200 DDL | 开发库重建，`--self-test` 通过 |
| **B5** | `ipc/` + `preload` + `shared/domain` 类型收敛 | ~600 | `pnpm typecheck` 三包全绿 |

**合计预计净删 ≈ 12,600 行**（业务层约 1/3）。保留 12,266 行平台资产不动。

每个 batch 一个 commit，打 tag `v2-before-bN`。

---

## 7. 不许碰的清单（重构边界）

```
models/  network/  cache/  extensions/  runtime/  skills/  ocr/  sandbox/  diagnostics/
features/settings/  pages/capabilities/  features/appearance/
```

理由只有一个：**它们和产品形态无关**。动它们不是重构，是重写一个已经跑通的桌面应用。

---

## 8. 风险与回滚

| 风险 | 处置 |
|---|---|
| 删错 | 每 batch 前 `git tag v2-before-bN`；回滚 `git reset --hard v2-before-bN` |
| B2 之后的真空期（有应用、没有组织页、没有市场页） | 预期行为。B2 出口只要求"能起 + 测试全绿"，不要求功能完整 |
| 计费（`billing`）刚落地，改 `budget` 轴会牵连 | B5 之前不动 billing；B3 只在 `budgetAxes` 边界内改 |
| `dataLayer.test.ts` 428 行断言了旧 schema | B4 里随 schema 一起重写，不试图保住 |
| 主进程单线程 + 长任务阻塞 | 与本次重构正交，但 B5 后必须把 `scheduler.tick` 的串行 `await` 去掉 |

---

## 9. 待拍板（不阻塞 B1–B3）

1. **事件源**（Stage 4 才用，但影响 B4 的 `event` 表字段宽度）：建议 **本地文件夹 + `.ics` 日历**，零鉴权、离线可用。
2. **worker 要不要名字和人格**：建议**要**。成本极低（一个模板字段），但它是产品手感的来源，也是不用重建组织架构就能保留的"有人味"。
3. **onboarding 三步的具体内容**：建议 选模型 → 起名 → 丢第一个目标。
