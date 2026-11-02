# v2 残留清单

> 上游：`00-audit.md` / `01-core.md`。本文只做一件事：把「产品形态已经变了、代码还没跟上」
> 的地方列全，并按「值不值得现在清」排序。
>
> 已清（`fa5431e`）：3 块占位页（频道 / 交付物 / 设备）、`org` + `market` 两块 i18n
> （18.9 KB）、5 个已删导航项、7 个零引用类型（招聘市场遗留）。

---

## A. 界面层的组织残留

| 位置 | 残留内容 | 现在的表现 | 建议 |
|---|---|---|---|
| ~~`widgets/title-bar/StartMenu.tsx`~~ ✅ `385e39a` | 「按部门建群」已**删掉**（不留替代入口） | 现在只剩「和某个人开对话」；`chat:ensureDepartmentGroup` 通道一并删除 | 剩 7 处 department，只用于从 `org.list()` 摊平成员列表——那是「执行体从哪来」的问题 |
| ~~`features/chat/ui/ChatPanel.tsx` / `ChatHeader.tsx`~~ ✅ | 会话头部门色块 | **已删**；`departments` 这条 prop 链（ChatPage → ChatPanel → ChatHeader）整条消失 | — |
| `pages/projects/ProjectsPage.tsx`（32 处） | 项目按部门、成员按部门筛 | 一个部门时能用，多个时是错觉 | 项目成员改成「参与的工作线」；优先级低 |
| ~~`features/agent-dossier/ui/AgentDossierDrawer.tsx`~~ ✅ | 部门卡片 + 职级徽章 | **已删**。抽屉现在只剩：这次对话里有谁、用什么模型花多少钱、各自的工作说明 | 想再加「跑过哪些工作线」需要 thread ↔ conversation 的查询，另行安排 |
| `features/onboarding/ui/StepCompany.tsx` | 公司名 + 预算 + 部门数 | 显示「1 个部门 · 1 个人」 | 可以先去，onboarding 目标本来就是 3 步 |

---

## B. 主进程的组织残留

| 位置 | 规模 | 说明 |
|---|---|---|
| `org/orgService.ts` + `projectService.ts` | 3,459 行 | 中心实体还是 employee；12 张表挂在它身上 |
| `work/payroll.ts` + `budgetCenter.ts` | 约 370 行 | 薪酬视图按 employee 轴；`budget` 页和 `BillingPage` 都在读 |
| `company/companyService.ts` | 303 行 | 引用 `evaluation` / `employment_event`，这两个表是考核与在职变动 |
| `work/workService.ts` | 剩 21 处 org | 工具策略（`toolPolicyOf`）、记忆分区（`everyone()`）、能力页 |

**顺序建议**：`workService` 的工具策略 → `companyService` 的考核 →
`payroll` 的轴 → `comm` 的部门群 → 最后删 `org/` 与 12 张表。

---

## C. 已经"无害但难看"的

- `comm` 仍会创建部门群（`chat.ensureDepartmentGroup`），只是现在只有一个部门。
- `budget` 的四条轴（company / department / employee / project）里，department 与
  employee 两条在 v2 里没有对应的东西了，但还在记账。
- `skill` / `capabilities` 页仍然按「员工」列工具，列出来的其实是执行体。

---

## D. 判断口径

不要为了"看起来干净"去删还在工作的东西。判据只有一条：

> **删掉之后，用户能做的动作变少了吗？**

- 变少了 → 这是能力，不是残留，留到有替代品再说
- 没变少 → 这是残留，删

按这条：`StartMenu` 的建群动作还在用（只是按部门分），所以**改**不是**删**；
`/channels` 打开是"敬请期待"，删掉之后用户能做的事一件没少，所以删对了。
