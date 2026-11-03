
# 概念词表：这个工作台里只有「你」和「它」

> 上游：`01-core.md` §10 删掉了组织和员工**体系**，`05-router-real.md` 让 Router 真的
> 成了会说话的那一方。这份记的是把**词**也删掉的那一刀（V32 / V33）。

### V32：任务记住你中途改的方向

`task.steering`（JSON `TaskSteering[]`）。`brief` 是派活时说的话，往里追加会污染原始
交代；所以单独一列，`produce` 每次尝试都重新从库里读任务，重试与返工自然继承。
配合 `HarnessBrain.interject`（`whenBusy: 'steer'`，pi 的 inbox）覆盖"正在跑"的那一刻。
细节见 `05-router-real.md` §6。

### V33：`memory` / `fact` / `owner_id` / `user`

| 之前 | 之后 | 为什么 |
|---|---|---|
| `employee_memory` | `memory` | 记忆属于"我"或某条工作线，不属于某个员工 |
| 作用域 `personal/org/department/project/thread` | `personal/thread` | 部门/项目两张表 V31 就删了，那些值永远写不进去 |
| `org_fact` | `fact` | 它一直是"这个工作台里都算数的事"，从没按组织切分过 |
| 作用域 `org` | `global` | 同上 |
| `worker.employee_id`、`consolidation_run.employee_id` | `owner_id` | 同上 |
| `acceptance.reviewer` 的 `manager/boss` | `system/user` | 三层验收还在，但第②层是系统闸门、第③层是**你** |
| `app_user.id = 'boss'` | `'user'` | 产品里只剩一个人；默认称呼 `老板` → `我` |

数据一起搬：旧库里的记忆、事实、验收记录一条不丢，只换称呼。`evidence` 里记的
`command: ["boss", …]` 也一起改。这一迁移在**真实旧库的副本**上验过
（`data/realUpgrade.test.ts`：行数不变、作用域收敛、没有 `employee_memory` 残留）。

### V34：资料字段也换了词

| 之前 | 之后 | 为什么 |
|---|---|---|
| `company.industry` | `company.domain` | 一个人哪来的"行业"；这个字段问的其实是「你在做什么」 |
| `CompanyProfile.industry` | `CompanyProfile.domain` | 同上（`DOMAINS` / `domainLabelKey` / `company.domain.*`） |
| `profile.vision`（`app_setting` 一行） | `profile.goal` | "愿景"是公司话术；它一直只是「一句话目标」 |

注意 `vision` 在模型目录里是**视觉能力**（`supportsVision`、`llmProviders`、`catalog`），
那是另一个意思——所以这两个字段是逐文件、逐符号改的，没有做全局替换。


### V35：`thread_key` 不再是"一个字符串"，而是身份 + 投递指纹

三个词在这条迁移里定下来，它们的区别值得记住：

| 词 | 是什么 | 不是什么 |
|---|---|---|
| **Thread（工作线）** | 具备连续 / 完整上下文的 request：一个 PR、一封邮件的往来、一个 IM 话题 | 不是"一个话题相关的若干件事"——那要靠猜 |
| **`thread_key`** | `<source>:<externalId>`，身份。一个身份同时只有一条活线 | 不是标题、不是正文摘要 |
| **`dedupe_key`** | 外部平台的投递 id（`github:<delivery>`、`feishu:<message_id>`） | 不是身份：同一个身份上有很多次投递 |

判据是一样的：**身份由外面那个东西决定，不由我们的措辞决定**。`PR #12` 与 `PR  #12`
要是算两条线，这种分裂永远不会有人发现；而 GitHub 重投同一份评论要是落成两条事件，
同一件事就会被两个 run 各干一半。

### 两个必须记住的坑

1. **历史迁移是只读的**。V1–V32 的 DDL、以及它们读的字面量（`profile.bossName`、
   `app_user.id = 'boss'`）一个字都不能改——改了会破坏已装库的升级路径。V33 是新的一步，
   它只改"现在"。
2. **`repairLegacyColumns` 会把历史上的 `ADD COLUMN` 重放一遍**，而它重放的条件是
   "这一列不存在"——改名正好制造了这个条件。所以 `companyDatabase.ts` 里有一张
   `RETIRED_COLUMNS`，否则 `worker.employee_id` 每次打开都会重新长出来。

### 词表（写新代码时照这个来）

| 不要说 | 说 |
|---|---|
| 公司 / 组织 / 部门 / 岗位 / 汇报线 | 工作台（`company` 表留着，指这台机器上的那份状态） |
| 老板 | 你（`USER_ID = 'user'`） |
| 员工 / 负责人 | 执行体（`worker`） |
| 行业 / 愿景 | 你在做什么（`domain`）/ 一句话目标（`goal`） |
| 公司事实 | 工作台的规矩（`fact`，`global` 作用域） |

`reply_to_boss` / `ask_boss` 一并改成 `reply_to_user` / `ask_user`——**工具名是模型
看得见的词**，它决定了 Router 怎么理解"对面是谁"。

## 死掉的表面一起删干净

词换完了，但"没有人再实现的东西"还在类型里躺着，读代码的人会以为它有用。这一轮
把它们删了（`ipc.ts` −130 行、`domain.ts` −15 行、两个组件 −564 行）：

| 删掉 | 为什么它已经死了 |
|---|---|
| `BudgetView` / `BudgetAlertView` / `PausedAssignmentView` / `BudgetOverview` | 预算中心的视图；`budget*` 三张表 V29 就删了 |
| `PayrollLine` / `PayrollOverview` | 薪酬视图，读的是同一批已经不存在的账本 |
| `CostCenterLine` / `CostCentersOverview` | 部门/项目成本中心——那两个轴已经没有表 |
| `BudgetAlert` / `BudgetAlertLevel` | 只被彼此引用 |
| `ChatSnapshot.departments` / `Conversation.departmentId` / `Department` | v1 的"部门群"；对话现在只有一条，对面是 Router |
| `ChatService.conversationInfo()` | 上一个字段的唯一读者 |
| `AppearanceSettings.tsx` / `ModelSettings.tsx` | 早被 `AppearancePage` / `LlmPage` 取代，没人 import |

`Budget` / `BudgetError` / `TaskError` 留着：`CreateTaskResult.error` 还在用它们报
"派不出去"。这类"错误形状"不该为了好看而删——它描述的是**拒绝**，不是某个已删功能。

## 调度的词：两层、两道门

这一轮的词不是改名字，是给**新配置项**起名字。它们会出现在设置页和提示词里，所以要
一次说清"哪一层花多少钱、哪一层有权力丢东西"。

| 说 | 指什么 | 花多少 |
|---|---|---|
| 程序层（`fastPath`） | 不看内容语义就能判的规则：回环、空正文、窗口内重复 | 零 token |
| 语义门（`semantic`） | 分类器回答"这值得占用上下文吗" | 一次调用，按批摊薄 |
| 主判 | Router 会话：开不开线、派给谁、怎么跟你说 | 可以配小模型，但不能不花 |

两条硬规矩（写在这里是因为它们比命名重要）：

- **只有主判能决定"做不做"**。前两层只决定"值不值得看"，把它们当中任何一层当成决策者，
  双层就塌成"便宜但不连续"的调度。
- **前两层失败一律放行**。它们的失败方向必须朝"多问一句"，否则省钱这件事会变成丢工作。

词表补两行：

| 不要说 | 说 |
|---|---|
| 过滤器 / 阈值（当主语用时） | 程序层 / 语义门 / 判噪阈值 |
| 忽略 / 丢弃（说噪声以外的事） | 拦下（程序层）/ 判成噪声（语义门） |


