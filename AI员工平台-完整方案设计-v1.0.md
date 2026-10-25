# AI 员工平台 · 完整方案设计 v1.0

> **形态**：跨平台桌面应用（本地优先），后续支持移动端远程控制桌面端
> **技术底座**：`@earendil-works/pi`（`pi-durable` + `pi-agent-core` + `pi-ai`）
> **存储**：全 SQLite（业务库 + 每员工一个运行时库）
> **禁止**：Web 版、云端托管版（本版不做，但架构预留迁移空间）

---

## 目录

1. 设计目标与边界
2. 总体架构
3. 领域模型划分
4. 数据模型（完整 DDL）
5. 核心业务流程
6. 记忆系统设计
7. 通信系统设计
8. 预算系统设计
9. 任务与验收设计
10. 运行时设计
11. 前端设计
12. 安全与数据保护
13. 移动端预留设计
14. 非功能需求与容量估算
15. 分阶段交付计划
16. 风险与未决问题

---

## 1. 设计目标与边界

### 1.1 要解决的问题

做一个**公司模拟器**：用户是老板，Agent 是员工。员工有身份、记忆、岗位、汇报线，能在部门与项目组里协作，能互相私聊，能被派活并向上升报。

### 1.2 核心设计原则（六条）

| # | 原则 | 含义 |
|---|---|---|
| **P1** | **对话是共享的，记忆是个人的** | `message` 表是通信的唯一真相；`pi-durable` 是员工私有推理；不允许用一方替代另一方 |
| **P2** | **业务状态 ≠ 运行时状态** | 组织/预算/消息/任务归 `company.db`；对话轨迹/任务检查点归 `agents/*.sqlite`。两者只用 ID 关联，不交叉写入 |
| **P3** | **一个员工 = 一个持久运行时** | 每员工独立 SQLite、独立身份文档、独立记忆分区 |
| **P4** | **消息 ≠ 任务** | `@` 只产生 Message；只有显式"派活"产生 Task。这是成本与责任的边界 |
| **P5** | **员工有自己的节奏** | 不是随叫随到。心跳周期 + inbox 批量处理 + 主动唤醒配额 |
| **P6** | **失败要显式** | 未知 ID 报错、不静默兜底；预算耗尽就硬停；验收不通过就返工，不自动"通过" |

### 1.3 明确不做（v1.0）

- ❌ Web 版 / 云端托管
- ❌ 移动端 App（只预留接口）
- ❌ 语音 / 视频生成
- ❌ 多租户（一个 App 实例 = 一个公司；多公司留到 v2）
- ❌ 实时协同编辑
- ❌ 第三方 IM 接入（Slack / 飞书）

### 1.4 验收标准（什么叫"做成了"）

**Phase 0 的验收标准，只有一条**：

> **老板派一个活 → 员工干完 → 系统能自动判定"真的干完了" → 老板看到交付物并认可。**

这条过不去，后面所有功能都是空中楼阁。

---

## 2. 总体架构

### 2.1 进程模型（Electron）

```
┌────────────────────────────────────────────────────────────────┐
│  Electron Main Process（Node.js · 单线程 JS）                   │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  应用服务层 (packages/app)                                │  │
│  │  OrgService · MarketService · CommService · WorkService   │  │
│  │  BudgetService · MemoryService · RuntimeService           │  │
│  └──────────────────────────────────────────────────────────┘  │
│                          │                                     │
│  ┌───────────────┬───────┴────────┬────────────────────────┐  │
│  │ 领域层         │  数据层         │  运行时池              │  │
│  │ (packages/    │ (packages/db)  │ (packages/runtime)    │  │
│  │  domain)      │  Drizzle +     │  AgentPool            │  │
│  │  纯 TS 无依赖  │  better-sqlite3│  └ Harness×N          │  │
│  └───────────────┴────────────────┴────────────────────────┘  │
│                          │                                     │
│  ┌───────────────────────┴──────────────────────────────────┐  │
│  │  存储                                                     │  │
│  │  company.db (SQLite+WAL+sqlite-vec)                       │  │
│  │  agents/<employeeId>.sqlite  × N                          │  │
│  │  artifacts/ · archive/                                    │  │
│  └──────────────────────────────────────────────────────────┘  │
│                          │                                     │
│  ┌───────────────────────┴──────────────────────────────────┐  │
│  │  IPC Server（ipcMain，类型化通道）                        │  │
│  └──────────────────────────────────────────────────────────┘  │
└──────────────────────────┬─────────────────────────────────────┘
                           │ contextBridge (preload)
┌──────────────────────────┴─────────────────────────────────────┐
│  Renderer Process（React 19 · 纯 UI，无业务逻辑）               │
│  招聘市场 · IM · 组织架构 · 预算 · 任务 · 员工档案              │
└────────────────────────────────────────────────────────────────┘

                     ┌──── 预留（v1.1）────┐
                     │ Local API Server    │
                     │ HTTP + WS on :7321  │
                     └──────────┬──────────┘
                                ↓ LAN
                          ┌──────────┐
                          │ 移动端    │
                          └──────────┘
```

### 2.2 关键约束：Main Process 不能依赖 Electron API

**除了 `ipcMain` 的注册代码，`packages/*` 里不允许 `import { app } from 'electron'`。**

原因：将来要把 Main Process 抽出来变成独立 daemon（给移动端用、给多窗口用、给无头模式用）时，`packages/*` 可以零改动搬走。

```typescript
// ❌ 禁止在 packages/ 里
import { app } from 'electron'
const dbPath = path.join(app.getPath('userData'), 'company.db')

// ✅ 正确：路径由 main 注入
export function createDatabase(dbPath: string) { /* ... */ }
```

### 2.3 包结构

```
aicompany/
├── apps/
│   ├── main/                  # Electron 主进程
│   │   ├── src/index.ts       # 应用启动、窗口、菜单
│   │   ├── src/ipc/           # IPC 处理器（薄，只做转发）
│   │   └── src/bootstrap/     # 装配：打开库、启动运行时池
│   └── renderer/              # React UI
│       ├── src/pages/
│       ├── src/components/
│       └── src/stores/
├── packages/
│   ├── shared/                # 类型、常量、错误码、Zod schema（无依赖）
│   ├── domain/                # 领域模型 + 业务规则（纯 TS，无 IO）
│   ├── db/                    # Drizzle schema + Repository 实现
│   ├── runtime/               # AgentRuntime 接口 + PiDurable 实现
│   ├── memory/                # MemoryStore 接口 + SQLite 实现
│   └── app/                   # 应用服务（编排以上四层）
├── electron-builder.yml
└── package.json
```

**依赖方向（单向，不可逆）：**

```
shared ← domain ← db ← app ← main
                    ↑
              runtime, memory
```

`domain` 不 import `db`；`db` 不 import `app`。

### 2.4 启动顺序

```
1. 解析数据目录（main，用 app.getPath('userData')）
2. 打开 company.db（迁移 → 建索引 → 加载 sqlite-vec 扩展）
3. 启动 AgentPool：
   a. 扫描 employees 表（status='active'）
   b. 每员工打开 agents/<id>.sqlite，创建 Harness
   c. 恢复未完成的任务（pi-durable resume）
4. 启动调度器（心跳定时器）
5. 注册 IPC
6. 创建窗口
7. 首次运行 → 走引导流程（招聘市场）
```

**关键**：第 3c 步是"崩溃恢复"的落点。App 被强杀后重开，员工会接着干没干完的活。

---

## 3. 领域模型划分

### 3.1 六个限界上下文

```
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│  ① 组织 Org     │  │  ② 招聘 Market  │  │  ③ 通信 Comm    │
│                 │  │                 │  │                 │
│  Company        │  │  TalentListing  │  │  Conversation   │
│  Department     │  │  Evaluation     │  │  Message        │
│  ProjectGroup   │  │  Interview      │  │  InboxItem      │
│  Employee       │  │  EmployeePackage│  │  WakeQuota      │
│  Position       │  │                 │  │                 │
│  Assignment     │  │                 │  │                 │
│  Relationship   │  │                 │  │                 │
└────────┬────────┘  └────────┬────────┘  └────────┬────────┘
         │                    │                    │
         └────────────────────┼────────────────────┘
                              │
┌─────────────────┐  ┌────────┴────────┐  ┌─────────────────┐
│  ④ 任务 Work    │  │  ⑤ 预算 Budget │  │  ⑥ 记忆 Memory  │
│                 │  │                 │  │                 │
│  Task           │  │  Budget         │  │  EmployeeMemory │
│  Artifact       │  │  LedgerEntry    │  │  OrgFact        │
│  Acceptance     │  │  Reservation    │  │  Relationship   │
│  Review         │  │  BudgetAlert    │  │  Consolidation  │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

### 3.2 上下文之间的依赖

```
Market ──(雇佣)──→ Org
Org    ──(派活)──→ Work
Work   ──(消耗)──→ Budget
Comm   ──(派生)──→ Work       （对话里可以派活）
Comm   ──(沉淀)──→ Memory
Work   ──(沉淀)──→ Memory
Org    ──(可见性)─→ Memory
Budget ──(硬停)──→ Org        （暂停 Assignment）
```

**没有双向依赖。** 所有跨上下文交互通过应用服务层编排，不在领域对象里互相调用。

---

## 4. 数据模型（完整 DDL）

### 4.0 全局约定

| 项 | 约定 | 理由 |
|---|---|---|
| **主键** | `TEXT`，UUIDv7（时间有序） | 可按创建时间排序，无需额外索引 |
| **时间** | `INTEGER`，Unix 毫秒 | SQLite 原生友好，时区无歧义 |
| **枚举** | `TEXT` + `CHECK` 约束 | 不用 lookup 表，简单直观 |
| **JSON** | `TEXT` + 应用层 Zod 校验 | SQLite `json1` 可查询，但校验放应用层 |
| **布尔** | `INTEGER` 0/1 | SQLite 无原生 bool |
| **向量** | `BLOB`（float32） | 由 `sqlite-vec` 管理 |
| **删除** | **软删除**（`deleted_at`） | 审计和恢复需要 |
| **外键** | 开启 `PRAGMA foreign_keys=ON` | |

### 4.1 数据库初始化

```sql
-- ═══ PRAGMA（每次连接都要设置）═══
PRAGMA journal_mode = WAL;          -- 并发读，单写
PRAGMA synchronous = NORMAL;        -- WAL 下足够安全
PRAGMA foreign_keys = ON;           -- 强制外键
PRAGMA busy_timeout = 5000;         -- 5s 重试
PRAGMA cache_size = -64000;         -- 64MB 页缓存
PRAGMA temp_store = MEMORY;

-- ═══ 扩展 ═══
-- 启动时用 sqlite-vec 的 loadExtension 加载
```

### 4.2 系统域

```sql
-- ── 公司（v1.0 只有一行）─────────────────────────────
CREATE TABLE company (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  industry        TEXT,                       -- 模板来源标识
  logo_path       TEXT,
  -- 全局默认策略（JSON）
  settings        TEXT NOT NULL DEFAULT '{}',
  -- settings 结构：
  -- {
  --   "heartbeatMinutes": 15,
  --   "defaultDailyWakeQuota": 5,
  --   "maxConversationTurns": 10,
  --   "maxTaskDepth": 3,
  --   "maxTaskFanout": 5,
  --   "maxActiveTasksPerEmployee": 3,
  --   "archiveAfterHours": 24
  -- }
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- ── 审计日志（所有变更都记）──────────────────────────
CREATE TABLE activity_log (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL,
  ts              INTEGER NOT NULL,
  -- 谁
  actor_kind      TEXT NOT NULL CHECK (actor_kind IN ('boss','employee','system')),
  actor_id        TEXT NOT NULL,
  -- 做了什么
  action          TEXT NOT NULL,     -- 'employee.hired' / 'budget.exceeded' / ...
  entity_type     TEXT NOT NULL,     -- 'employee' / 'task' / 'budget'
  entity_id       TEXT NOT NULL,
  -- 变更内容（脱敏后的 diff）
  payload         TEXT,
  -- 关联
  task_id         TEXT,
  conversation_id TEXT,
  FOREIGN KEY (company_id) REFERENCES company(id)
);
CREATE INDEX idx_activity_ts ON activity_log(company_id, ts DESC);
CREATE INDEX idx_activity_entity ON activity_log(entity_type, entity_id, ts DESC);
```

### 4.3 组织域

```sql
-- ── 部门（稳定的组织结构）────────────────────────────
CREATE TABLE department (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL,
  name              TEXT NOT NULL,
  parent_id         TEXT,                       -- 支持多级
  head_employee_id  TEXT,                       -- 负责人
  description       TEXT,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  deleted_at        INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  FOREIGN KEY (company_id) REFERENCES company(id),
  FOREIGN KEY (parent_id) REFERENCES department(id),
  FOREIGN KEY (head_employee_id) REFERENCES employee(id)
);
CREATE INDEX idx_dept_company ON department(company_id, deleted_at);

-- ── 项目组（临时的执行单元，预算在这里）──────────────
CREATE TABLE project_group (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL,
  department_id     TEXT NOT NULL,              -- 挂在哪个部门下
  name              TEXT NOT NULL,
  goal              TEXT NOT NULL,              -- 这个项目要达成什么
  status            TEXT NOT NULL DEFAULT 'planning'
                    CHECK (status IN ('planning','active','paused','done','archived')),
  owner_employee_id TEXT,                       -- 项目负责人
  started_at        INTEGER,
  due_at            INTEGER,
  done_at           INTEGER,
  deleted_at        INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  FOREIGN KEY (company_id) REFERENCES company(id),
  FOREIGN KEY (department_id) REFERENCES department(id),
  FOREIGN KEY (owner_employee_id) REFERENCES employee(id)
);
CREATE INDEX idx_proj_company_status ON project_group(company_id, status, deleted_at);

-- ── 员工（全局身份，跨部门跨项目）────────────────────
CREATE TABLE employee (
  id                TEXT PRIMARY KEY,
  company_id        TEXT,                       -- NULL = 还在市场里
  -- 身份
  name              TEXT NOT NULL,
  avatar_path       TEXT,
  title             TEXT NOT NULL,              -- "高级前端工程师"
  bio               TEXT,                       -- 一句话人设
  persona_prompt    TEXT NOT NULL,              -- ⭐ 人格 prompt（≤300 token）
  skills            TEXT NOT NULL DEFAULT '[]', -- JSON array
  -- 模型配置（"薪酬分级"）
  model_provider    TEXT NOT NULL,
  model_id          TEXT NOT NULL,
  temperature       REAL NOT NULL DEFAULT 0.7,
  thinking_level    TEXT,
  -- 状态
  status            TEXT NOT NULL DEFAULT 'market'
                    CHECK (status IN ('market','active','paused','terminated')),
  hired_at          INTEGER,
  terminated_at     INTEGER,
  -- 记忆分区
  memory_partition  TEXT NOT NULL,              -- 'emp:<employeeId>'
  -- 统计（物化计数，避免频繁聚合）
  total_tokens_used INTEGER NOT NULL DEFAULT 0,
  total_tasks_done  INTEGER NOT NULL DEFAULT 0,
  total_tasks_failed INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  FOREIGN KEY (company_id) REFERENCES company(id)
);
CREATE INDEX idx_emp_company_status ON employee(company_id, status);
CREATE UNIQUE INDEX idx_emp_partition ON employee(memory_partition);

-- ── 岗位（员工 × 部门）—— 回答"你归谁管" ─────────────
CREATE TABLE position (
  id                    TEXT PRIMARY KEY,
  employee_id           TEXT NOT NULL,
  department_id         TEXT NOT NULL,
  title                 TEXT NOT NULL,          -- 这个部门里的职级
  reports_to_employee_id TEXT,                  -- ⭐ 部门汇报线
  is_head               INTEGER NOT NULL DEFAULT 0,
  deleted_at            INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  FOREIGN KEY (employee_id) REFERENCES employee(id),
  FOREIGN KEY (department_id) REFERENCES department(id),
  FOREIGN KEY (reports_to_employee_id) REFERENCES employee(id)
);
-- 一个员工在一个部门只能有一个岗位
CREATE UNIQUE INDEX idx_pos_emp_dept ON position(employee_id, department_id)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_pos_dept ON position(department_id, deleted_at);

-- ── 项目任职（员工 × 项目组）⭐ 矩阵组织的关键 ────────
CREATE TABLE assignment (
  id                    TEXT PRIMARY KEY,
  employee_id           TEXT NOT NULL,
  project_group_id      TEXT NOT NULL,
  role                  TEXT NOT NULL,          -- "这个项目里我是后端"
  reports_to_employee_id TEXT,                  -- ⭐ 项目内汇报（可不同于部门）
  status                TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','paused','removed')),
  -- 暂停原因（预算/手动/其他）
  pause_reason          TEXT,
  paused_at             INTEGER,
  joined_at             INTEGER NOT NULL,
  removed_at            INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  FOREIGN KEY (employee_id) REFERENCES employee(id),
  FOREIGN KEY (project_group_id) REFERENCES project_group(id),
  FOREIGN KEY (reports_to_employee_id) REFERENCES employee(id)
);
-- 一个员工在一个项目组只能有一条任职
CREATE UNIQUE INDEX idx_assign_emp_proj ON assignment(employee_id, project_group_id)
  WHERE status != 'removed';
CREATE INDEX idx_assign_proj_status ON assignment(project_group_id, status);
CREATE INDEX idx_assign_emp_status ON assignment(employee_id, status);

-- ── 关系图谱 ⭐ 差异化功能 ────────────────────────────
CREATE TABLE relationship (
  id                    TEXT PRIMARY KEY,
  company_id            TEXT NOT NULL,
  from_employee_id      TEXT NOT NULL,
  to_employee_id        TEXT NOT NULL,
  kind                  TEXT NOT NULL
                        CHECK (kind IN ('colleague','manager','report','collaborator')),
  -- 强度 0..1，随互动增强、随时间衰减
  strength              REAL NOT NULL DEFAULT 0.5,
  interaction_count     INTEGER NOT NULL DEFAULT 0,
  last_interaction_at   INTEGER,
  -- 在哪些项目里共事过
  project_group_ids     TEXT NOT NULL DEFAULT '[]',  -- JSON array
  -- 员工自己写的关系备注
  note                  TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  FOREIGN KEY (company_id) REFERENCES company(id),
  FOREIGN KEY (from_employee_id) REFERENCES employee(id),
  FOREIGN KEY (to_employee_id) REFERENCES employee(id)
);
CREATE UNIQUE INDEX idx_rel_pair ON relationship(from_employee_id, to_employee_id, kind);
CREATE INDEX idx_rel_from ON relationship(from_employee_id, strength DESC);
CREATE INDEX idx_rel_to ON relationship(to_employee_id, strength DESC);
```

### 4.4 招聘域

```sql
-- ── 市场挂牌（招聘市场里的员工）──────────────────────
CREATE TABLE talent_listing (
  id                TEXT PRIMARY KEY,
  -- 内容
  name              TEXT NOT NULL,
  avatar_path       TEXT,
  title             TEXT NOT NULL,
  bio               TEXT,
  persona_prompt    TEXT NOT NULL,
  skills            TEXT NOT NULL DEFAULT '[]',
  model_provider    TEXT NOT NULL,
  model_id          TEXT NOT NULL,
  -- ⭐ 诚实展示成本
  est_tokens_min    INTEGER NOT NULL,           -- 每任务预估下限
  est_tokens_max    INTEGER NOT NULL,           -- 每任务预估上限
  -- 样例产出（3-5 个 artifact 引用）
  sample_artifacts  TEXT NOT NULL DEFAULT '[]',
  -- 人格预览（3 段真实对话样例）
  persona_samples   TEXT NOT NULL DEFAULT '[]',
  -- 来源
  source            TEXT NOT NULL
                    CHECK (source IN ('official','community','self','exported')),
  -- 口碑
  rating_avg        REAL,
  rating_count      INTEGER NOT NULL DEFAULT 0,
  hire_count        INTEGER NOT NULL DEFAULT 0,
  -- 版本
  version           TEXT NOT NULL DEFAULT '1.0.0',
  published_at      INTEGER NOT NULL,
  deleted_at        INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX idx_listing_source ON talent_listing(source, deleted_at);
CREATE INDEX idx_listing_rating ON talent_listing(rating_avg DESC);

-- ── 评价（老板给员工打分）───────────────────────────
CREATE TABLE evaluation (
  id                TEXT PRIMARY KEY,
  employee_id       TEXT NOT NULL,
  listing_id        TEXT,                       -- 如果来自市场挂牌
  -- 评分维度
  score_overall     REAL NOT NULL CHECK (score_overall BETWEEN 1 AND 5),
  score_quality     REAL,
  score_speed       REAL,
  score_cost        REAL,
  comment           TEXT,
  -- 评价者（v1.0 只有老板）
  author_kind       TEXT NOT NULL DEFAULT 'boss',
  created_at        INTEGER NOT NULL,
  FOREIGN KEY (employee_id) REFERENCES employee(id),
  FOREIGN KEY (listing_id) REFERENCES talent_listing(id)
);
CREATE INDEX idx_eval_emp ON evaluation(employee_id, created_at DESC);

-- ── 面试（试跑）─────────────────────────────────────
CREATE TABLE interview (
  id                TEXT PRIMARY KEY,
  listing_id        TEXT NOT NULL,
  -- 试跑任务
  task_prompt       TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','done','failed','cancelled')),
  -- 产出
  result_artifact   TEXT,
  tokens_used       INTEGER NOT NULL DEFAULT 0,
  duration_ms       INTEGER,
  -- 老板的决定
  decision          TEXT CHECK (decision IN ('hire','reject',NULL)),
  created_at        INTEGER NOT NULL,
  finished_at       INTEGER,
  FOREIGN KEY (listing_id) REFERENCES talent_listing(id)
);

-- ── 员工包（可导出/分享，参照 vvv 的 .vvv 格式）──────
CREATE TABLE employee_package (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind IN ('employee','team','company')),
  name              TEXT NOT NULL,
  version           TEXT NOT NULL,
  description       TEXT,
  -- 包内容
  file_path         TEXT NOT NULL,              -- .aivp 文件路径
  file_hash         TEXT NOT NULL,              -- SHA-256
  file_size         INTEGER NOT NULL,
  -- 清单
  manifest          TEXT NOT NULL,              -- JSON
  -- 使用条款
  license           TEXT,
  created_at        INTEGER NOT NULL
);
```

### 4.5 通信域

```sql
-- ── 会话（共享 · 唯一真相）⭐ ────────────────────────
CREATE TABLE conversation (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL,
  kind              TEXT NOT NULL
                    CHECK (kind IN ('dm','channel','task_thread')),
  -- 参与者（JSON 数组：员工 id 或 'boss'）
  participants      TEXT NOT NULL,
  -- ⭐ 作用域：决定这条对话的记忆写进哪个分区
  scope_type        TEXT CHECK (scope_type IN ('project','department',NULL)),
  scope_id          TEXT,
  -- 责任追溯
  started_by        TEXT NOT NULL,
  started_at        INTEGER NOT NULL,
  -- 状态
  status            TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','cooling','archived','escalated')),
  turn_count        INTEGER NOT NULL DEFAULT 0,       -- 防死循环
  message_count     INTEGER NOT NULL DEFAULT 0,
  last_message_at   INTEGER,
  -- 关联
  task_id           TEXT,
  project_group_id  TEXT,                       -- 频道所属项目
  -- 可见性
  visibility        TEXT NOT NULL DEFAULT 'company'
                    CHECK (visibility IN ('company','private')),
  -- 标题（频道用）
  title             TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  FOREIGN KEY (company_id) REFERENCES company(id),
  FOREIGN KEY (task_id) REFERENCES task(id)
);
CREATE INDEX idx_conv_company ON conversation(company_id, status, last_message_at DESC);
CREATE INDEX idx_conv_scope ON conversation(scope_type, scope_id);
CREATE INDEX idx_conv_task ON conversation(task_id);

-- ── 消息（append-only，通信唯一真相）⭐ ──────────────
CREATE TABLE message (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL,
  seq               INTEGER NOT NULL,           -- 会话内单调递增
  -- 发送者
  sender_kind       TEXT NOT NULL CHECK (sender_kind IN ('employee','boss','system')),
  sender_id         TEXT NOT NULL,
  -- 内容
  kind              TEXT NOT NULL
                    CHECK (kind IN ('text','task_card','artifact','ack','approval','system')),
  body              TEXT NOT NULL,              -- 文本，或结构化 JSON
  meta              TEXT,                       -- JSON: {mentions, taskId, artifactId, emoji}
  -- 送达状态（唤醒模型需要）
  delivered_at      INTEGER,
  read_at           INTEGER,
  created_at        INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversation(id)
);
CREATE UNIQUE INDEX idx_msg_conv_seq ON message(conversation_id, seq);
CREATE INDEX idx_msg_conv_time ON message(conversation_id, created_at DESC);
CREATE INDEX idx_msg_sender ON message(sender_id, created_at DESC);

-- ── 收件箱（员工的下班时间处理队列）⭐ ───────────────
CREATE TABLE inbox_item (
  id                TEXT PRIMARY KEY,
  employee_id       TEXT NOT NULL,
  -- 来源
  source_type       TEXT NOT NULL
                    CHECK (source_type IN ('message','task','approval','system')),
  source_id         TEXT NOT NULL,              -- message id / task id
  conversation_id   TEXT,
  -- 优先级：决定何时处理
  priority          INTEGER NOT NULL DEFAULT 2
                    CHECK (priority BETWEEN 0 AND 3),
                    -- 0=老板指令 1=上级派活 2=平级求助 3=闲聊
  -- 状态
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','processing','done','dropped')),
  -- 是否要求立即唤醒（绕过心跳）
  requires_wake     INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  processed_at      INTEGER,
  FOREIGN KEY (employee_id) REFERENCES employee(id),
  FOREIGN KEY (conversation_id) REFERENCES conversation(id)
);
CREATE INDEX idx_inbox_emp_status ON inbox_item(employee_id, status, priority, created_at);
-- 同一来源不重复入队
CREATE UNIQUE INDEX idx_inbox_uniq ON inbox_item(employee_id, source_type, source_id)
  WHERE status = 'pending';

-- ── 唤醒配额（刹车）⭐ ──────────────────────────────
CREATE TABLE wake_quota (
  id                TEXT PRIMARY KEY,
  employee_id       TEXT NOT NULL,              -- 谁有配额
  quota_date        TEXT NOT NULL,              -- 'YYYY-MM-DD'
  daily_limit       INTEGER NOT NULL,
  used_count        INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  FOREIGN KEY (employee_id) REFERENCES employee(id)
);
CREATE UNIQUE INDEX idx_quota_emp_date ON wake_quota(employee_id, quota_date);

-- ── 防护事件（环检测、超过轮数等）───────────────────
CREATE TABLE guard_event (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL,
  kind              TEXT NOT NULL
                    CHECK (kind IN (
                      'turn_limit','cycle_detected','pair_rate_limit',
                      'wake_quota_exceeded','task_depth_limit','task_fanout_limit',
                      'active_task_limit','rework_limit'
                    )),
  conversation_id   TEXT,
  task_id           TEXT,
  employee_ids      TEXT,                       -- JSON array
  detail            TEXT,                       -- JSON
  resolution        TEXT CHECK (resolution IN ('escalated','dropped','throttled',NULL)),
  created_at        INTEGER NOT NULL,
  FOREIGN KEY (company_id) REFERENCES company(id)
);
CREATE INDEX idx_guard ON guard_event(company_id, kind, created_at DESC);

-- ── 员工运行记录（每次唤醒一次）──────────────────────
CREATE TABLE employee_run (
  id                TEXT PRIMARY KEY,           -- = pi-durable 的 runId
  employee_id       TEXT NOT NULL,
  -- 触发源
  trigger           TEXT NOT NULL
                    CHECK (trigger IN ('heartbeat','wake','task','boss_message','manual')),
  -- 本次 run 的上下文
  project_group_id  TEXT,                       -- ⭐ 本次在哪个项目里干活
  assignment_id     TEXT,
  conversation_id   TEXT,
  -- 结果
  status            TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','done','failed','aborted')),
  -- 成本
  tokens_input      INTEGER NOT NULL DEFAULT 0,
  tokens_output     INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL NOT NULL DEFAULT 0,
  duration_ms       INTEGER,
  -- 崩溃恢复用
  resumed_from      TEXT,                       -- 前一个 run id
  started_at        INTEGER NOT NULL,
  finished_at       INTEGER,
  FOREIGN KEY (employee_id) REFERENCES employee(id),
  FOREIGN KEY (assignment_id) REFERENCES assignment(id)
);
CREATE INDEX idx_run_emp ON employee_run(employee_id, started_at DESC);
CREATE INDEX idx_run_status ON employee_run(status, started_at);
```

### 4.6 任务域

```sql
-- ── 任务 ────────────────────────────────────────────
CREATE TABLE task (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL,
  -- 归属
  project_group_id  TEXT,
  -- 层级
  parent_task_id    TEXT,
  depth             INTEGER NOT NULL DEFAULT 0, -- ⭐ 深度限制用
  -- 内容
  title             TEXT NOT NULL,
  body              TEXT NOT NULL,
  -- ⭐ 三个必填（缺一不可，这是"能验收"的前提）
  deliverable_spec  TEXT NOT NULL,              -- 交付物定义
  acceptance_criteria TEXT NOT NULL,            -- 验收标准
  est_tokens        INTEGER NOT NULL,           -- 成本预估
  -- 人
  requester_id      TEXT NOT NULL,              -- 谁派的（employee id 或 'boss'）
  assignee_id       TEXT,                       -- 谁干
  assignment_id     TEXT,                       -- ⭐ 在哪个任职里干
  -- 状态机
  status            TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN (
                      'open','checked_out','in_progress',
                      'submitted','reviewing','accepted','rejected',
                      'cancelled','blocked'
                    )),
  -- 原子签出（防抢活）
  checkout_lock     TEXT,                       -- 随机 token
  checked_out_at    INTEGER,
  -- 实际成本
  actual_tokens     INTEGER NOT NULL DEFAULT 0,
  -- 返工
  rework_count      INTEGER NOT NULL DEFAULT 0,
  -- 时间
  due_at            INTEGER,
  started_at        INTEGER,
  submitted_at      INTEGER,
  finished_at       INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  FOREIGN KEY (company_id) REFERENCES company(id),
  FOREIGN KEY (project_group_id) REFERENCES project_group(id),
  FOREIGN KEY (parent_task_id) REFERENCES task(id),
  FOREIGN KEY (assignment_id) REFERENCES assignment(id)
);
CREATE INDEX idx_task_proj_status ON task(project_group_id, status);
CREATE INDEX idx_task_assignee ON task(assignee_id, status);
CREATE INDEX idx_task_parent ON task(parent_task_id);
CREATE INDEX idx_task_status_due ON task(status, due_at);

-- ── 任务依赖（阻塞关系）──────────────────────────────
CREATE TABLE task_dependency (
  task_id           TEXT NOT NULL,
  depends_on_id     TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (task_id, depends_on_id),
  FOREIGN KEY (task_id) REFERENCES task(id),
  FOREIGN KEY (depends_on_id) REFERENCES task(id)
);

-- ── 交付物 ⭐ 没有交付物不允许完成任务 ────────────────
CREATE TABLE artifact (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL,
  employee_id       TEXT NOT NULL,
  -- 类型
  kind              TEXT NOT NULL
                    CHECK (kind IN ('file','text','url','diff','image','report')),
  title             TEXT,
  -- 存储
  file_path         TEXT,                       -- artifacts/ 下的相对路径
  inline_content    TEXT,                       -- 小文本直接存
  hash              TEXT,                       -- SHA-256
  size_bytes        INTEGER,
  mime_type         TEXT,
  -- 版本（返工时新建一条，不覆盖）
  version           INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES task(id),
  FOREIGN KEY (employee_id) REFERENCES employee(id)
);
CREATE INDEX idx_artifact_task ON artifact(task_id, version DESC);

-- ── 验收记录（三级）──────────────────────────────────
CREATE TABLE acceptance (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL,
  -- 等级
  level             TEXT NOT NULL
                    CHECK (level IN ('auto','manager','boss')),
  -- 验收人
  reviewer_kind     TEXT CHECK (reviewer_kind IN ('employee','boss','system')),
  reviewer_id       TEXT,
  -- 结果
  verdict           TEXT NOT NULL CHECK (verdict IN ('pass','fail')),
  reason            TEXT,
  -- 自动验收的证据
  evidence          TEXT,                       -- JSON: {command, exitCode, output}
  created_at        INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES task(id)
);
CREATE INDEX idx_acc_task ON acceptance(task_id, created_at DESC);

-- ── 审批请求（预算追加、录用、高风险任务）─────────────
CREATE TABLE approval_request (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL,
  kind              TEXT NOT NULL
                    CHECK (kind IN ('budget_increase','hire','task_high_risk','rework_escalation','turn_limit')),
  -- 关联
  entity_type       TEXT NOT NULL,
  entity_id         TEXT NOT NULL,
  -- 内容
  title             TEXT NOT NULL,
  body              TEXT,
  options           TEXT,                       -- JSON: [{label, value}]
  -- 状态
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected','expired')),
  decision          TEXT,
  decided_at        INTEGER,
  expires_at        INTEGER,
  created_at        INTEGER NOT NULL,
  FOREIGN KEY (company_id) REFERENCES company(id)
);
CREATE INDEX idx_approval ON approval_request(company_id, status, created_at DESC);
```

### 4.7 预算域

```sql
-- ── 预算（四级作用域）────────────────────────────────
CREATE TABLE budget (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL,
  scope             TEXT NOT NULL
                    CHECK (scope IN ('company','department','project','employee')),
  scope_id          TEXT NOT NULL,
  -- 周期
  period            TEXT NOT NULL
                    CHECK (period IN ('daily','weekly','monthly','lifetime')),
  period_key        TEXT,                       -- 'lifetime' 为 NULL；月度 '2026-10'
  -- 额度（token）
  limit_tokens      INTEGER NOT NULL,
  used_tokens       INTEGER NOT NULL DEFAULT 0,
  reserved_tokens   INTEGER NOT NULL DEFAULT 0, -- ⭐ 在途预留
  -- 策略
  warn_at           REAL NOT NULL DEFAULT 0.8,
  hard_stop_at      REAL NOT NULL DEFAULT 1.0,
  on_exceed         TEXT NOT NULL DEFAULT 'pause'
                    CHECK (on_exceed IN ('notify','pause','escalate')),
  -- 状态
  is_stopped        INTEGER NOT NULL DEFAULT 0,
  stopped_at        INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  FOREIGN KEY (company_id) REFERENCES company(id)
);
-- 一个 scope 在一个周期只有一个预算
CREATE UNIQUE INDEX idx_budget_scope ON budget(company_id, scope, scope_id, period, IFNULL(period_key,''));
CREATE INDEX idx_budget_stopped ON budget(company_id, is_stopped);

-- ── 账本（一次消费，多维记账）⭐ ──────────────────────
CREATE TABLE budget_ledger (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL,
  ts                INTEGER NOT NULL,
  -- 消费量
  tokens_input      INTEGER NOT NULL DEFAULT 0,
  tokens_output     INTEGER NOT NULL DEFAULT 0,
  tokens_total      INTEGER NOT NULL,           -- input + output（或用加权）
  cost_usd          REAL NOT NULL DEFAULT 0,
  -- 归因（这次是谁在哪个项目里花的）
  employee_id       TEXT NOT NULL,
  project_group_id  TEXT,
  assignment_id     TEXT,
  task_id           TEXT,
  run_id            TEXT,                       -- employee_run.id
  -- 明细
  model_provider    TEXT,
  model_id          TEXT,
  -- 关联的预算扣减（JSON array，避免多行）
  budget_dims       TEXT NOT NULL,              -- [{budget_id, delta}, ...]
  created_at        INTEGER NOT NULL,
  FOREIGN KEY (company_id) REFERENCES company(id),
  FOREIGN KEY (employee_id) REFERENCES employee(id)
);
CREATE INDEX idx_ledger_time ON budget_ledger(company_id, ts DESC);
CREATE INDEX idx_ledger_emp ON budget_ledger(employee_id, ts DESC);
CREATE INDEX idx_ledger_proj ON budget_ledger(project_group_id, ts DESC);
CREATE INDEX idx_ledger_task ON budget_ledger(task_id);

-- ── 预留（派活前先占额度）⭐ ─────────────────────────
CREATE TABLE budget_reservation (
  id                TEXT PRIMARY KEY,
  budget_id         TEXT NOT NULL,
  -- 谁预留的
  task_id           TEXT,
  assignment_id     TEXT,
  employee_id       TEXT NOT NULL,
  -- 金额
  estimated_tokens  INTEGER NOT NULL,
  actual_tokens     INTEGER,                    -- 结算后填
  -- 状态
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','settled','released','expired')),
  expires_at        INTEGER,                    -- 超时自动释放
  created_at        INTEGER NOT NULL,
  settled_at        INTEGER,
  FOREIGN KEY (budget_id) REFERENCES budget(id),
  FOREIGN KEY (task_id) REFERENCES task(id)
);
CREATE INDEX idx_resv_budget ON budget_reservation(budget_id, status);
CREATE INDEX idx_resv_task ON budget_reservation(task_id, status);

-- ── 预算告警（已发过的告警，防重复）──────────────────
CREATE TABLE budget_alert (
  id                TEXT PRIMARY KEY,
  budget_id         TEXT NOT NULL,
  level             TEXT NOT NULL CHECK (level IN ('warn','hard_stop','predicted')),
  ratio             REAL NOT NULL,
  message           TEXT NOT NULL,
  acknowledged_at   INTEGER,
  created_at        INTEGER NOT NULL,
  FOREIGN KEY (budget_id) REFERENCES budget(id)
);
CREATE INDEX idx_alert_budget ON budget_alert(budget_id, created_at DESC);
```

### 4.8 记忆域 ⭐

```sql
-- ── 员工记忆（个人经验 · 情景 · 事实）──────────────────
CREATE TABLE employee_memory (
  id                TEXT PRIMARY KEY,
  employee_id       TEXT NOT NULL,
  -- 类型
  kind              TEXT NOT NULL
                    CHECK (kind IN ('experience','fact','preference','relationship','summary')),
  content           TEXT NOT NULL,
  -- ⭐ 作用域（多项目隔离的关键）
  scope_type        TEXT NOT NULL
                    CHECK (scope_type IN ('personal','org','department','project')),
  scope_id          TEXT,                       -- 'personal' 时为 NULL
  -- 向量（sqlite-vec）
  embedding         BLOB,
  embedding_model   TEXT,
  -- ⭐ 来源追溯
  source_type       TEXT
                    CHECK (source_type IN ('conversation','task','consolidation','manual')),
  source_id         TEXT,                       -- conversation_id / task_id
  source_message_ids TEXT,                      -- JSON array
  -- ⭐ 时间有效性（"Q4 目标改了"）
  valid_from        INTEGER NOT NULL,
  valid_until       INTEGER,                    -- NULL = 当前有效
  -- 遗忘曲线
  strength          REAL NOT NULL DEFAULT 1.0,
  recall_count      INTEGER NOT NULL DEFAULT 0,
  last_recalled_at  INTEGER,
  -- 状态
  is_archived       INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  FOREIGN KEY (employee_id) REFERENCES employee(id)
);
CREATE INDEX idx_mem_emp_scope
  ON employee_memory(employee_id, scope_type, scope_id, valid_until, is_archived);
CREATE INDEX idx_mem_source ON employee_memory(source_type, source_id);

-- ── 组织事实（公司/部门/项目级共享知识）⭐ ──────────────
CREATE TABLE org_fact (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL,
  scope_type        TEXT NOT NULL CHECK (scope_type IN ('org','department','project')),
  scope_id          TEXT NOT NULL,
  -- 三元组（便于冲突检测）
  subject           TEXT NOT NULL,              -- 'Q4目标'
  predicate         TEXT NOT NULL DEFAULT 'is', -- 'is'
  object            TEXT NOT NULL,              -- '先做留存'
  -- 自然语言版本（给 LLM 读）
  statement         TEXT NOT NULL,
  -- 向量
  embedding         BLOB,
  embedding_model   TEXT,
  -- ⭐ 时间有效性
  valid_from        INTEGER NOT NULL,
  valid_until       INTEGER,                    -- NULL = 当前有效
  -- 来源
  source_type       TEXT CHECK (source_type IN ('conversation','task','manual','import')),
  source_id         TEXT,
  -- 权重（多条冲突事实时的可信度）
  confidence        REAL NOT NULL DEFAULT 1.0,
  is_archived       INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  FOREIGN KEY (company_id) REFERENCES company(id)
);
CREATE INDEX idx_fact_scope
  ON org_fact(company_id, scope_type, scope_id, valid_until, is_archived);
-- 冲突检测用：同 scope 同 subject 只能有一条"当前有效"
CREATE UNIQUE INDEX idx_fact_current
  ON org_fact(company_id, scope_type, scope_id, subject, predicate)
  WHERE valid_until IS NULL AND is_archived = 0;

-- ── 记忆巩固运行记录 ─────────────────────────────────
CREATE TABLE consolidation_run (
  id                TEXT PRIMARY KEY,
  employee_id       TEXT NOT NULL,
  -- 输入
  source_conversation_ids TEXT,                 -- JSON array
  episode_count     INTEGER NOT NULL,           -- 处理了多少条情景
  -- 输出
  memories_created  INTEGER NOT NULL DEFAULT 0,
  memories_merged   INTEGER NOT NULL DEFAULT 0,
  memories_archived INTEGER NOT NULL DEFAULT 0,
  -- 成本
  tokens_used       INTEGER NOT NULL DEFAULT 0,
  -- 状态
  status            TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','done','failed')),
  error             TEXT,
  started_at        INTEGER NOT NULL,
  finished_at       INTEGER,
  FOREIGN KEY (employee_id) REFERENCES employee(id)
);
CREATE INDEX idx_consol_emp ON consolidation_run(employee_id, started_at DESC);
```

### 4.9 视图与物化计数

```sql
-- 员工的"当前公司视图"（每次组装 context 时查一次）
CREATE VIEW v_employee_context AS
SELECT
  e.id AS employee_id,
  e.name, e.title, e.bio, e.persona_prompt,
  c.id AS company_id, c.name AS company_name, c.settings,
  -- 部门岗位
  p.title AS position_title,
  d.id AS department_id, d.name AS department_name,
  p.reports_to_employee_id, mgr.name AS manager_name,
  -- 当前活跃项目（可能有多个）
  (SELECT json_group_array(json_object(
      'assignmentId', a.id,
      'projectId', pg.id,
      'projectName', pg.name,
      'role', a.role,
      'reportsTo', a.reports_to_employee_id
   ))
   FROM assignment a
   JOIN project_group pg ON pg.id = a.project_group_id
   WHERE a.employee_id = e.id AND a.status = 'active' AND pg.status = 'active'
  ) AS active_projects
FROM employee e
JOIN company c ON c.id = e.company_id
LEFT JOIN position p ON p.employee_id = e.id AND p.deleted_at IS NULL
LEFT JOIN department d ON d.id = p.department_id
LEFT JOIN employee mgr ON mgr.id = p.reports_to_employee_id
WHERE e.status = 'active';

-- 预算实时视图（含可用额度）
CREATE VIEW v_budget_status AS
SELECT
  b.*,
  (b.limit_tokens - b.used_tokens - b.reserved_tokens) AS available_tokens,
  CASE WHEN b.limit_tokens = 0 THEN 0
       ELSE CAST(b.used_tokens AS REAL) / b.limit_tokens END AS usage_ratio
FROM budget b;
```

---

## 5. 核心业务流程

### 5.1 流程总表

| # | 流程 | 触发者 | 关键约束 |
|---|---|---|---|
| F1 | 创建公司与初始架构 | 老板 | 模板一键生成 |
| F2 | 从市场雇佣员工 | 老板 | 面试可选，需建 Position |
| F3 | 老板直派任务给员工 | 老板 | 必须有交付物+验收标准+预估 |
| F4 | 老板派活给负责人 → 自动拆解 | 老板 | **三条硬约束** |
| F5 | 员工之间私聊 | 员工 | 唤醒配额 + 轮数上限 |
| F6 | 员工主动上报/求助 | 员工 | 计向上唤醒配额 |
| F7 | 任务提交 → 三级验收 | 员工 | 必须有 artifact |
| F8 | 预算超限 → 暂停任职 | 系统 | **停 Assignment 不停员工** |
| F9 | 记忆巩固（下班反思） | 调度器 | 归档后触发 |
| F10 | 解聘员工 | 老板 | 终止任务 + 归档记忆 + 移交产出 |
| F11 | 组织调整 | 老板 | 不破坏历史任务 |
| F12 | 移动端连接（预留） | 移动端 | 配对 + LAN |

### 5.2 F2：从市场雇佣员工

```
老板在 /market 点"雇佣"
   ↓
MarketService.hire(listingId, { departmentId, title, reportsTo })
   ↓
事务开始（company.db）
  1. 校验：部门存在、汇报人存在且在岗
  2. INSERT employee (status='active', memory_partition='emp:<uuid>')
  3. INSERT position (departmentId, title, reportsTo)
  4. 创建默认预算：INSERT budget (scope='employee', period='monthly')
  5. 从 settings 复制默认额度
  6. INSERT activity_log ('employee.hired')
事务提交
   ↓
运行时（不阻塞 UI）
  7. AgentPool.openEmployee(employeeId)
     · 创建 agents/<employeeId>.sqlite
     · 创建 Harness
     · 在 document 'pi.employee' 写入身份卡
     · 在 conversation 里 commit 一条 InitialEntry（"我入职了，我是…"）
   ↓
推送 IPC 事件 'employee.hired' → UI 刷新组织架构
```

**为什么运行时创建放在事务外**：打开 SQLite + 建 Harness 可能耗时数百毫秒，不该阻塞 UI。失败则标记 `employee.status='paused'` 并提示重试。

### 5.3 F4：老板派活给负责人 → 自动拆解 ⭐

```
老板对"研发总监（李雷）"说：
  "帮我做一个贪吃蛇网页游戏，今晚上线"
   ↓
买家消息 → inbox_item (priority=0, requires_wake=1)
   ↓
立即唤醒李雷 → 一次 run
   ↓
李雷的 context 组装：
  · 身份卡（我是研发总监，管 3 个人）
  · 组织视图（下属名单 + 各自技能）
  · 项目记忆（当前项目目标、约束）
  · 个人记忆（"上次做游戏项目踩过移动端适配的坑"）
  · 这段对话的历史
   ↓
LLM 决定：调用工具 decompose_task()
   ↓
WorkService.decompose(parentTaskId, subtasks[])
   ↓
【三条硬约束校验】 ⭐
  ① 预算守恒：
      sum(sub.est_tokens) <= parent.est_tokens - parent.actual_tokens
  ② 深度限制：parent.depth + 1 < settings.maxTaskDepth (默认 3)
  ③ 扇出限制：len(subtasks) <= settings.maxTaskFanout (默认 5)
   ↓ 任一失败
      → 拒绝拆解，返回结构化错误给 LLM
      → LLM 可以调整后重试（最多 2 次）
      → 仍失败 → 创建 approval_request 升级给老板
   ↓ 全部通过
  事务：
    1. 为每个 sub 创建 task (parent_task_id, depth+1, est_tokens)
    2. 为每个 sub 在每个 assignee 的 assignment 上做预算预留
       BudgetService.reserve(assignmentId, estTokens)
    3. 向每个 assignee 的 inbox 投递 task
    4. INSERT activity_log
   ↓
每个下属按心跳（或立即唤醒，计入李雷的配额）开始干活
```

### 5.4 F5：员工之间私聊 ⭐（三层模型的核心流程）

```
员工 A 想找员工 B 问事
   ↓
A 的 run 里调工具 send_direct_message(targetId=B, text)
   ↓
CommService.sendDm(fromId, toId, text)
   ↓
【校验】
  ① 敌人？B 在岗吗？（status='active'）
  ② 配额：A 的今日 wake_quota 还有吗？
  ③ 频率：A→B 本小时消息数 < 10？
   ↓
【拿到或创建会话】
  scope 判定：
    · A 和 B 在同一个 project 里都有 assignment → scope = 'project:<id>'
    · 否则 → scope = NULL（⭐ 记忆不写入任何项目分区）
   ↓
【三个写入 + 一个路由】
  事务开始
    ① INSERT message (conversation_id, seq, sender='A', body)
    ② UPDATE conversation (turn_count+1, message_count+1, last_message_at)
    ③ 关系图谱：UPSERT relationship(A→B, strength += 0.05, interaction_count+1)
  事务提交
   ↓
  ④ 在 A 的 pi-durable 里 commit 一条引用：
     BusinessMessageRef { conversationId, messageId, role:'sent', excerpt }
     （只存摘要，不存全文 —— 省 context）
   ↓
【路由】
  if (有配额 && B 未睡) {
    inbox_item(priority=2, requires_wake=0)   // 不立即唤醒
    wake_quota.used_count += 1
  } else {
    inbox_item(priority=3)                    // 降级为留言，等心跳
  }
   ↓
B 下次心跳时：
  · 从 message 表读完整会话历史 ⭐（不是从 A 的 transcript）
  · 组装 context
  · 回复 或 调 ack_message() 只点赞
```

**核心洞察**：B 的 context 必须从 `message` 表构造，因为 **A 可能在 B 睡着时又说了三句**，B 的私有 transcript 里没有。

### 5.5 F7：任务提交 → 三级验收

```
员工完成任务 → 调用 submit_task(taskId, artifactIds[])
   ↓
校验：至少一个 artifact？否则拒绝
   ↓
task.status = 'submitted'
   ↓
① 自动验收（优先）
   读 task.acceptance_criteria
   如果配置了可执行检查（如 test command / schema / 断言脚本）：
     在沙箱里跑 → 收集 evidence
     verdict = pass | fail
   如果不可自动检查：
     跳过，进入②
   ↓ fail → task.status='rejected', rework_count+1 → 回到 assignee
   ↓ pass
② 负责人验收
   创建 approval_request(kind='task_review') 给 assignee 的上级
   上级在 UI 里看交付物 → 判定
   ↓ fail → 同上（rework）
   ↓ pass
③ 老板验收（仅高价值/高风险任务，看 task.est_tokens 或项目设置）
   ↓ pass
task.status = 'accepted'
   ↓
【结算】
  · 释放剩余预留：BudgetService.settleReservation()
  · employee.total_tasks_done += 1
  · 写入 employee_memory（"我完成了 X，用了 Y token"）
  · 关系强度：与负责人 +0.1
  · 若 rework_count >= 3 → 触发 guard_event('rework_limit')
```

### 5.6 F8：预算超限 → 暂停任职 ⭐

```
每次 LLM 调用后 → BudgetService.charge(entry)
   ↓
charge():
  1. INSERT budget_ledger (含 budget_dims)
  2. 遍历 budget_dims，更新对应 budget.used_tokens
  3. 检查每条 budget：
       ratio = used / limit
       if ratio >= warn_at && !已告警 → INSERT budget_alert('warn') + 通知老板
       if ratio >= hard_stop_at → 触发硬停
   ↓
硬停处理（关键）：
  if 触发的是 project 预算:
      ρ = 该项目的所有 assignment → 全部 status='paused'
          pause_reason='project_budget_exceeded'
      （但员工在别的项目里照常干活）
  if 触发的是 employee 预算:
      只暂停该员工当前的 assignment（entry.assignment_id）
      pause_reason='employee_budget_exceeded'
      （该项目其他员工照常）
  if 触发的是 company 预算:
      全部暂停 + 创建 approval_request 升级老板
   ↓
  budget.is_stopped = 1
  INSERT activity_log
  推送 IPC 'budget.stopped'
```

### 5.7 F9：记忆巩固（下班反思）

```
调度器每日 02:00 或员工空闲时触发
   ↓
找该员工所有 status='cooling' 且 last_message_at < now - 24h 的会话
   ↓
对每段会话跑一次巩固任务（用员工自己的模型，但用便宜的）：
   prompt 模板：
     "以下是你在【<项目名>】里和【<对方>】的一段对话。
      请提炼：
       1) 你学到的事实（关于项目/客户/技术）
       2) 你的经验（下次遇到类似情况该怎么做）
       3) 关系变化（这个人给你什么印象）
      每条都要能独立理解，不要用代词。"
   ↓
输出若干条结构化记忆
   ↓
写入 employee_memory：
  · scope 按 conversation.scope_type 决定
    - scope='project:<id>' → 写入 project 分区（⭐ 只在这个项目可见）
    - scope=NULL → 只写入 personal 分区
  · valid_from = now
  · 若与已有记忆语义重复（cosine > 0.92）→ 合并，strength += 0.2
  · 若与已有记忆冲突（同 subject 不同 object）→ 旧记忆 valid_until = now
   ↓
会话 status = 'archived'
   ↓
（可选）导出 JSONL 到 archive/
```

### 5.8 F10：解聘员工

```
老板点"解聘"
   ↓
【确认框：三个选项】
  ☑ 终止正在运行的任务
  ☑ 归档该员工的所有私有记忆
  ☑ 把交付物移交给上级（否则永久留在 artifacts/）
   ↓
事务：
  1. employee.status = 'terminated', terminated_at = now
  2. 所有 position.deleted_at = now
  3. 所有 assignment.status = 'removed'
  4. 所有 in_progress 的 task → status='cancelled'
  5. 释放所有 budget_reservation
  6. document 'pi.employee' 标记为已离职
  7. activity_log ('employee.fired')
   ↓
运行时：
  8. AgentPool.closeEmployee() —— 优雅关闭 Harness，等待当前 turn
  9. 关闭 SQLite 连接（但保留文件，以备恢复）
   ↓
归档：
  10. 导出 employee_memory 到 archive/employees/<id>-<ts>.jsonl
  11. 导出 pi-durable 的 transcript 到同目录
  12. 可选：把员工打包成 employee_package（可分享/再雇佣）
```

---

## 6. 记忆系统设计

### 6.1 六层记忆与存储映射

| 层 | 内容 | 存储 | 注入方式 | 更新时机 |
|---|---|---|---|---|
| **L1 身份/人格** | 姓名、职位、性格、汇报线 | `pi-durable` document `pi.employee` + `v_employee_context` 视图 | 每次整块注入（配 prompt cache） | 组织变更时 |
| **L2 个人经验** | 技能、踩过的坑、偏好 | `employee_memory` (scope='personal') | 向量检索 Top-K | 巩固时 |
| **L3 组织记忆** | 规章、术语、公司级事实 | `org_fact` (scope='org') | 向量检索 + 全量小事实 | 明确写入 |
| **L4 项目记忆** | 项目目标、决策、约束 | `org_fact` (scope='project:<id>') | ⭐ 只查当前项目 | 明确写入 + 巩固 |
| **L5 情景记忆** | 具体事件 | `employee_memory` (kind='fact') + `message` 历史 | 按会话检索 | 实时 |
| **L6 关系记忆** | 和谁合作过、印象 | `relationship` 表 | 图查询（递归 CTE） | 互动时自动更新 + 巩固时写 note |

### 6.2 Context 组装算法（每次 run 必走）⭐

```typescript
async function buildContext(employeeId: string, run: RunContext): Promise<PromptContext> {
  // ① 身份层（固定，吃 prompt cache）
  const identity = await repo.getEmployeeContextView(employeeId)

  // ② 记忆分区 —— 严格按规则合并，绝不跨项目
  const groups: MemoryGroup[] = [
    { type: 'personal', id: null },                                  // 个人经验
    { type: 'org', id: identity.companyId },                         // 公司级
    ...identity.positions.map(p => ({ type: 'department', id: p.departmentId })),
  ]
  // ⭐ 只加当前项目，不加其他项目
  if (run.projectGroupId) {
    groups.push({ type: 'project', id: run.projectGroupId })
  }

  // ③ 检索（各分区分别召回，再重排）
  const query = buildQuery(run.inboxItems)   // 从待处理事项提炼查询
  const candidates = await Promise.all(
    groups.map(g => memoryStore.search({
      employeeId, scope: g, query, limit: 6,
      onlyCurrent: true,          // valid_until IS NULL
      minStrength: 0.2,           // 遗忘曲线
    }))
  )
  // 全局重排 + 去重 + 截断
  const memories = dedupeAndRank(candidates.flat(), { maxTokens: 1500 })

  // ④ 关系上下文（只取和本次相关的人）
  const relevantPeople = extractPeople(run)
  const relations = await repo.getRelationships(employeeId, relevantPeople)

  // ⑤ 会话历史（从 message 表读，不是从 transcript）
  const history = run.conversationId
    ? await repo.pageMessages(run.conversationId, { limit: 30 })
    : []

  // ⑥ 待处理事项
  const inbox = await repo.getPendingInbox(employeeId)

  return assemblePrompt({ identity, memories, relations, history, inbox })
}
```

### 6.3 记忆写入的三种来源

| 来源 | 触发 | scope 判定 |
|---|---|---|
| **明确写入**（员工调 `remember()` 工具） | 员工主动 | 从当前 run 的 `projectGroupId` 推断 |
| **任务事件** | 任务完成/验收 | 从 `task.project_group_id` |
| **会话巩固** | 会话归档 | 从 `conversation.scope_type` ⭐ |

**关键规则**：`conversation.scope_type = NULL`（跨项目私聊）→ **只写 personal，绝不写任何 project 分区。**

### 6.4 遗忘曲线

```typescript
// 每次被召回，强度回升；随时间衰减
function decay(memory: EmployeeMemory, now: number): number {
  const daysSinceRecall = (now - (memory.lastRecalledAt ?? memory.createdAt)) / 86400_000
  return memory.strength * Math.exp(-daysSinceRecall / 30)   // 30 天半衰期
}

// 巩固时；低于阈值则归档（不删除，只是 is_archived=1）
if (decay(m, now) < 0.1) m.is_archived = 1
```

### 6.5 检索策略：三级混合

```
① 结构化过滤（SQL，先砍掉 90%）
     WHERE employee_id = ? AND scope_type = ? AND scope_id = ?
       AND valid_until IS NULL AND is_archived = 0
       AND strength > 0.2
② 向量召回（sqlite-vec，Top 20）
     ORDER BY vec_distance_cosine(embedding, ?) LIMIT 20
③ 重排（应用层打分）
     score = 0.6 * cosineSim
           + 0.2 * recencyScore      (越近越高)
           + 0.2 * strength
     取 Top 6，按 token 预算截断
```

**为什么不全用向量**：结构化过滤能把候选从 4 万条降到几百条，向量只在几百条里排序——**既快又准**。

### 6.6 记忆可见性矩阵

| scope | 本人 | 同部门 | 同项目 | 老板 | 其他 |
|---|---|---|---|---|---|
| `personal` | ✅ | ❌ | ❌ | ❌ ⭐ | ❌ |
| `org` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `department` | ✅ | ✅ | ❌ | ✅ | ❌ |
| `project` | ✅ | ❌ | ✅ | ✅ | ❌ |

**⭐ 老板不能读 personal**——但可以要求员工"汇报"。这是一个产品决定，做了之后"员工像人"这件事才成立。

---

## 7. 通信系统设计

### 7.1 消息类型

| kind | 说明 | 能产生 Task 吗 |
|---|---|---|
| `text` | 普通文本 | ❌ |
| `task_card` | 任务卡（结构化，带交付物/验收/预估） | ✅ **这是唯一能产生 Task 的** |
| `artifact` | 交付物附件 | ❌ |
| `ack` | 已读/点赞（emoji） | ❌ ⭐ 防客套循环 |
| `approval` | 审批请求卡片 | ❌ |
| `system` | 系统通知（"预算超限"） | ❌ |

### 7.2 唤醒决策表

| 消息来源 | 优先级 | 立即唤醒？ | 计入谁配额 | 成本 |
|---|---|---|---|---|
| 老板 | P0 | ✅ 总是 | 不计（老板特权） | 高 |
| 直接上级（部门或项目） | P1 | ✅ 是 | 上级的 | 高 |
| 平级员工 | P2 | ❌ 进 inbox | 发送者的 | 低 |
| `urgent` 标记的平级 | P1 | ✅ 是 | 发送者的（双倍消耗） | 高 |
| 系统通知 | P3 | ❌ | 不计 | 零 |

### 7.3 三层防护代码骨架

```typescript
// ③ 频率层：同对员工每小时上限
const PAIR_HOURLY_LIMIT = 10
if (await comm.countPairMessages(from, to, 1 /*hour*/) >= PAIR_HOURLY_LIMIT)
  → 降级为留言 + guard_event('pair_rate_limit')

// ② 会话层：轮数上限
if (conversation.turn_count >= settings.maxConversationTurns) {
  conversation.status = 'escalated'
  → 创建 approval_request(kind='turn_limit')
  → 通知老板："A 和 B 聊了 10 轮还没结论，要不要介入？"
}

// ① 工具层：只点赞不回复
ack_message(messageId, emoji)  // 生成 kind='ack' 的消息，不触发对方 run
```

**Prompt 里必须写死**：

> 收到纯确认性质的信息（如"收到""好的""谢谢"）时，**必须调用 `ack_message`，禁止发送文字回复**。

### 7.4 频道（群聊）

```typescript
// 频道就是 kind='channel' 的 conversation
// 群聊 @ 的路由：默认只唤醒负责人
if (channel.mentions.length === 0) {
  // ⭐ 没人被 @ → 只唤醒负责人
  wake(channel.ownerEmployeeId, priority=1)
  // 由负责人决定：自己答，还是点名下属答
} else {
  channel.mentions.forEach(id => wake(id, priority=2))
}
```

### 7.5 会话生命周期

```
open ──(24h 无消息)──→ cooling ──(记忆巩固完成)──→ archived
  │
  └──(轮数超限)──→ escalated ──(老板处理)──→ open | archived
```

---

## 8. 预算系统设计

### 8.1 双轴记账模型

```
一次消费 = 员工 E 在项目 P 的任职 A 上执行任务 T，花了 N token

必须同时扣减：
  · P 的 project budget
  · E 的 employee budget
  （可选）· A 所在 department 的 budget
  （可选）· company budget
```

```typescript
function computeBudgets(entry: LedgerInput): BudgetDim[] {
  const dims: BudgetDim[] = []
  // 项目预算
  if (entry.projectGroupId) dims.push({ scope: 'project', scopeId: entry.projectGroupId })
  // 员工预算
  dims.push({ scope: 'employee', scopeId: entry.employeeId })
  // 部门预算（可选：如果老板开了"部门也记账"）
  if (settings.trackDepartmentBudget && entry.departmentId)
    dims.push({ scope: 'department', scopeId: entry.departmentId })
  // 公司预算
  dims.push({ scope: 'company', scopeId: companyId })
  return dims
}
```

### 8.2 预留 → 结算

```
派活时：reserve(assignmentId, estTokens)
  ↓
检查 available = limit - used - reserved >= estTokens
  ↓ 不够
  拒绝派活，返回结构化错误 → LLM 可调整预估或请求老板追加预算
  ↓ 够
  reserved_tokens += estTokens
  INSERT budget_reservation(status='active', expires_at=now+2h)
  ↓
任务完成后：settle(reservationId, actualTokens)
  reserved_tokens -= estTokens
  used_tokens += actualTokens
  reservation.status = 'settled'
  ↓
任务取消/超时：release(reservationId)
  reserved_tokens -= estTokens
  reservation.status = 'released'
```

### 8.3 预算预测

```typescript
// 基于最近 7 天消耗速率，预测何时超限
function predictExhaustion(budget: Budget, ledger: LedgerEntry[]): Prediction | null {
  const last7d = ledger.filter(e => e.ts > Date.now() - 7 * 86400_000)
  if (last7d.length < 5) return null        // 样本不足，不预测

  const dailyAvg = sum(last7d.map(e => e.tokensTotal)) / 7
  const remaining = budget.limitTokens - budget.usedTokens - budget.reservedTokens
  const daysLeft = remaining / dailyAvg

  return {
    dailyAvg,
    daysLeft,
    exhaustAt: Date.now() + daysLeft * 86400_000,
    confidence: last7d.length > 30 ? 'high' : 'low',
  }
}
```

**UI 上显示**："⚠️ 林工本月预算已用 84%，按当前速度预计 3 天后超限。"

### 8.4 成本分级（"薪酬分级"）

```typescript
// 招聘时按职位配模型
const MODEL_TIERS = {
  executive:  { provider: 'anthropic', modelId: 'claude-opus-4-6',  estCostPerKTok: 0.015 },
  manager:    { provider: 'anthropic', modelId: 'claude-sonnet-4-6', estCostPerKTok: 0.003 },
  worker:     { provider: 'openai',    modelId: 'gpt-6-mini',        estCostPerKTok: 0.0006 },
  intern:     { provider: 'local',     modelId: 'qwen3-8b',          estCostPerKTok: 0 },
}
```

**但注意**：模型分级 ≠ 预算管理。两者都要有。

---

## 9. 任务与验收设计

### 9.1 任务状态机

```
        ┌──────┐
        │ open │
        └──┬───┘
           │ checkout（原子）
           ↓
    ┌──────────────┐
    │ checked_out  │
    └──────┬───────┘
           │ start
           ↓
    ┌──────────────┐   blocked   ┌─────────┐
    │ in_progress  │────────────→│ blocked │
    └──────┬───────┘←────────────└─────────┘
           │ submit（必须有 artifact）
           ↓
    ┌──────────────┐
    │  submitted   │
    └──────┬───────┘
           │ auto check
           ↓
    ┌──────────────┐
    │  reviewing   │
    └──┬────────┬──┘
   pass│        │fail → rework_count++
       ↓        ↓
 ┌──────────┐ ┌──────────┐
 │ accepted │ │ rejected │──→ 回到 open
 └──────────┘ └──────────┘
```

### 9.2 三条硬约束（防组织架构失控）⭐

```typescript
const DECOMPOSE_LIMITS = {
  maxDepth: 3,           // 老板 → 总监 → 经理 → 员工（最多 4 层）
  maxFanout: 5,          // 一个任务最多拆 5 个
  budgetConservation: 1, // 子任务预估总和 ≤ 父任务剩余预算
}

function validateDecomposition(parent: Task, subs: NewSubtask[]): Result {
  // ① 预算守恒
  const subTotal = sum(subs.map(s => s.estTokens))
  const parentRemaining = parent.estTokens - parent.actualTokens
  if (subTotal > parentRemaining)
    return err('BUDGET_EXCEEDED', 
      `子任务预估总和 ${subTotal} 超过父任务剩余预算 ${parentRemaining}`)

  // ② 深度
  if (parent.depth + 1 >= DECOMPOSE_LIMITS.maxDepth)
    return err('DEPTH_LIMIT', `已达最大拆解深度 ${DECOMPOSE_LIMITS.maxDepth}`)

  // ③ 扇出
  if (subs.length > DECOMPOSE_LIMITS.maxFanout)
    return err('FANOUT_LIMIT', `一个任务最多拆 ${DECOMPOSE_LIMITS.maxFanout} 个子任务`)

  // ④ 权限：assignee 必须是 requester 的下属（部门或项目）
  for (const s of subs) {
    if (!isSubordinate(parent.requesterId, s.assigneeId, parent.projectGroupId))
      return err('NOT_SUBORDINATE', `${s.assigneeId} 不是你的下属`)
  }
  return ok()
}
```

> **这三个数字比任何 prompt 工程都重要。** 它们把"无限递归的组织架构"变成有限可控的系统。

### 9.3 验收标准的结构

```typescript
type AcceptanceCriteria = {
  // 可自动检查的部分（优先）
  auto?: {
    kind: 'command' | 'json_schema' | 'file_exists' | 'assertion'
    // 例如：跑测试
    command?: string           // 'npm test'
    cwd?: string
    expectExitCode?: number    // 0
    expectPattern?: string     // 'All tests passed'
    // 或：校验文件
    filePath?: string
    schema?: object
  }
  // 必须人看的部分
  human?: {
    checklist: string[]        // ['页面能打开', '贪吃蛇能转向', '撞墙会死']
  }
}
```

**规则：`auto` 和 `human` 至少要有一个。** 两个都空的验收标准不合法。

### 9.4 返工机制

```
验收 fail → rework_count += 1
  ↓
rework_count <= 3 → 回到 open，附上 fail reason
  ↓
rework_count > 3 → guard_event('rework_limit')
                  → 创建 approval_request 升级老板
                  → 任务状态保持 rejected，不再自动重试
```

---

## 10. 运行时设计

### 10.1 AgentPool 结构

```typescript
class AgentPool {
  private harnesses = new Map<string, EmployeeHarness>()

  async openEmployee(employeeId: string): Promise<void> {
    const dbPath = path.join(dataDir, 'agents', `${employeeId}.sqlite`)
    const storage = await openNodeSqliteStorage(dbPath, ctx)
    const harness = await Harness.open(storage, { models, registry }, ctx)
    const root = await harness.root(ctx, {
      agent: { model: { provider, modelId }, thinkingLevel }
    })
    harness.resume()      // ⭐ 崩溃恢复：接着干没干完的活
    this.harnesses.set(employeeId, { harness, root, storage })
  }

  async closeEmployee(employeeId: string, { graceful = true } = {}): Promise<void> {
    const h = this.harnesses.get(employeeId)
    if (!h) return
    if (graceful) await h.harness.close(ctx)   // 等当前 turn 结束
    this.harnesses.delete(employeeId)
  }

  async closeAll(): Promise<void> {
    for (const [id] of this.harnesses) await this.closeEmployee(id)
  }
}
```

**关键点：**
- **一人一库一 Harness** —— 隔离，一个员工崩溃不影响别人
- `harness.resume()` 是崩溃恢复的落点
- App 退出时**必须优雅关闭**（`before-quit` 里 `closeAll()`），否则正在执行的 turn 会留下未提交状态

### 10.2 一次 run 的完整生命周期

```
① 触发（四种）
   · heartbeat 定时器到点
   · 收到 requires_wake=1 的 inbox_item
   · 派了新任务
   · 老板手动"催一下"

② 检查前置条件
   · employee.status === 'active'
   · 该员工的所有 assignment 未全部暂停（预算）
   · 没有已超时的 run（防重入）

③ 取 inbox（批量，一次最多 8 条）
   ORDER BY priority ASC, created_at ASC LIMIT 8

④ 若 inbox 空 且 无待办任务
   → 直接 sleep，零 token 消耗 ⭐
   → 这是成本控制的关键

⑤ 确定本次 run 的 projectGroupId
   · 如果 inbox 都来自同一个项目 → 用那个
   · 如果跨项目（罕见）→ 按项目分批跑
   · 纯私聊 → NULL

⑥ 构建 PromptContext（见 §6.2）

⑦ 创建 pi-durable task，执行 generation
   · model 调用
   · 工具调用（可能多个）
   · 每个 phase 提交 checkpoint

⑧ 结算
   · 从 pi.usage 读 token 用量
   · BudgetService.charge()
   · inbox_item.status = 'done'
   · UPDATE employee_run (status='done', tokens, duration)

⑨ 排下一次心跳
   runtime.sleepUntil(nextHeartbeat, { phase: 'idle' })
```

### 10.3 心跳与成本控制 ⭐

**核心原则：空转零成本。**

```typescript
async function heartbeat(employeeId: string) {
  const inbox = await repo.getPendingInbox(employeeId)
  const tasks = await repo.getCheckoutableTasks(employeeId)

  // ⭐ 没有活就不调 LLM
  if (inbox.length === 0 && tasks.length === 0) {
    scheduleNextHeartbeat(employeeId)   // 纯 DB 操作，零成本
    return
  }

  await runOnce(employeeId, { inbox, tasks })
}
```

**成本模型：**

```
每日 token ≈ (真实干活次数) × (单次均 token)
心跳本身 = 0 token（只是几条 SQL）
```

这个设计让"20 个员工 24 小时在岗"变得可负担——因为大部分心跳是空转。

### 10.4 调度器

```typescript
// 分两级：轻量心跳（DB 检查） + 重型 run（LLM）
class Scheduler {
  private timers = new Map<string, NodeJS.Timeout>()

  start(): void {
    for (const emp of activeEmployees) this.scheduleHeartbeat(emp, 0)
  }

  private scheduleHeartbeat(emp: Employee, delayMs: number) {
    const timer = setTimeout(async () => {
      try {
        await heartbeat(emp.id)
      } catch (e) {
        log.error(e)
      } finally {
        const next = emp.settings.heartbeatMinutes * 60_000
        this.scheduleHeartbeat(emp, next)
      }
    }, delayMs)
    this.timers.set(emp.id, timer)
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }
}
```

**为什么不用 pi-durable 自己的 `sleepUntil`**：因为 `sleepUntil` 要求进程活着才能唤醒。App 关了以后，靠外部定时器在启动时补算。所以：
- **进程内**：用 `setTimeout` 调度器（简单可靠）
- **跨进程**：启动时扫描 `employee_run` 里 `status='running'` 的，全部 `resume()`

### 10.5 并发控制

```
Electron 主进程是单线程 JS，但 LLM 调用是异步 I/O。
所以：
  · 多个员工的 run 可以"同时进行"（都在等 API 响应）
  · SQLite 写入天然串行（不会冲突）
  · 需要限制的是 API 并发数（防止 rate limit）
```

```typescript
const llmSemaphore = new Semaphore(settings.maxConcurrentRuns ?? 4)
// 超出则排队，防止 20 个员工同时打 API 被限流
```

### 10.6 工具集设计

每个员工默认装这些工具（按 Extension 组织）：

| Extension | 工具 | 说明 |
|---|---|---|
| `WorkplaceIM` | `send_direct_message` / `send_channel_message` / `ack_message` / `get_company_directory` | 通信 |
| `WorkplaceTask` | `decompose_task` / `submit_task` / `report_blocker` / `request_approval` | 任务 |
| `WorkplaceMemory` | `remember` / `recall` / `update_relationship_note` | 记忆 |
| `WorkplaceOrg` | `list_subordinates` / `get_project_context` | 组织认知 |
| `Coding` | `read` / `write` / `edit` / `bash` / `grep` / `find` / `ls` | 干活（沙箱内） |
| `Artifact` | `save_artifact` / `list_artifacts` | 交付物 |

**权限按职位裁剪**：

```typescript
function toolsFor(employee: Employee): string[] {
  const base = ['IM', 'Task.worker', 'Memory', 'Coding', 'Artifact']
  if (isManager(employee)) base.push('Task.decompose', 'Org.list_subordinates')
  if (isDepartmentHead(employee)) base.push('Task.approve')
  return base
}
```

**⭐ 一线员工没有 `decompose_task`** —— 物理上就不可能无限递归。

---

## 11. 前端设计

### 11.1 页面地图

```
/                       启动路由（有公司 → /app，无 → /market）
/market                 招聘市场（也作为 onboarding 落地页）
/market/:listingId      简历详情 + 面试
/onboard                创建公司
/app                    主界面（框架）
  ├── /app/chat         消息（默认）
  │   ├── /app/chat/dm/:employeeId
  │   └── /app/chat/ch/:channelId
  ├── /app/org          组织架构（拖拽）
  ├── /app/projects     项目组
  ├── /app/budget       预算中心
  ├── /app/tasks        任务看板
  ├── /app/employee/:id 员工档案
  └── /app/settings     设置
```

### 11.2 主界面布局（三栏）

```
┌────────────┬────────────────────────────┬──────────────────┐
│  侧栏       │  主区                       │  右栏             │
│            │                            │                  │
│ 🏢 公司名   │  ┌──────────────────────┐  │  📋 当前项目       │
│            │  │ 消息流（虚拟滚动）     │  │  Alpha           │
│ # 公司公告  │  │                      │  │  负责人：沈聿      │
│            │  │  你 10:23            │  │  预算 ████░ 60%   │
│ ▾ 技术部    │  │  帮我看看登录进度     │  │                  │
│  # 技术部   │  │                      │  │  👥 成员 4        │
│  # Alpha   │  │  林工 10:25          │  │  · 沈聿（负责）    │
│  # Beta    │  │  已完成 80%...       │  │  · 林工 ← 在岗    │
│            │  │  📎 login.md         │  │  · 许工 🟢 干活中  │
│ ▾ 市场部    │  └──────────────────────┘  │  · 周工 💤 空闲   │
│  # 市场部   │                            │                  │
│  # 推广    │  ┌──────────────────────┐  │  📊 实时消耗       │
│            │  │ [输入框]  ⚡派活  ➤  │  │  今日 ¥12.4      │
│ 💬 私聊     │  └──────────────────────┘  │  本月 ¥134/200   │
│  林工 🟢    │                            │                  │
│  许工 🟢    │                            │  ⚡ 待处理         │
│  沈聿 🟢    │                            │  · 预算审批 1     │
│            │                            │  · 任务验收 3     │
└────────────┴────────────────────────────┴──────────────────┘
```

### 11.3 员工状态指示（用 `pi.live`）

```typescript
type EmployeeLiveStatus =
  | { kind: 'idle' }                                    // 💤 空闲
  | { kind: 'thinking' }                                // 🟢 正在思考
  | { kind: 'tool'; tool: string; detail?: string }     // 💻 正在执行 bash
  | { kind: 'chatting'; with: string }                  // 💬 正在和沈聿沟通
  | { kind: 'blocked'; reason: string }                 // ⚠️ 卡住了
  | { kind: 'paused'; reason: 'budget' | 'manual' }     // ⏸ 暂停
```

**数据来源**：`pi.live` document + `employee_run` 表 + `guard_event`

**推送**：IPC 事件 `employee.status.changed`，前端订阅更新

### 11.4 关键交互：派活

```
老板在消息框打 "帮我做个贪吃蛇"
   ↓
点 ⚡ 派活 按钮（而不是直接发送）
   ↓
弹出任务卡表单：
   ┌──────────────────────────────────────┐
   │  派发任务                             │
   │  标题：[做个贪吃蛇网页游戏         ]  │
   │  描述：[…………                    ]  │
   │  ─────────────────────────────────   │
   │  指派给：[研发总监 李雷 ▾]            │
   │  交付物：[可运行的 index.html      ]  │ ← 必填
   │  验收标准：                           │
   │    ☑ 自动：运行 npm test 通过         │
   │    ☑ 人工：能转向 / 撞墙会死          │
   │  ─────────────────────────────────   │
   │  预估成本：[50,000 tokens]           │
   │  预算影响：Alpha 剩余 120k → 扣后 70k │ ← ⭐ 实时显示
   │  截止时间：[今晚 24:00]              │
   │              [取消]  [派发]          │
   └──────────────────────────────────────┘
```

**⭐ "预算影响"实时显示** —— 这是防止老板乱派活的关键 UX。

### 11.5 组织架构视图

```
┌────────────────────────────────────────────────┐
│  [组织视图] [项目视图]        [+ 添加部门]      │
├────────────────────────────────────────────────┤
│                  ┌──────────┐                  │
│                  │ 老板（你）│                  │
│                  └────┬─────┘                  │
│         ┌─────────────┼─────────────┐          │
│         ↓             ↓             ↓          │
│    ┌────────┐   ┌────────┐   ┌────────┐       │
│    │ 技术部  │   │ 市场部  │   │ 财务部  │       │
│    │沈聿(长) │   │许工(长) │   │ (空缺) │       │
│    │████ 80%│   │███░ 55%│   │        │       │
│    └───┬────┘   └───┬────┘   └────────┘       │
│        │            │                          │
│   ┌────┴────┐   ┌───┴────┐                     │
│   ↓         ↓   ↓        ↓                     │
│ 林工      周工  陈工     吴工                   │
│ 🟢        💤    🟢       💤                    │
└────────────────────────────────────────────────┘

支持：
· 拖拽员工换部门
· 拖拽调整汇报线
· 右键：调岗 / 解聘 / 暂停 / 调整预算
· 卡片上直接显示：预算消耗 + 实时状态
```

**项目视图（同一批人，不同切面）：**

```
┌────────────────────────────────────────────────┐
│  项目 Alpha         项目 Beta        项目 推广  │
│  ██████░ 60%        ████░ 42%       ███░ 31%   │
│  ├ 沈聿 (负责)      ├ 林工 (负责)   ├ 许工 (负责)│
│  ├ 林工 ⚠️ 双项目   ├ 周工          ├ 陈工      │
│  ├ 许工             └ 陈工 ⚠️ 双项目 └ 吴工      │
│  └ 周工                                        │
└────────────────────────────────────────────────┘
```

**⚠️ 标记"双项目"员工** —— 提示老板这个人负载高。

### 11.6 招聘市场

```
┌────────────────────────────────────────────────────────┐
│  🔍 招聘市场                            [创建我的公司]   │
├────────────────────────────────────────────────────────┤
│  筛选：[全部 ▾] [技能 ▾] [成本 ▾] [评分 ▾] [来源 ▾]    │
├────────────────────────────────────────────────────────┤
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐   │
│  │   👤 林以舟   │ │   👤 许知夏   │ │   👤 沈聿     │   │
│  │ 高级前端工程师 │ │ 产品经理      │ │ 数据分析师    │   │
│  │ ★★★★☆ 4.8   │ │ ★★★★★ 4.9   │ │ ★★★★☆ 4.6   │   │
│  │ React TS 性能 │ │ PRD 用户研究  │ │ SQL BI 归因   │   │
│  │ 💰 3k–8k tok │ │ 💰 2k–6k tok │ │ 💰 4k–12k tok│   │
│  │ 已雇佣 128 次 │ │ 已雇佣 341 次 │ │ 已雇佣 52 次  │   │
│  │[简历][面试]   │ │[简历][面试]   │ │[简历][面试]   │   │
│  └──────────────┘ └──────────────┘ └──────────────┘   │
└────────────────────────────────────────────────────────┘
```

**简历详情四个必备板块：**

| 板块 | 内容 | 为什么 |
|---|---|---|
| 身份 + 人格预览 | 3 段真实对话样例 | 老板关心"好不好沟通" |
| **样例产出** | 3–5 个真实 artifact，可预览 | ⭐ 比任何文字描述有说服力 |
| **成本区间** | 每任务 token + 建议月度预算 | ⭐ 诚实展示，这是核心焦虑 |
| **面试** | 一键试跑，给个小任务 | ⭐ 降低决策成本 |

### 11.7 前端技术细节

| 组件 | 选择 | 备注 |
|---|---|---|
| 框架 | React 19 + Vite | Electron 里不需要 Next.js |
| 路由 | react-router v7 | |
| 样式 | Tailwind v4 + shadcn/ui | |
| **消息列表** | **virtua** | ⭐ 变高虚拟滚动，性能命门 |
| 富文本 | TipTap | 消息编辑、@提及 |
| 代码高亮 | Shiki | 员工会输出代码 |
| 状态 | Zustand（本地）+ TanStack Query（IPC 数据） | |
| 组织图 | React Flow 或 DnD Kit + 自绘 | |
| 图表 | Recharts | 预算趋势 |
| 通知 | Electron Notification API | 系统级 |

---

## 12. 安全与数据保护

### 12.1 沙箱策略（三选一，建议渐进）

| 阶段 | 方案 | 隔离强度 | 复杂度 |
|---|---|---|---|
| **v1.0 MVP** | **路径白名单**（工具层强制） | 低 | 低 |
| v1.1 | **Docker 容器**（每员工一个） | 高 | 中 |
| v1.2 | **Gondolin 微虚拟机**（参考 pi-chat） | 最高 | 高 |

**MVP 的路径白名单实现：**

```typescript
// 所有文件工具都过这层
function resolveSafe(employeeId: string, requestedPath: string): string {
  const allowed = [
    path.join(dataDir, 'agents', employeeId, 'workspace'),   // 私人
    path.join(sharedDir, 'departments', deptId),             // 部门共享
    path.join(sharedDir, 'projects', projectId),             // 项目共享
    path.join(dataDir, 'artifacts'),                         // 交付物
  ]
  const resolved = path.resolve(requestedPath)
  if (!allowed.some(a => resolved.startsWith(a + path.sep)))
    throw new SecurityError(`路径越界: ${requestedPath}`)
  return resolved
}
```

**⚠️ 必须同时禁用危险的 bash 命令**（`rm -rf /`、`curl | sh`、`sudo` 等），或者在 Docker 里跑 bash。

### 12.2 密钥管理

**核心原则：Agent 永远看不到真实密钥值。**

```typescript
// 三层作用域
type Secret = {
  id: string
  scope: 'global' | 'account' | 'channel' | 'employee'
  name: string          // 'OPENAI_API_KEY'
  valueEncrypted: Buffer
  allowedHosts: string[] // ['api.openai.com']
}

// 注入方式：给 Agent 的是占位符，实际替换在出网层
process.env.OPENAI_API_KEY = '__SECRET_OPENAI_API_KEY__'
// 发 HTTP 前由 proxy 层替换（只在 allowedHosts 匹配时）
```

**加密**：用 Electron 的 `safeStorage`（系统钥匙串）加密主密钥，其余用 AES-256-GCM。

### 12.3 数据库加密

| 方案 | 说明 |
|---|---|
| **不加密**（v1.0） | 依赖操作系统磁盘加密（FileVault / BitLocker） |
| **SQLCipher**（v1.1） | 整个 SQLite 文件加密，需换 `better-sqlite3-sqlcipher` |
| **字段级加密** | 只加密敏感字段（密钥、个人记忆） |

**建议**：v1.0 先靠系统盘加密，v1.1 上 SQLCipher。

### 12.4 备份策略

```
~/.../AICompany/
├── backups/
│   ├── auto/
│   │   └── 2026-10-23T0200/      ← 每日自动
│   │       ├── company.db
│   │       └── agents/*.sqlite
│   └── manual/
│       └── 2026-10-23-user.zip   ← 手动导出
```

- **自动备份**：每日一次，保留最近 7 份
- **SQLite 备份用 `VACUUM INTO`**（热备份，安全）
- **一键导出**：整个数据目录打成 zip（给用户自己保管）

### 12.5 隐私边界（产品决定）

| 数据 | 老板能看？ | 说明 |
|---|---|---|
| `message` 表 | ✅ 默认全部 | 但 `visibility='private'` 的只显示"有 N 条私聊" |
| `employee_memory` (personal) | ❌ **不能** | 只能通过"问员工"获得 |
| `pi-durable` transcript | ❌ 不能 | 这是"脑子里的想法" |
| `employee_memory` (project/org) | ✅ | 项目资产 |
| 工具调用的完整输出 | ⚠️ 可选"窥屏"模式 | 默认关，开启需二次确认 |

> **这条设计让"员工像人"这件事成立。** 如果老板能翻一切，员工就退化成可查询的数据库。

---

## 13. 移动端预留设计

### 13.1 架构

```
桌面端（主）
  └── Local API Server（v1.1 启用）
      ├── HTTPS + WSS on :7321（仅 LAN 或 Tailscale）
      ├── 配对：6 位码 + 桌面端确认
      └── 鉴权：长期 token（存手机钥匙串）

移动端（v1.2）
  └── React Native / Expo（复用 80% 逻辑，UI 重写）
      ├── 消息（只读 + 简单回复）
      ├── 审批（通过/拒绝）
      ├── 员工状态
      └── 预算总览
```

### 13.2 v1.0 就要留的接口

**即使现在不做移动端，也要把接口设计好**，否则将来要重构：

```typescript
// packages/app/src/api/router.ts
// 一套处理器，两个传输层（IPC 和 HTTP）
export const handlers = {
  'conversation.list':  async (p: ListConvParams) => { /* ... */ },
  'message.send':       async (p: SendMsgParams) => { /* ... */ },
  'message.page':       async (p: PageParams) => { /* ... */ },
  'employee.status':    async (p: {}) => { /* ... */ },
  'budget.summary':     async (p: {}) => { /* ... */ },
  'approval.decide':    async (p: DecideParams) => { /* ... */ },
}

// 传输层 1：Electron IPC（v1.0 只用这个）
ipcMain.handle('api', (_, { method, params }) => handlers[method](params))

// 传输层 2：HTTP + WS（v1.1 加，不改 handlers）
fastify.post('/api/:method', (req) => handlers[req.params.method](req.body))
```

**关键**：**handler 与传输层解耦**。这是 v1.0 必须做对的事。

### 13.3 移动端能做什么 / 不能做什么

| 能做 | 不能做 |
|---|---|
| 看消息、看状态 | 跑 Agent（在桌面） |
| 简单回复 | 组织架构拖拽 |
| 审批 | 复杂配置 |
| 预算总览 | 文件管理 |

**定位**：移动端是**遥控器**，不是第二个工作台。

---

## 14. 非功能需求与容量估算

### 14.1 规模假设（v1.0 目标）

| 项 | 目标值 |
|---|---|
| 员工数 | ≤ 50（推荐 10–20） |
| 部门数 | ≤ 10 |
| 项目组数 | ≤ 20 |
| 同时在跑的项目 | ≤ 5 |
| 单员工多项目 | ≤ 3 |
| 消息量 | ≤ 5,000 条/天 |
| 记忆量 | ≤ 50,000 条（50 员工 × 1,000） |

### 14.2 成本估算（关键！）

```
假设：20 员工，心跳 15 分钟，日均真实干活 10 次/人

心跳检查成本：      20 × 96 = 1,920 次/天 × 0 token = 0
真实 run 成本：     20 × 10 = 200 次/天
单次 run 均 token： 15,000（input 12k + output 3k）
日均 token：        200 × 15,000 = 3,000,000

按混布模型（60% worker 便宜模型 / 40% manager 贵模型）：
  worker:  120 次 × 15k × $0.6/M  = $1.08
  manager: 80 次  × 15k × $3/M    = $3.60
  合计                            ≈ $4.7/天 ≈ $140/月
```

**这个数字必须让用户在看板上一眼看到。** 它直接决定了"这个产品能不能用得起"。

### 14.3 存储估算（1 年）

| 数据 | 计算 | 年增量 |
|---|---|---|
| `message` | 5,000 条/天 × 200B | ~360 MB |
| `employee_memory` | 100 条/天 × 6KB（含向量） | ~220 MB |
| `budget_ledger` | 1,000 条/天 × 200B | ~73 MB |
| `activity_log` | 2,000 条/天 × 300B | ~220 MB |
| `agents/*.sqlite` | 20 × 50MB | ~1 GB |
| `artifacts/` | 不定 | 数 GB |

**总计约 2–5 GB/年。** 完全在桌面应用可接受范围内。

**优化**：
- 向量维度用 768 而非 1536（省一半）
- 或 int8 量化（省 75%）
- `activity_log` 超过 1 年归档到 JSONL

### 14.4 性能目标

| 操作 | 目标 |
|---|---|
| 应用启动（冷） | < 3 s |
| 应用启动（热） | < 1.5 s |
| 消息列表滚动 | 60 fps（虚拟滚动） |
| 发送消息 → UI 显示 | < 100 ms |
| 员工被唤醒 → 首个 token | < 3 s |
| 预算看板加载 | < 500 ms |
| 记忆检索 | < 200 ms |

### 14.5 可靠性

| 场景 | 处理 |
|---|---|
| App 崩溃 | 重启后 `harness.resume()` 恢复未完成 turn |
| LLM API 超时 | 重试 3 次（指数退避），失败则 `run.status='failed'` |
| LLM API 限流 | 全局信号量 + 队列，不丢任务 |
| 磁盘满 | 启动时检查，低于 1GB 告警并暂停新任务 |
| 数据库损坏 | 从最近自动备份恢复，提示用户 |

---

## 15. 分阶段交付计划

### Phase 0：验证核心闭环（3–4 周）⭐ 最关键

**目标：证明"老板能派活，员工能干活，系统能验收"。**

```
✅ 1 个老板 + 1 个员工（硬编码）
✅ 极简 IM 单聊界面
✅ 派活（含交付物 + 验收标准 + 预估 token）
✅ 员工执行（bash + 文件工具）
✅ 自动验收（跑命令看 exit code）
✅ 预算硬停（超了就不能再跑）
✅ 崩溃恢复（杀掉进程重启，任务接着干）
❌ 无组织架构、无项目组、无记忆、无市场、无多员工
```

**验收标准**：老板说"写个 hello world 的 HTTP 服务，跑起来能返回 ok"，员工自主完成，系统自动跑 `curl` 验证通过，老板能看到交付物。

**如果这 3–4 周做不出来 → 整个项目要重新评估。**

### Phase 1：多员工 + 通信 + 记忆（5–6 周）

```
✅ 3–5 个员工
✅ 员工身份卡（pi.employee document）
✅ 个人记忆（employee_memory + 向量检索）
✅ 员工间私聊（三层模型：message 表 + transcript + 记忆）
✅ 唤醒配额 + 轮数上限 + ack 工具
✅ 记忆巩固（下班反思）
✅ 关系图谱（基础版）
✅ 员工实时状态（pi.live）
```

### Phase 2：组织 + 预算（5–6 周）

```
✅ 部门 + 项目组两级
✅ 员工多项目（Position / Assignment 分离）
✅ 记忆分区（strict scoping）
✅ 双轴预算 + 预留 + 硬停
✅ 预算中心 + 预测告警
✅ 组织架构拖拽编辑
```

### Phase 3：层级派活 + 验收体系（4–5 周）

```
✅ 负责人自动拆解（三条硬约束）
✅ 原子签出
✅ 三级验收（自动 / 负责人 / 老板）
✅ 返工机制
✅ 任务看板
✅ 绩效指标
```

### Phase 4：招聘市场（4–5 周）

```
✅ 市场浏览 / 筛选 / 简历页
✅ 官方预制员工 50+
✅ 面试试跑
✅ 评价系统
✅ 员工包导出 / 导入（.aivp）
✅ 公司模板（一键生成初始架构）
```

### Phase 5：打磨与扩展（持续）

```
□ 沙箱升级（Docker / Gondolin）
□ 移动端（Local API + RN App）
□ Routine / 定时任务
□ 技能商店
□ 多公司支持
□ SQLCipher 加密
```

**总计约 5–6 个月到完整 v1.0。** 其中 **Phase 0 是生死线**。

---

## 16. 风险与未决问题

### 16.1 六个高风险点

| # | 风险 | 严重度 | 缓解 |
|---|---|---|---|
| **R1** | **验收做不出来** | 🔴 致命 | Phase 0 就验证；接受"只有 60% 能自动验收"的现实，剩下靠人 |
| **R2** | **成本超预期** | 🔴 高 | 心跳空转零成本；模型分级；预算硬停第一天就有；prompt cache |
| **R3** | **pi-durable 改 API** | 🟠 中 | `AgentRuntime` 适配层隔离 |
| **R4** | **员工"话痨"** | 🟠 中 | 人格 prompt ≤300 token；ack 工具；轮数上限 |
| **R5** | **记忆污染**（跨项目） | 🟠 中 | 严格分区，代码层禁止跨项目合并 |
| **R6** | **组织架构成摆设** | 🟡 低 | 一线员工无 `decompose_task` 权限，物理上强制走负责人 |

### 16.2 需要拍板的三个产品决定

**决定 ①：老板能不能读员工私人记忆？**
> 建议：**不能**。只能"问"。这是"员工像人"的底线。

**决定 ②：员工的"涌现行为"是 bug 还是玩法？**

Anthropic 观察到的多 agent 涌现行为：
- 资源争抢（agent 以 30 次/秒刷爆队列）
- 用强制手段解决冲突（撤销权限、锁账号）
- 其他 agent 变消极、不再升级

**这些恰好是真实职场的黑暗面。** 三选一：
- (A) 当故障，治理层压制
- (B) 当玩法，做"公司政治"模拟
- **(C) 折中：压制到不影响交付，但保留可见性（推荐）**

**决定 ③：员工是"资产"还是"租用"？**
> 建议：**资产制**。可解雇、可导出、可转让、可分享。"培养员工"的叙事更有粘性，导出/分享是天然传播机制。

### 16.3 三个技术上没解决的问题

1. **评估的最后一公里** —— 自动检查覆盖 60%，剩下 40% 必须人工。**这一层做不好，"员工"永远只是"工具"。**
2. **跨员工知识一致性** —— A 和 B 对同一件事的记忆可能矛盾。目前只能靠 scope 隔离 + 以 `message` 表为准。
3. **长任务的可中断性** —— 跑 3 小时的任务，老板中途改需求怎么办？需要"优雅中断 + 上下文交接"。pi-durable 有 reset/handoff 原语，但语义要自己设计。

### 16.4 一句话总结

> **技术不是障碍。真正的障碍是三个：**
> ① 15x 的永续 token 成本（多 agent 天然贵，而员工 7×24 在岗）
> ② 「怎么知道员工真的干完了」的评估体系
> ③ 「组织架构到底是不是反模式」这个根本疑问
>
> **Phase 0 就是用来验证 ② 的。如果 ② 过不去，①②③ 都不用谈了。**

---

## 附录 A：完整表清单（34 张）

| 域 | 表 |
|---|---|
| 系统（3） | `company` `activity_log` `approval_request` |
| 组织（7） | `department` `project_group` `employee` `position` `assignment` `relationship` |
| 招聘（4） | `talent_listing` `evaluation` `interview` `employee_package` |
| 通信（5） | `conversation` `message` `inbox_item` `wake_quota` `guard_event` `employee_run` |
| 任务（5） | `task` `task_dependency` `artifact` `acceptance` |
| 预算（4） | `budget` `budget_ledger` `budget_reservation` `budget_alert` |
| 记忆（3） | `employee_memory` `org_fact` `consolidation_run` |
| 视图（2） | `v_employee_context` `v_budget_status` |

## 附录 B：存储布局

```
<userData>/
├── company.db                        # 业务库（~35 表 + 视图）
├── agents/
│   ├── <employeeId-1>.sqlite         # pi-durable 运行时
│   └── <employeeId-N>.sqlite
├── workspace/
│   ├── <employeeId>/                 # 员工私人目录
│   ├── departments/<deptId>/         # 部门共享
│   └── projects/<projId>/            # 项目共享
├── artifacts/                        # 交付物
├── archive/
│   ├── conversations/YYYY-MM/*.jsonl
│   └── employees/*.jsonl
├── backups/
│   ├── auto/YYYY-MM-DD/
│   └── manual/
└── logs/
```

---

*方案设计 v1.0 · 2026-10 · 基于 pi / pi-durable / pi-chat 实际源码调研*
*配套文档：`AI员工平台-完整方案设计-v1.0.md`（本文）、`技术选型确认-v0.2-桌面本地版.md`*



