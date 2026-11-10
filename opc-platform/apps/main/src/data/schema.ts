/**
 * company.db schema (design doc §4), restricted to what the app actually writes.
 *
 * Two deliberate departures from the doc, both recorded here so they are visible
 * rather than accidental:
 *
 * - `conversation` / `message` store the projected object as JSON `payload` plus
 *   the few columns that queries filter on. The transcript is immutable and always
 *   read as a whole (§7: `message` is the single source of truth for the
 *   conversation), so a per-field schema would buy nothing but migrations.
 * - `employee.department_id` duplicates `position.department_id`. It exists because
 *   the org chart reads it in one query; `position` remains the authority for a
 *   person's department and reporting line (§4.3).
 *
 * Everything is additive-only: `SCHEMA_VERSION` is bumped and a step is appended to
 * `MIGRATIONS`, so an existing company.db is upgraded in place instead of reset.
 */

export const SCHEMA_VERSION = 57;

/** v1.0 is one company per installation (§1.3); its row is seeded on first open. */
export const COMPANY_ID = 'company-local';

/**
 * 这个工作台里唯一的那个人。
 *
 * `'boss'` 曾经是一个散落在 `employment_event.actor`、`evaluation.reviewer`、
 * `acceptance.reviewer` 与消息 senderId 里的魔法字符串。现在它是 `app_user` 那一行的
 * 主键，所以"这是谁做的"能解析成一张有名字和头像的脸，而不是一个字面量。
 *
 * 这个 id 一直是稳定字面值：它已经写进验收记录里了。V33 把它从 `boss` 改成 `user`
 * 时，把历史记录一起改了——因为改的是称呼，不是历史事实。
 */
export const USER_ID = 'user';

const V1 = String.raw`
-- ── 系统 ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS company (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  industry    TEXT,
  -- settings JSON: heartbeatMinutes / defaultDailyWakeQuota / maxTaskDepth / ...
  settings    TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Model providers and app preferences: infrastructure, not business data.
CREATE TABLE IF NOT EXISTS app_setting (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS model_provider (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  base_url    TEXT NOT NULL DEFAULT '',
  api         TEXT NOT NULL DEFAULT 'openai-completions',
  is_custom   INTEGER NOT NULL DEFAULT 0,
  -- ModelOption[] as JSON: the list is never queried, only read whole.
  models      TEXT NOT NULL DEFAULT '[]',
  -- Encrypted at rest (see models/keyCipher.ts); never the plaintext key.
  credential  BLOB,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- ── 组织 ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS department (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL DEFAULT 'company-local',
  name              TEXT NOT NULL,
  code              TEXT NOT NULL DEFAULT '',
  description       TEXT NOT NULL DEFAULT '',
  color             TEXT NOT NULL,
  -- Deprecated since v11: the head is position.is_head (§4.3). Kept nullable and
  -- unread for one release so a rollback still renders; OrgService never writes it.
  head_employee_id  TEXT,
  -- The parent is a department, not a free-form label: a dangling id would hide a
  -- whole subtree from the chart with no error anywhere.
  parent_id         TEXT,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  deleted_at        INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  FOREIGN KEY (parent_id) REFERENCES department(id)
);
CREATE INDEX IF NOT EXISTS idx_dept_company ON department(company_id, deleted_at);

CREATE TABLE IF NOT EXISTS employee (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL DEFAULT 'company-local',
  name          TEXT NOT NULL,
  -- Job family ("全栈工程师") and level ("P5") are shown, not enforced: the paid
  -- model is the real salary grade (§8.4).
  role          TEXT NOT NULL,
  level         TEXT NOT NULL DEFAULT 'P5',
  department_id TEXT,
  model         TEXT NOT NULL DEFAULT '',
  skills        TEXT NOT NULL DEFAULT '[]',
  -- Charter injected into the agent's system prompt; ≤300 tokens by convention.
  persona       TEXT NOT NULL DEFAULT '',
  -- Data URL of the uploaded portrait. '' means initials.
  avatar        TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('market','active','paused','terminated')),
  hired_at      INTEGER,
  terminated_at INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  FOREIGN KEY (department_id) REFERENCES department(id)
);
CREATE INDEX IF NOT EXISTS idx_emp_company_status ON employee(company_id, status);

-- Where someone sits and to whom they report. One live row per employee: a second
-- job would need its own table, because readMembers joins this one 1:1.
CREATE TABLE IF NOT EXISTS position (
  id                      TEXT PRIMARY KEY,
  employee_id             TEXT NOT NULL,
  department_id           TEXT NOT NULL,
  title                   TEXT NOT NULL,
  reports_to_employee_id  TEXT,
  is_head                 INTEGER NOT NULL DEFAULT 0,
  deleted_at              INTEGER,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  FOREIGN KEY (employee_id) REFERENCES employee(id),
  FOREIGN KEY (department_id) REFERENCES department(id),
  -- A reporting line is an edge to an employee, not a free-form string: it decides
  -- who may decompose tasks (subordinatesOf), so a dangling id is a permission bug.
  FOREIGN KEY (reports_to_employee_id) REFERENCES employee(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_employee ON position(employee_id)
  WHERE deleted_at IS NULL;
-- One head per department, enforced rather than agreed: headEmployeeId is derived
-- from this flag and the org chart tolerates exactly one badge per department.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_head ON position(department_id)
  WHERE is_head = 1 AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pos_dept ON position(department_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_pos_reports_to ON position(reports_to_employee_id)
  WHERE reports_to_employee_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS project_group (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL DEFAULT 'company-local',
  name          TEXT NOT NULL,
  code          TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  department_id TEXT,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('planning','active','paused','done','archived')),
  deleted_at    INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proj_status ON project_group(status, deleted_at);

-- Matrix membership: a person's department role and project role are different things.
CREATE TABLE IF NOT EXISTS assignment (
  id               TEXT PRIMARY KEY,
  employee_id      TEXT NOT NULL,
  project_group_id TEXT NOT NULL,
  role             TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','paused','removed')),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  FOREIGN KEY (employee_id) REFERENCES employee(id),
  FOREIGN KEY (project_group_id) REFERENCES project_group(id)
);
CREATE INDEX IF NOT EXISTS idx_assign_emp_status ON assignment(employee_id, status);
CREATE INDEX IF NOT EXISTS idx_assign_proj_status ON assignment(project_group_id, status);

-- ── 任务 ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS task (
  id                  TEXT PRIMARY KEY,
  title               TEXT NOT NULL,
  brief               TEXT NOT NULL DEFAULT '',
  -- What must exist when the task is done, in plain language (§9.3).
  deliverable_spec    TEXT NOT NULL DEFAULT '',
  contract_json       TEXT,
  -- 谁来干：一个执行体。§2.2 之后任务属于 worker，不属于某个人。
  owner_id            TEXT NOT NULL,
  -- Denormalised on purpose: a task card must still render after its worker is
  -- retired and gone from the table.
  owner_name          TEXT NOT NULL DEFAULT '',
  parent_task_id      TEXT,
  -- Set when this task *is* the manager's sign-off of another task.
  review_of_task_id   TEXT,
  is_review           INTEGER NOT NULL DEFAULT 0,
  depth               INTEGER NOT NULL DEFAULT 0,
  est_tokens          INTEGER NOT NULL DEFAULT 0,
  -- argv JSON, never a shell string.
  acceptance_command  TEXT NOT NULL DEFAULT '[]',
  acceptance_template TEXT NOT NULL DEFAULT 'http-ok'
                      CHECK (acceptance_template IN ('http-ok','node-test','image-200','review-verdict')),
  status              TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','running','review','accepted','delivered',
                                        'rejected','failed','cancelled')),
  workspace_rel_path  TEXT NOT NULL,
  -- pi-durable task id: the crash-recovery handle (§2.4 step 3c).
  durable_task_id     TEXT,
  attempts            INTEGER NOT NULL DEFAULT 0,
  tokens_used         INTEGER NOT NULL DEFAULT 0,
  cost_usd            REAL NOT NULL DEFAULT 0,
  error               TEXT,
  answer              TEXT,
  started_at          INTEGER,
  finished_at         INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  FOREIGN KEY (parent_task_id) REFERENCES task(id),
  FOREIGN KEY (review_of_task_id) REFERENCES task(id)
);
CREATE INDEX IF NOT EXISTS idx_task_owner ON task(owner_id, status);
CREATE INDEX IF NOT EXISTS idx_task_status ON task(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_task_parent ON task(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_task_review_of ON task(review_of_task_id);

-- The audit trail of one task, shown verbatim in the task card.
CREATE TABLE IF NOT EXISTS task_step (
  id      TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  at      INTEGER NOT NULL,
  text    TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES task(id)
);
CREATE INDEX IF NOT EXISTS idx_step_task ON task_step(task_id, at);

CREATE TABLE IF NOT EXISTS artifact (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  rel_path    TEXT NOT NULL,
  bytes       INTEGER NOT NULL DEFAULT 0,
  sha256      TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES task(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_task_path ON artifact(task_id, rel_path);

-- Every acceptance attempt is kept: rework needs the history, not just the last verdict.
CREATE TABLE IF NOT EXISTS acceptance (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  verdict     TEXT NOT NULL CHECK (verdict IN ('pass','fail')),
  reason      TEXT NOT NULL DEFAULT '',
  evidence    TEXT NOT NULL DEFAULT '{}',
  -- auto = the system checker, manager = the reporting line, boss = the owner.
  reviewer    TEXT NOT NULL DEFAULT 'auto' CHECK (reviewer IN ('auto','manager','boss')),
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES task(id)
);
CREATE INDEX IF NOT EXISTS idx_acceptance_task ON acceptance(task_id, created_at);

-- ── 预算 ────────────────────────────────────────────────────────────────
-- One row per (scope, scope_id, period). project/department are accepted by the
-- schema but not yet written — the double axis lands without a migration (§8.1).
CREATE TABLE IF NOT EXISTS budget (
  id              TEXT PRIMARY KEY,
  scope           TEXT NOT NULL CHECK (scope IN ('company','employee','project','department')),
  scope_id        TEXT NOT NULL,
  period_key      TEXT NOT NULL,
  limit_tokens    INTEGER NOT NULL,
  used_tokens     INTEGER NOT NULL DEFAULT 0,
  reserved_tokens INTEGER NOT NULL DEFAULT 0,
  warn_at         REAL NOT NULL DEFAULT 0.8,
  hard_stop_at    REAL NOT NULL DEFAULT 1.0,
  is_stopped      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_scope ON budget(scope, scope_id, period_key);

CREATE TABLE IF NOT EXISTS budget_reservation (
  id          TEXT PRIMARY KEY,
  budget_id   TEXT NOT NULL,
  task_id     TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  tokens      INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (budget_id) REFERENCES budget(id)
);
CREATE INDEX IF NOT EXISTS idx_reservation_task ON budget_reservation(task_id);
CREATE INDEX IF NOT EXISTS idx_reservation_expiry ON budget_reservation(expires_at);

-- Append-only money trail: used_tokens/reserved_tokens on budget are the running totals; this
-- is how they got there (§8.1).
CREATE TABLE IF NOT EXISTS budget_ledger (
  id          TEXT PRIMARY KEY,
  budget_id   TEXT NOT NULL,
  scope       TEXT NOT NULL,
  scope_id    TEXT NOT NULL,
  task_id     TEXT,
  employee_id TEXT,
  tokens      INTEGER NOT NULL DEFAULT 0,
  cost_usd    REAL NOT NULL DEFAULT 0,
  kind        TEXT NOT NULL CHECK (kind IN ('reserve','settle','release')),
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_budget ON budget_ledger(budget_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_task ON budget_ledger(task_id);

-- ── 记忆 ────────────────────────────────────────────────────────────────
-- Personal memory. scope_type/scope_id are what make project isolation a
-- filter instead of a rewrite (§6.2, R5).
CREATE TABLE IF NOT EXISTS employee_memory (
  id               TEXT PRIMARY KEY,
  -- 记忆的归属：现在是一个执行体（换执行体仍然能读到自己那条线的经验）。
  owner_id         TEXT NOT NULL,
  kind             TEXT NOT NULL,
  content          TEXT NOT NULL,
  scope_type       TEXT NOT NULL CHECK (scope_type IN ('personal','org','department','project','thread')),
  scope_id         TEXT,
  -- float32 blob; NULL when no embedding provider is configured (lexical ranking).
  embedding        BLOB,
  embedding_model  TEXT,
  source_type      TEXT NOT NULL CHECK (source_type IN ('task','conversation','consolidation','manual')),
  source_id        TEXT,
  valid_from       INTEGER NOT NULL,
  -- Contradicted memories are closed, never deleted: history is auditable.
  valid_until      INTEGER,
  strength         REAL NOT NULL DEFAULT 1.0,
  recall_count     INTEGER NOT NULL DEFAULT 0,
  last_recalled_at INTEGER,
  is_archived      INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_scope ON employee_memory(owner_id, scope_type, scope_id);
CREATE INDEX IF NOT EXISTS idx_memory_thread ON employee_memory(scope_type, scope_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_recent ON employee_memory(owner_id, created_at DESC);

-- Shared facts (org / department / project). Not personal: everyone scoped to the
-- same project sees the same rows.
CREATE TABLE IF NOT EXISTS org_fact (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL,
  scope_type   TEXT NOT NULL CHECK (scope_type IN ('org','department','project','thread')),
  scope_id     TEXT NOT NULL DEFAULT '',
  subject      TEXT NOT NULL,
  predicate    TEXT NOT NULL,
  object       TEXT NOT NULL DEFAULT '',
  statement    TEXT NOT NULL,
  source_type  TEXT NOT NULL,
  source_id    TEXT,
  valid_from   INTEGER NOT NULL,
  valid_until  INTEGER,
  confidence   REAL NOT NULL DEFAULT 1.0,
  is_archived  INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fact_scope ON org_fact(company_id, scope_type, scope_id, valid_from DESC);

-- ── 招聘 ────────────────────────────────────────────────────────────────
-- Imported agent packages that are not employees yet (§4.4). The rest of the
-- recruitment domain arrives later by migration: evaluation in v15, interview
-- and employee_package in v16.
CREATE TABLE IF NOT EXISTS agent_candidate (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL,
  level       TEXT NOT NULL DEFAULT 'P5',
  model       TEXT NOT NULL DEFAULT '',
  skills      TEXT NOT NULL DEFAULT '[]',
  persona     TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_candidate_created ON agent_candidate(created_at DESC);

-- ── 通信 ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversation (
  id               TEXT PRIMARY KEY,
  -- Conversation without its messages: they live in their own immutable rows.
  payload          TEXT NOT NULL,
  archived_at      INTEGER,
  consolidated_at  INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversation(archived_at, consolidated_at, updated_at);

CREATE TABLE IF NOT EXISTS message (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  payload         TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversation(id)
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON message(conversation_id, created_at);
`;

/**
 * v2 — 通信与唤醒（§7, F5/F6）.
 *
 * Four tables, because "员工有自己的节奏" (P5) needs durable answers to four
 * questions: what is waiting for me, may I wake someone, what did I already have
 * to refuse, and who have I been talking to.
 *
 * `relationship` carries a per-pair rate window (`window_started_at`/`window_count`)
 * so "A→B < 10 条/小时" is one row read instead of a scan over message payloads.
 */
const V2 = String.raw`
CREATE TABLE IF NOT EXISTS inbox_item (
  id              TEXT PRIMARY KEY,
  employee_id     TEXT NOT NULL,
  source_type     TEXT NOT NULL CHECK (source_type IN ('message','task','approval','system')),
  source_id       TEXT NOT NULL,
  conversation_id TEXT,
  -- 0=老板指令 1=上级派活/向上汇报 2=平级求助 3=闲聊
  priority        INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','done','dropped')),
  -- Bypasses the heartbeat: the recipient is woken on the spot.
  requires_wake   INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  processed_at    INTEGER,
  FOREIGN KEY (employee_id) REFERENCES employee(id)
);
-- One source can only be queued once: a re-delivered message must not double-queue.
CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_uniq
  ON inbox_item(employee_id, source_type, source_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_inbox_emp ON inbox_item(employee_id, status, priority, created_at);

CREATE TABLE IF NOT EXISTS wake_quota (
  id            TEXT PRIMARY KEY,
  employee_id   TEXT NOT NULL,
  quota_date    TEXT NOT NULL,
  daily_limit   INTEGER NOT NULL,
  used_count    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (employee_id, quota_date)
);

-- Every refusal is recorded: suppression must stay visible to the boss (决定② C).
CREATE TABLE IF NOT EXISTS guard_event (
  id              TEXT PRIMARY KEY,
  employee_id     TEXT NOT NULL,
  kind            TEXT NOT NULL
                  CHECK (kind IN ('wake_quota','turn_limit','dm_rate','message_dropped')),
  detail          TEXT NOT NULL DEFAULT '{}',
  conversation_id TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_guard_emp ON guard_event(employee_id, created_at DESC);

CREATE TABLE IF NOT EXISTS relationship (
  id                  TEXT PRIMARY KEY,
  company_id          TEXT NOT NULL DEFAULT 'company-local',
  from_employee_id    TEXT NOT NULL,
  to_employee_id      TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('colleague','manager','report','collaborator')),
  -- 0..1: grows with interaction, decays with time (computed on read).
  strength            REAL NOT NULL DEFAULT 0.5,
  interaction_count   INTEGER NOT NULL DEFAULT 0,
  last_interaction_at INTEGER,
  window_started_at   INTEGER,
  window_count        INTEGER NOT NULL DEFAULT 0,
  note                TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rel_pair
  ON relationship(from_employee_id, to_employee_id, kind);
CREATE INDEX IF NOT EXISTS idx_rel_from ON relationship(from_employee_id, last_interaction_at DESC);
`;

/**
 * v3 — 老板处理护栏记录.
 *
 * `/notifications` lets the boss dismiss a guard once he has read it. Dismissal is a
 * timestamp, never a delete: "谁在什么时候被拦下过" stays auditable, and the page
 * only hides what has already been acknowledged.
 */
const V3 = String.raw`
ALTER TABLE guard_event ADD COLUMN dismissed_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_guard_open ON guard_event(employee_id, dismissed_at, created_at DESC);
`;

/**
 * Append-only migration steps. `MIGRATIONS[n - 1]` upgrades a database from
 * version `n - 1` to `n`; step 1 is the initial schema.
 */
/**
 * V4: `issue_key` — a stable human handle per task (ENG-12), so a row can be
 * referred to in chat, commits and issue lists without a UUID.
 */
const V4 = `
ALTER TABLE task ADD COLUMN issue_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_issue_key ON task(issue_key);
`;

/**
 * V5: issue metadata the boss actually prioritises with. Kept on `task` (not a new
 * table) because every task is an issue; `repairLegacyColumns` applies the ALTERs
 * idempotently for existing databases.
 */
const V5 = `
ALTER TABLE task ADD COLUMN priority TEXT NOT NULL DEFAULT 'P2';
ALTER TABLE task ADD COLUMN labels TEXT NOT NULL DEFAULT '[]';
ALTER TABLE task ADD COLUMN due_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_task_priority ON task(priority, status);
`;

/**
 * V6: links between work items. `blocks` is the one that changes behaviour (a task
 * with an unfinished blocker refuses to start); the other two are notes for humans.
 */
const V6 = `
CREATE TABLE IF NOT EXISTS task_link (
  id           TEXT PRIMARY KEY,
  from_task_id TEXT NOT NULL,
  to_task_id   TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'blocks',
  created_at   INTEGER NOT NULL,
  UNIQUE (from_task_id, to_task_id, type)
);
CREATE INDEX IF NOT EXISTS idx_link_from ON task_link(from_task_id);
CREATE INDEX IF NOT EXISTS idx_link_to ON task_link(to_task_id);
`;

/**
 * V7: a record per consolidation ("下班反思"). Without it the app can create memories
 * but cannot answer "how many runs, how many memories, how much did it cost".
 */
const V7 = `
CREATE TABLE IF NOT EXISTS consolidation_run (
  id                      TEXT PRIMARY KEY,
  employee_id             TEXT NOT NULL,
  source_conversation_ids TEXT NOT NULL DEFAULT '[]',
  episode_count           INTEGER NOT NULL DEFAULT 0,
  memories_created        INTEGER NOT NULL DEFAULT 0,
  memories_merged         INTEGER NOT NULL DEFAULT 0,
  memories_archived       INTEGER NOT NULL DEFAULT 0,
  tokens_used             INTEGER NOT NULL DEFAULT 0,
  status                  TEXT NOT NULL DEFAULT 'running',
  error                   TEXT,
  started_at              INTEGER NOT NULL,
  finished_at             INTEGER
);
CREATE INDEX IF NOT EXISTS idx_consol_emp ON consolidation_run(employee_id, started_at DESC);
`;

/**
 * V8: 预算双轴 + 告警 (§8.1 / §8.3).
 *
 * `budget` has allowed project/department scopes since v1 — nothing had written
 * them yet. What was missing is (a) the link from a task to the project it spends
 * on, and (b) a record of the thresholds it crossed: without a budget-alert table a
 * "warn" exists only as a colour in the UI, and the boss cannot answer "who blew
 * what, when".
 */
const V8 = `
ALTER TABLE task ADD COLUMN project_group_id TEXT;
CREATE INDEX IF NOT EXISTS idx_task_project ON task(project_group_id, status);
ALTER TABLE assignment ADD COLUMN pause_reason TEXT;
ALTER TABLE assignment ADD COLUMN paused_at INTEGER;
CREATE TABLE IF NOT EXISTS budget_alert (
  id           TEXT PRIMARY KEY,
  budget_id    TEXT NOT NULL,
  scope        TEXT NOT NULL,
  scope_id     TEXT NOT NULL,
  period_key   TEXT NOT NULL,
  level        TEXT NOT NULL CHECK (level IN ('warn','stop')),
  used_tokens  INTEGER NOT NULL,
  limit_tokens INTEGER NOT NULL,
  ratio        REAL NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_once ON budget_alert(budget_id, level, period_key);
CREATE INDEX IF NOT EXISTS idx_alert_recent ON budget_alert(created_at DESC);
`;

/**
 * V9: `task.acceptance_template` 的 CHECK 里加入 `node-test`（普通软件工作的闸门）。
 *
 * SQLite 改不了 CHECK：只能重建表。重建在 `repairAcceptanceTemplateConstraint()` 里做，
 * 它在迁移事务之外先跑（`PRAGMA foreign_keys` 在事务里无效），所以这一步本身没有 SQL，
 * 只把版本号往前推，表示"约束已经修复过"。
 */
const V9 = `
-- 见 repairAcceptanceTemplateConstraint()：重建 task 表以放宽 acceptance_template 约束。
`;

/**
 * V10: 自定义 provider 可复用某个内置 provider 的图标。
 *
 * 存 provider id（如 `openai`）而不是文件名：图标表只在渲染进程，主进程不该知道
 * `public/provider-icons` 的布局。NULL = 没有选，回退到首字母。
 */
const V10 = `
ALTER TABLE model_provider ADD COLUMN icon TEXT;
`;

/**
 * V11: 组织架构的三条不变式写进 schema，而不是只写在 `OrgService` 里。
 *
 * 1. **一人一岗**：`(employee_id) WHERE deleted_at IS NULL` 唯一。旧索引是
 *    `(employee_id, department_id)`，允许同一个人在两个部门各挂一条 live position；
 *    `readMembers` 的 LEFT JOIN 会因此把同一个人算两次。
 * 2. **一部门一负责人**：`is_head = 1` 的部分唯一索引。负责人此前有两个事实源
 *    （`department.head_employee_id` + `position.is_head`），且都维护不全；从这一版起
 *    只认 `position.is_head`，旧列停止读写。
 * 3. **汇报线是外键**：`reports_to_employee_id → employee(id)`。这一列决定谁能拿到
 *    拆解任务的工具（`subordinatesOf`），悬空 id 等于把权限发给一个不存在的人。
 *
 * SQLite 不能给已有表加外键，所以重建 `position`。重建前先修数据：同一员工只留
 * 一条 live position、同一部门只留一个 `is_head`、悬空/自指的汇报线置空。这样即使
 * 某个旧库已经违反了不变式，升级也能一次通过，而不是在 CREATE INDEX 时卡住。
 *
 * `department.head_employee_id` 不在这里删除：先停止读写、观察一个版本，回滚时旧
 * 代码仍能渲染负责人。它留下的陈旧值不会被任何读取路径使用。
 */
const V11 = `
-- ── 1. 修数据（必须在建索引/重建表之前）─────────────────────────────────
-- 悬空、指向已离职、或指向自己的汇报线一律置空。
UPDATE position
SET reports_to_employee_id = NULL,
    updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE reports_to_employee_id IS NOT NULL
  AND (
    reports_to_employee_id = employee_id
    OR NOT EXISTS (
      SELECT 1 FROM employee e
      WHERE e.id = position.reports_to_employee_id AND e.status = 'active'
    )
  );

-- 一人多岗：优先保留负责人那条，其次保留最新的一条，其余软删除。
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY employee_id
    ORDER BY is_head DESC, created_at DESC, id DESC
  ) AS rn
  FROM position
  WHERE deleted_at IS NULL
)
UPDATE position
SET deleted_at = CAST(strftime('%s','now') AS INTEGER) * 1000,
    is_head = 0,
    updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- 一部门多负责人：优先保留旧列 head_employee_id 指向的人，其次最新的一条。
WITH ranked AS (
  SELECT p.id, ROW_NUMBER() OVER (
    PARTITION BY p.department_id
    ORDER BY (
      p.employee_id = COALESCE(
        (SELECT d.head_employee_id FROM department d WHERE d.id = p.department_id), ''
      )
    ) DESC, p.created_at DESC, p.id DESC
  ) AS rn
  FROM position p
  WHERE p.is_head = 1 AND p.deleted_at IS NULL
)
UPDATE position
SET is_head = 0, updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- 旧列里记着负责人、但 is_head 没标上的，补上：升级过程不能丢负责人。
UPDATE position
SET is_head = 1, updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE deleted_at IS NULL
  AND EXISTS (
    SELECT 1 FROM department d
    WHERE d.id = position.department_id
      AND d.head_employee_id = position.employee_id
      AND d.deleted_at IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM position p2
    WHERE p2.department_id = position.department_id
      AND p2.is_head = 1 AND p2.deleted_at IS NULL
  );

-- ── 2. 重建 position：加上 reports_to 外键 ──────────────────────────────
DROP INDEX IF EXISTS idx_pos_emp_dept;
DROP INDEX IF EXISTS idx_pos_dept;
DROP TABLE IF EXISTS position_rebuild;

CREATE TABLE position_rebuild (
  id                      TEXT PRIMARY KEY,
  employee_id             TEXT NOT NULL,
  department_id           TEXT NOT NULL,
  title                   TEXT NOT NULL,
  reports_to_employee_id  TEXT,
  is_head                 INTEGER NOT NULL DEFAULT 0,
  deleted_at              INTEGER,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  FOREIGN KEY (employee_id) REFERENCES employee(id),
  FOREIGN KEY (department_id) REFERENCES department(id),
  FOREIGN KEY (reports_to_employee_id) REFERENCES employee(id)
);

INSERT INTO position_rebuild
  (id, employee_id, department_id, title, reports_to_employee_id, is_head, deleted_at, created_at, updated_at)
SELECT id, employee_id, department_id, title, reports_to_employee_id, is_head, deleted_at, created_at, updated_at
FROM position;

DROP TABLE position;
ALTER TABLE position_rebuild RENAME TO position;

-- ── 3. 新不变式 ─────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_employee ON position(employee_id)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_head ON position(department_id)
  WHERE is_head = 1 AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pos_dept ON position(department_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_pos_reports_to ON position(reports_to_employee_id)
  WHERE reports_to_employee_id IS NOT NULL;
`;

/**
 * V12: 人事档案补上「时间」与「唯一性」。
 *
 * 三件事，都是把应用层曾经"口头约定"的东西落到库里：
 *
 * 1. **部门名/代号唯一**。`createDepartment` 一直是先 SELECT 再 INSERT，并发、导入
 *    公司模板、多窗口都能写出重名部门；重名会让组织图目录出现两行一模一样的条目，
 *    而 `department_id` 又无法反查是哪一行。旧库里可能已经有重复，先改名再加索引，
 *    否则 `CREATE UNIQUE INDEX` 会直接让升级失败。
 * 2. **离职时间**。`employee.terminated_at` 从 v1 就在，但没有任何写入路径，导致
 *    "他什么时候走的"永远无解。旧库里已离职的行用最后一次岗位变动时间补齐。
 * 3. **离职不再占部门**。`employee.department_id` 是 `position` 的冗余列（见文件头
 *    注释），离职时 position 软删了，这一列却还指着原部门。v11 起唯一权威是
 *    `position`，这里把陈旧值清掉，免得下一个读它的地方被误导。
 */
const V12 = `
-- ── 1. 旧数据去重（必须在建唯一索引之前）────────────────────────────────
-- 重名部门：保留最早创建的那条，其余加 id 后缀，宁可名字难看也不能让升级失败。
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY company_id, LOWER(TRIM(name))
    ORDER BY created_at, id
  ) AS rn
  FROM department
  WHERE deleted_at IS NULL
)
UPDATE department
SET name = name || ' · ' || substr(id, -4),
    updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- 重复代号同理；空代号不参与唯一性，多家部门都可以没有代号。
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY company_id, UPPER(TRIM(code))
    ORDER BY created_at, id
  ) AS rn
  FROM department
  WHERE deleted_at IS NULL AND TRIM(code) <> ''
)
UPDATE department
SET code = code || '-' || substr(id, -4),
    updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- ── 2. 唯一性写进索引 ───────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS idx_dept_name
  ON department(company_id, LOWER(TRIM(name))) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_dept_code
  ON department(company_id, UPPER(TRIM(code)))
  WHERE deleted_at IS NULL AND TRIM(code) <> '';

-- ── 3. 补离职时间 ──────────────────────────────────────────────────────
UPDATE employee
SET terminated_at = COALESCE(
      (SELECT MAX(p.deleted_at) FROM position p WHERE p.employee_id = employee.id),
      updated_at
    )
WHERE status = 'terminated' AND terminated_at IS NULL;

-- ── 4. 离职的人不再挂在部门上 ───────────────────────────────────────────
UPDATE employee
SET department_id = NULL
WHERE status = 'terminated' AND department_id IS NOT NULL;
`;

/**
 * V13: 部门层级真正生效。
 *
 * `department.parent_id` 从 v1 就声明了，但没有外键、没有索引、没有任何读写路径 ——
 * 组织图因此只能是一层"老板 → 部门 → 人"的扁平面条。这一版把它变成事实：
 *
 * 1. **parent_id 是外键**（自引用）。悬空 id 会让整棵子树从图上消失，且没有任何报错；
 *    SQLite 不能给已有表加外键，所以重建 `department` —— 那一步在
 *    `repairDepartmentParentConstraint()` 里做（`PRAGMA foreign_keys` 在事务里无效），
 *    这里只负责建索引，和 V9 是同一套做法。
 * 2. **按 sort_order 排序**。列从 v1 就在，但排序一直靠 `created_at`；有了层级之后
 *    "同级之间谁在前"必须能拖，否则新增部门永远排在最后。
 *
 * 迁移前先修数据：指向自己/已删除/不存在的 parent 置空，成环的边断开 —— 否则重建时
 * 外键会拒绝，整个升级回滚。
 */
const V13 = `
CREATE INDEX IF NOT EXISTS idx_dept_parent ON department(parent_id)
  WHERE parent_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_dept_sort ON department(deleted_at, parent_id, sort_order);
`;

/**
 * V14: 职位目录 + 编制 + 人事事件。
 *
 * 前两批补的是"人在哪、归谁管、层级怎么画"。这一批补的是真实 HR 里最常被问的三件事：
 *
 * 1. **这个部门有几个坑（job / headcount）**。`position.title` 一直是自由文本，谁都能
 *    叫自己"高级工程师"，也没有任何上限 —— 设计文档 §9.2 把"组织架构无限膨胀"列为三大
 *    风险之一，而库里连一个能拒绝第 11 次招聘的数字都没有。`job` 是部门里的职位目录，
 *    `headcount` 是编制上限；`position.job_id` 把人钉在某个坑上，`hire` 时校验。
 * 2. **他什么时候、为什么变了（employment_event）**。`position` 的软删只能倒推出"换过
 *    部门"，推不出"哪天换的、谁决定的、为什么"。人事事件是追加写的时间线：入职 / 调岗 /
 *    晋升 / 任命负责人 / 免去负责人 / 离职 / 复职。
 * 3. **职级能升（promote）**。`employee.level` 只展示不校验，也从来没有写入路径，所以
 *    `promoted` 事件此前无处可来。
 *
 * `position.job_id` 故意不加外键：SQLite 不能给已有表加外键，而为一个可空的分组字段再重建
 * 一次 `position` 不划算。`OrgService` 在写入时校验"职位存在、属于同一部门、未撤销"，
 * 撤销职位是软删，所以历史岗位仍能解释清楚自己当初占的是哪个坑。
 */
const V14 = `
CREATE TABLE IF NOT EXISTS job (
  id            TEXT PRIMARY KEY,
  department_id TEXT NOT NULL,
  title         TEXT NOT NULL,
  level         TEXT NOT NULL DEFAULT 'P5',
  -- 编制上限：0 表示"这个坑先占住但暂不招人"。
  headcount     INTEGER NOT NULL DEFAULT 1 CHECK (headcount >= 0),
  description   TEXT NOT NULL DEFAULT '',
  deleted_at    INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  FOREIGN KEY (department_id) REFERENCES department(id)
);
-- 一个部门里同名职位只能有一个：两个"前端工程师"编制会让"还剩几个坑"无法回答。
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_dept_title
  ON job(department_id, LOWER(TRIM(title))) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_job_dept ON job(department_id, deleted_at);

ALTER TABLE position ADD COLUMN job_id TEXT;
CREATE INDEX IF NOT EXISTS idx_pos_job ON position(job_id) WHERE job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS employment_event (
  id                 TEXT PRIMARY KEY,
  employee_id        TEXT NOT NULL,
  kind               TEXT NOT NULL
                     CHECK (kind IN ('hired','transferred','promoted','head_appointed',
                                     'head_removed','terminated','reinstated','confirmed')),
  -- 调岗/复职是"从哪到哪"，晋升是"从什么到什么"，所以前后各存一份。
  from_department_id TEXT,
  to_department_id   TEXT,
  from_title         TEXT,
  to_title           TEXT,
  from_level         TEXT,
  to_level           TEXT,
  -- 'boss' 或员工 id：谁做的决定。
  actor              TEXT NOT NULL DEFAULT 'boss',
  reason             TEXT NOT NULL DEFAULT '',
  at                 INTEGER NOT NULL,
  created_at         INTEGER NOT NULL,
  FOREIGN KEY (employee_id) REFERENCES employee(id)
);
CREATE INDEX IF NOT EXISTS idx_event_employee ON employment_event(employee_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_event_recent ON employment_event(at DESC);
`;

/**
 * V15: 绩效、试用期、项目内汇报、代理负责人。
 *
 * 第三批给了"编制"和"事件"，但没有回答三件真实 HR 每天在做的事：
 *
 * 1. **这个人干得怎么样（evaluation）**。`promoted` 事件此前没有任何依据：升谁、为什么升，
 *    全凭老板记忆。绩效是独立事实（有周期、有维度、有评语），所以它是一张表而不是一个字段。
 * 2. **试用期什么时候到期、有没有转正（probation_ends_at + confirmed）**。招聘时说好"试用
 *    三个月"，但库里只有 `hired_at`，没有到期日，也没有"转正"这个动作 —— 于是所有员工永远
 *    停在"新来的"。转正是一条人事事件，和晋升一样可追溯。
 * 3. **项目里的汇报线（assignment.reports_to_employee_id）**。设计文档 §4.3 有这一列，
 *    实现时被砍掉了，于是矩阵组织只剩"部门里归谁管"：一个项目里谁向谁交活，无数据可查。
 * 4. **代理负责人（position.is_acting_head）**。负责人空缺时总得有人顶上，但 `is_head` 是
 *    唯一且代表正式任命，不能拿它凑数 —— 否则"代理"和"正式"就再也分不开了。
 */
const V15 = `
CREATE TABLE IF NOT EXISTS evaluation (
  id            TEXT PRIMARY KEY,
  employee_id   TEXT NOT NULL,
  -- probation 转正评审 / periodic 周期性 / project 项目复盘 / exit 离职面谈
  kind          TEXT NOT NULL DEFAULT 'periodic'
                CHECK (kind IN ('probation','periodic','project','exit')),
  -- 周期标识，如 '2026-Q3' / 'probation-2026-11'；空表示一次性评价。
  period_key    TEXT NOT NULL DEFAULT '',
  score_overall REAL NOT NULL CHECK (score_overall BETWEEN 1 AND 5),
  score_quality REAL CHECK (score_quality IS NULL OR score_quality BETWEEN 1 AND 5),
  score_speed   REAL CHECK (score_speed IS NULL OR score_speed BETWEEN 1 AND 5),
  score_cost    REAL CHECK (score_cost IS NULL OR score_cost BETWEEN 1 AND 5),
  summary       TEXT NOT NULL DEFAULT '',
  -- 'boss' 或员工 id：谁评的。
  reviewer      TEXT NOT NULL DEFAULT 'boss',
  at            INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (employee_id) REFERENCES employee(id)
);
CREATE INDEX IF NOT EXISTS idx_eval_emp ON evaluation(employee_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_eval_period ON evaluation(employee_id, kind, period_key);

-- 试用期到期日；NULL = 无试用期（老数据、或明确按正式员工入职）。
ALTER TABLE employee ADD COLUMN probation_ends_at INTEGER;

-- 项目内汇报：可不同于部门汇报线（矩阵组织）。
ALTER TABLE assignment ADD COLUMN reports_to_employee_id TEXT;

-- 代理负责人：与正式负责人（is_head）并存，但一个部门只有一个。
ALTER TABLE position ADD COLUMN is_acting_head INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_acting_head
  ON position(department_id) WHERE is_acting_head = 1 AND deleted_at IS NULL;
`;

/**
 * V16: 招聘链路补完 —— 试跑面试 + 员工包。
 *
 * `agent_candidate` 从 v1 起就只是一个"导入→聘用"的暂存表，`schema.ts` 的注释一直写着
 * "evaluation / interview / employee_package are Phase 4"。绩效（evaluation）在 v15 补上了，
 * 这一版补剩下两个：
 *
 * 1. **interview（试跑）**。招聘最大的风险是"看简历很合适，上手就废"。所以面试不是聊天，
 *    而是**用一个真实任务跑一遍**，记下产出、token 成本与耗时 —— 设计文档 §8 把成本当薪酬，
 *    那么"这个人干这活要花多少钱"就是录用决策的一部分，而不是录用后才知道的事。
 *
 *    `candidate_id` 用 `ON DELETE SET NULL` 并另存姓名/岗位快照：聘用成功时候选人行会被删掉
 *    （`market.remove`），而面试记录必须留下来解释"当初为什么招他"。
 * 2. **employee_package（员工包）**。导出的 manifest 与 `parseAgentPackage` 读的是同一个
 *    格式（`opc-agent-package@1`），所以导出的包可以被"导入本地 Agent 包"直接读回来 ——
 *    这是"人可以被带走、被复制到另一家公司"的前提，也让员工包有了可校验的哈希与体积。
 *
 * 两张表都是追加写：面试记录不删，导出记录不删（谁在什么时候导出了谁，本身是敏感信息）。
 */
const V16 = `
CREATE TABLE IF NOT EXISTS interview (
  id             TEXT PRIMARY KEY,
  -- 聘用后候选人行会被删除，所以外键是 SET NULL；姓名/岗位另有快照。
  candidate_id   TEXT,
  candidate_name TEXT NOT NULL,
  candidate_role TEXT NOT NULL DEFAULT '',
  task_prompt    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','running','done','failed','cancelled')),
  -- 老板的决定；NULL = 还没决定。
  decision       TEXT CHECK (decision IN ('hire','reject')),
  result         TEXT NOT NULL DEFAULT '',
  error          TEXT,
  tokens_used    INTEGER NOT NULL DEFAULT 0,
  cost_usd       REAL NOT NULL DEFAULT 0,
  duration_ms    INTEGER,
  created_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  FOREIGN KEY (candidate_id) REFERENCES agent_candidate(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_interview_candidate ON interview(candidate_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_interview_recent ON interview(created_at DESC);

CREATE TABLE IF NOT EXISTS employee_package (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('employee','team','company')),
  name        TEXT NOT NULL,
  version     TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  -- 导出到磁盘的实际位置，以及可校验的指纹：包会被复制、转发，内容必须能自证。
  file_path   TEXT NOT NULL,
  file_hash   TEXT NOT NULL,
  file_size   INTEGER NOT NULL,
  -- 包的清单（JSON）：包含谁、来自哪个部门/职位，供列表与再导入使用。
  manifest    TEXT NOT NULL DEFAULT '{}',
  license     TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_package_recent ON employee_package(created_at DESC);
`;

/**
 * V17: `relationship` 只记"互动"，不再记"关系"。
 *
 * 这是我在梳理时点出的那处重复事实源，现在把它收敛掉：
 *
 * `relationship.kind` 存的是 `colleague` / `manager` / `report` / `collaborator`，而"谁是谁的
 * 上级"的唯一权威是 `position.reports_to_employee_id`。问题是 kind 只在**第一次互动时**算一次
 * 并落库，于是：
 *
 * 1. 组织调整后，旧行永远停在 `manager` —— 一个人换了上级，关系图还在说旧上级是他 manager；
 * 2. 更糟的是唯一键是 `(from, to, kind)`：换了上级再聊一次会**插入第二行**，同一个方向的两条边
 *    同时存在；而 `sendsInWindow` 按 `(from, to)` 只 `.get()` 一行，限流因此读到随机那条的
 *    窗口计数 —— 限流可以被绕过。
 *
 * 所以这一版把 `kind` 从表里去掉：`relationship` 只回答"这两个人聊了多少、多熟、上次什么时候"，
 * "是什么关系"由 `position` 现算（`CommService.relationships()`）。旧库里同一方向的多行会合并成
 * 一行：互动次数求和、强度取最大、窗口取最新的那条。
 */
const V17 = `
DROP INDEX IF EXISTS idx_rel_pair;
DROP INDEX IF EXISTS idx_rel_from;
DROP TABLE IF EXISTS relationship_rebuild;

CREATE TABLE relationship_rebuild (
  id                  TEXT PRIMARY KEY,
  company_id          TEXT NOT NULL DEFAULT 'company-local',
  from_employee_id    TEXT NOT NULL,
  to_employee_id      TEXT NOT NULL,
  -- 0..1: grows with interaction, decays with time (computed on read).
  strength            REAL NOT NULL DEFAULT 0.5,
  interaction_count   INTEGER NOT NULL DEFAULT 0,
  last_interaction_at INTEGER,
  window_started_at   INTEGER,
  window_count        INTEGER NOT NULL DEFAULT 0,
  note                TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

-- 合并同一方向的重复边：次数求和、强度取最大、窗口取最近一次开始的那行。
INSERT INTO relationship_rebuild
  (id, company_id, from_employee_id, to_employee_id, strength, interaction_count,
   last_interaction_at, window_started_at, window_count, note, created_at, updated_at)
SELECT MIN(id), company_id, from_employee_id, to_employee_id,
       MAX(strength), SUM(interaction_count),
       MAX(last_interaction_at), MAX(window_started_at),
       (SELECT r2.window_count FROM relationship r2
         WHERE r2.from_employee_id = relationship.from_employee_id
           AND r2.to_employee_id = relationship.to_employee_id
         ORDER BY COALESCE(r2.window_started_at, 0) DESC, r2.updated_at DESC
         LIMIT 1),
       MAX(note), MIN(created_at), MAX(updated_at)
  FROM relationship
 GROUP BY company_id, from_employee_id, to_employee_id;

DROP TABLE relationship;
ALTER TABLE relationship_rebuild RENAME TO relationship;

-- 一个方向只有一条边：限流与"上次聊到哪"都必须读同一行。
CREATE UNIQUE INDEX IF NOT EXISTS idx_rel_pair ON relationship(from_employee_id, to_employee_id);
CREATE INDEX IF NOT EXISTS idx_rel_from ON relationship(from_employee_id, last_interaction_at DESC);
CREATE INDEX IF NOT EXISTS idx_rel_to ON relationship(to_employee_id, last_interaction_at DESC);
`;

/**
 * V18: 公司里唯一的人类，变成一行真实数据。
 *
 * 到目前为止"老板"是散落在各处的字符串 `'boss'`：`employment_event.actor`、
 * `evaluation.reviewer`、`acceptance.reviewer`、消息的 senderId。它能用，但没人能回答
 * "这个人叫什么、长什么样"，而姓名与头像只能挤在 `app_setting` 的 `profile.bossName`
 * 里 —— 一张偏好设置表。
 *
 * 这一版把**一个人**变成 `app_user` 里的一行：
 *
 * - `CHECK (id = 'boss')` 是产品决定的直接编码 —— **一个公司只有一个人类**，不是"暂时
 *   只做了一个"。任何试图插入第二个人的语句都会被数据库拒绝，而不是靠代码自觉。
 * - 迁移时从现有的 `profile.bossName` / `profile.bossAvatar` 取值，所以升级后名字和头像
 *   不会丢；旧的两行**不删**（回滚一个版本仍能渲染），但 CompanyService 从此只读写新表。
 * - `'boss'` 这个 id 保持不变：它已经写进历史事件与验收记录里了，改 id 等于改写历史。
 */
const V18 = `
CREATE TABLE IF NOT EXISTS app_user (
  id         TEXT PRIMARY KEY CHECK (id = 'boss'),
  name       TEXT NOT NULL,
  avatar     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO app_user (id, name, avatar, created_at, updated_at)
VALUES (
  'boss',
  COALESCE(
    NULLIF(TRIM((SELECT value FROM app_setting WHERE key = 'profile.bossName')), ''),
    '老板'
  ),
  COALESCE((SELECT value FROM app_setting WHERE key = 'profile.bossAvatar'), ''),
  CAST(strftime('%s','now') AS INTEGER) * 1000,
  CAST(strftime('%s','now') AS INTEGER) * 1000
);
`;

/**
 * V19: 每个员工的模型与工具，从"档案上的一个字符串"变成真实配置。
 *
 * 之前 `employee.model` 只是展示字段，执行时永远走全局默认模型；`skills` 是档案标签，
 * 不影响 agent 能装什么工具。这一版把两者拆开：
 *
 * - `model_ref` 存结构化的 `{ providerId, modelId }`（JSON；空串 = 继承公司默认）。
 *   `model` 继续保留为人类可读快照，列表页不用为了显示模型名去连 models 服务。
 * - `tool_policy` 存 `ToolPolicy`（JSON，禁用名单）。默认空对象 = 当前运行环境
 *   能装什么就装什么，所以新扩展不会被老员工静默漏掉。
 *
 * 两张列都只追加、不改写历史：老员工升级后 `model_ref=''`，继续用全局默认，行为不变。
 */
const V19 = `
ALTER TABLE employee ADD COLUMN model_ref TEXT NOT NULL DEFAULT '';
ALTER TABLE employee ADD COLUMN tool_policy TEXT NOT NULL DEFAULT '{}';
`;

/**
 * V20: 岗位从"编制坑位"变成"可复用的岗位模板"。
 *
 * V14 建的 `job` 只能回答"这个部门有几个坑"，`description`（职责）写了也没人读：
 * 招聘向导不填，`hire` 不复制，提示词里那段"岗位职责"其实来自 `employee.persona`。
 * 于是同一个岗位的五个人，职责/技能/模型要各写五遍，改一次要改五处。
 *
 * 这一版把岗位补成模板，员工仍是它的实例：
 *
 * - `skills` 存 JSON 数组，和 `employee.skills` 同格式；招聘时**复制**过去，不是引用，
 *   所以改岗位不会悄悄改掉在岗员工（需要时由老板显式同步）。
 * - `model` / `model_ref` 与员工两列同义：`model` 是人类可读快照，`model_ref` 是执行时
 *   真正读的结构化选择；空串 = 不指定，继续继承公司默认。
 * - 职责仍用 V14 的 `description`，但从此是活数据：招聘带出、任务提示词里 `position`
 *   join `job` 现读（live join），所以改职责对下一个任务生效。
 */
const V20 = `
ALTER TABLE job ADD COLUMN skills TEXT NOT NULL DEFAULT '[]';
ALTER TABLE job ADD COLUMN model TEXT NOT NULL DEFAULT '';
ALTER TABLE job ADD COLUMN model_ref TEXT NOT NULL DEFAULT '';
`;

/**
 * V21: 岗位从"部门里的一个坑"变成**公司级职务**。
 *
 * V14 把 `job` 建成了"某部门的 N 个坑"（`department_id` + `headcount` 都在这一行）。
 * 但真实语义里，岗位是**职务**：测试工程师、产品经理、CFO —— 它属于公司，不属于某个
 * 部门。同一个"测试工程师"在工程部和质量部都是同一个职务，只是编制分别算。
 *
 * 这一版把两件事拆开：
 *
 * - `job` 变成全局目录：id / title / level / 职责 / 默认技能 / 默认模型。公司内同名职务
 *   只能有一行（`LOWER(TRIM(title))` 唯一），否则"测试工程师"又会分裂成几种写法。
 * - `department_job` 承接编制：`(department_id, job_id) → headcount`。部门说"我要 2 个
 *   测试工程师"，岗位定义仍然是全公司那一份。
 *
 * 表结构本身由 `repairJobCatalogue` 写入（`companyDatabase.ts`）：SQLite 没有条件 DDL，
 * 而这次迁移必须按"旧 job 表是否还有 department_id"分两种走法，且要能在重复打开时
 * 变成无操作。这里只留一个占位步骤，保证版本号推进。
 */
const V21 = `
SELECT 1;
`;

/**
 * V22: 记录 provider 归哪个设置页所有。
 *
 * Decision 页新建的自定义中转只服务分类器，但 LLM 页会把所有 `is_custom = 1`
 * 的行都列成 chat provider —— 用户在那里看到一堆只能做结构化判断、发 chat
 * 请求必然失败的条目。用一列显式记录归属页，比"猜模型类型"稳定：新建时还没
 * 加模型的行也能正确归类。
 *
 * 默认 `llm`：内置 provider 和 LLM 页创建的行都属于 LLM 页。Decision 页只给
 * 自己创建的自定义行写 `decision`，内置 provider（如 OpenRouter，同时提供 chat
 * 与 classifier）永远留在 LLM 页。
 */
const V22 = `
ALTER TABLE model_provider ADD COLUMN scope TEXT NOT NULL DEFAULT 'llm';

-- 存量回填：这一版之前从 Decision 页建的自定义中转没有归属信息，但它们只有
-- classifier 模型 —— 在 LLM 页里是一行发不出 chat 请求的空壳。只回填"非空且
-- 全是 classifier"的行：空模型列表无从判断，留给用户自己决定。
UPDATE model_provider
   SET scope = 'decision'
 WHERE is_custom = 1
   AND models <> '[]'
   AND NOT EXISTS (
     SELECT 1
       FROM json_each(model_provider.models) AS model
      WHERE json_extract(model.value, '$.capability') <> 'classifier'
   );
`;

/**
 * V23: 撤掉里程碑。
 *
 * 里程碑只在开发库里短暂存在过，没有发布。功能取消后这里把表删掉，避免开发库
 * 留下孤儿表；对从未跑过那一版构建的库是空操作。
 */
const V23 = `
DROP TABLE IF EXISTS project_milestone;
`;

/**
 * V24: 项目负责人。
 *
 * 负责人是项目层面唯一的责任人，和"谁被分配进来"是两件事：成员可以有很多个，
 * 负责人只有一个。没有它，页面上只能从 `assignment.role = '负责人'` 猜，改个角色
 * 就丢。这里存员工 id，读取时再关联姓名；不为它建外键，因为负责人被调离项目时
 * 由服务层负责清空，而不是让整行项目级联失败。
 */
const V24 = `
ALTER TABLE project_group ADD COLUMN owner_employee_id TEXT;
`;

/**
 * V25: v2 核心四表（thread / worker / event / report）。
 *
 * 这一版只**新增**，不动任何旧表：`employee` 仍是主语，直到 B3 把 comm/work/budget
 * 迁移到 thread 上（docs/v2/00-audit.md §6）。新增与迁移并行一段时间是刻意的，
 * 因为一次切换主语会让半个仓库同时编译不过。
 *
 * 设计要点：
 * - `thread.attention` 保留为历史兼容字段，用户动作统一通过对话卡片处理；
 * - `worker` 不再有职位、汇报线、在职状态机；`thread_id` 为空即"用完了"；
 * - `event` 是 Super-agent 的 Trigger，`triage` 的两级过滤状态机就在这里；
 * - `report` 是持久化的工作记录，也是对话卡片的恢复来源。
 */
const V25 = `
CREATE TABLE IF NOT EXISTS thread (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  -- 这条线是**谁**的影子：外面那个 PR / 话题 / 事件。
  source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual','folder','calendar','github','im')),
  external_id TEXT,
  state TEXT NOT NULL DEFAULT 'open'
    CHECK (state IN ('open','running','waiting','done','failed','archived')),
  attention TEXT NOT NULL DEFAULT 'silent'
    CHECK (attention IN ('decide','notify','silent')),
  budget_tokens INTEGER,
  spent_tokens INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_thread_state ON thread(state, last_activity_at DESC);

CREATE TABLE IF NOT EXISTS worker (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  template TEXT NOT NULL DEFAULT 'research'
    CHECK (template IN ('research','code','ops')),
  skills TEXT NOT NULL DEFAULT '[]',
  thread_id TEXT REFERENCES thread(id) ON DELETE SET NULL,
  model_provider TEXT,
  model_id TEXT,
  status TEXT NOT NULL DEFAULT 'idle'
    CHECK (status IN ('idle','running','retired')),
  spent_tokens INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  retired_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_worker_thread ON worker(thread_id, status);

CREATE TABLE IF NOT EXISTS event (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual','folder','calendar','github','im')),
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  thread_id TEXT REFERENCES thread(id) ON DELETE SET NULL,
  -- 外部平台的投递 id。重投不是新工作：同一个 id 只落一条事件（V35 的偏唯一索引）。
  dedupe_key TEXT,
  triage TEXT NOT NULL DEFAULT 'pending'
    CHECK (triage IN ('pending','accepted','dropped','merged')),
  created_at INTEGER NOT NULL,
  triaged_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_event_triage ON event(triage, created_at);

CREATE TABLE IF NOT EXISTS report (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
  level TEXT NOT NULL DEFAULT 'notify'
    CHECK (level IN ('decide','notify','silent')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_report_queue ON report(read_at, level, created_at DESC);
`;

/**
 * V26: 任务可以属于一条工作线。
 *
 * B3 的第一步只做**关联**，不换执行身份：`employee_id` 照旧是执行者，`thread_id`
 * 说明这个任务在替哪条工作线干活。这样一条线索拆出来的子任务天然同属一条线，
 * 老板问"那件事怎么样了"时能一次召回全部任务，而运行时一行不用改。
 *
 * 换执行身份（harness 按 thread 开库、worker 取代 employee）放在 B3 第二步，
 * 因为那一步要同时动 AgentPool 与工具注册表。
 */
const V26 = `
ALTER TABLE task ADD COLUMN thread_id TEXT REFERENCES thread(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_task_thread ON task(thread_id);
`;

/**
 * V27: worker 知道自己是替谁干活，task 知道自己是哪个 worker 跑的。
 *
 * B3-2 的落点。选定「一线多 worker、harness 按 worker 开库」之后，运行时身份
 * 就不能是 employee id——同一条工作线上两个执行者共用一个 Harness 会互相串台。
 *
 * - `worker.employee_id`：这个执行体由谁填充。迁移期与 employee 一一对应，
 *   B4 删掉 employee 后它就是 worker 自己的一部分。
 * - `task.worker_id`：这个任务由哪个 worker 执行。没有它的旧任务是空，
 *   运行时退回按 employee 开库——老数据不需要迁移就能继续跑。
 */
const V27 = `
ALTER TABLE worker ADD COLUMN employee_id TEXT;
CREATE INDEX IF NOT EXISTS idx_worker_employee ON worker(employee_id);

ALTER TABLE task ADD COLUMN worker_id TEXT REFERENCES worker(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_task_worker ON task(worker_id);
`;

/**
 * V28: Router 要真的能干三件事，这三件都需要落盘的东西。
 *
 * 1. **并线**（§3.2）。同一个 IM 话题 / 同一个 PR / 同一个文件下连续到达的事件属于
 *    同一条事件流。判断"是不是同一条"不能靠模型，得靠一个确定性的身份，所以
 *    thread 有了 `thread_key`：事件带着 key 来，已订阅的走直通（Fast Path），
 *    没订阅的才交给 Router（Slow Path）。
 *
 * 2. **订阅**（§3.2）。Thread × Worker 是多对多：一条线可以有多人干，一个人可以
 *    盯多条线。同一个 Thread 的新事件会直通给所有订阅它的 worker，它们不需要
 *    点对点通信，也能看到彼此的操作。
 *
 * 3. **已播报**。一条汇报只该让老板听见一次。`announced_at` 记的是"Router 已经拿
 *    它对外说过了"，和 `read_at`（老板读过）是两件事：没有这个字段，Router 每一轮
 *    都会把旧汇报重新讲一遍。
 */
const V28 = `
ALTER TABLE thread ADD COLUMN thread_key TEXT;
CREATE INDEX IF NOT EXISTS idx_thread_key ON thread(thread_key, state, last_activity_at DESC);

CREATE TABLE IF NOT EXISTS subscription (
  thread_id  TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
  worker_id  TEXT NOT NULL REFERENCES worker(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  dropped_at INTEGER,
  PRIMARY KEY (thread_id, worker_id)
);
CREATE INDEX IF NOT EXISTS idx_subscription_live ON subscription(dropped_at, worker_id);

ALTER TABLE report ADD COLUMN announced_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_report_unannounced ON report(announced_at, created_at DESC);

-- 事件的 triage 多了 routed。队列是瞬时数据，重建比迁移便宜，也不会有人想念旧行。
DROP TABLE IF EXISTS event;
CREATE TABLE event (
  id         TEXT PRIMARY KEY,
  source     TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual','folder','calendar','github','im')),
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL DEFAULT '{}',
  thread_id  TEXT REFERENCES thread(id) ON DELETE SET NULL,
  triage     TEXT NOT NULL DEFAULT 'pending'
    CHECK (triage IN ('pending','routed','accepted','dropped','merged')),
  created_at INTEGER NOT NULL,
  triaged_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_event_triage ON event(triage, created_at);
`;

/**
 * V29：两个子系统整体删除之后，它们的表也该走了。
 *
 * - **通讯层**（`inbox_item` / `wake_quota` / `guard_event`）：员工之间互相发消息、
 *   唤醒配额、护栏。v2 里没有"同事"，群建不出来，这套东西唯一的作用是在每次启动时
 *   被打开一遍。
 * - **预算**（`budget*` 四张）：限额 + 预留 + 硬停整套删掉了，只剩计费口径
 *   （定价、币种），那部分不落这些表。
 *
 * 迁移是只增不改的，所以这里用 DROP 而不是回头改 V2 / V8：新装建出来再删一次，
 * 老装的表消失。两个方向结果一样。
 *
 * `relationship` / `job` / `position` 等员工簇的表还没走：它们跟 employee 一起删。
 */
const V29 = `
DROP TABLE IF EXISTS inbox_item;
DROP TABLE IF EXISTS wake_quota;
DROP TABLE IF EXISTS guard_event;
DROP TABLE IF EXISTS budget_ledger;
DROP TABLE IF EXISTS budget_reservation;
DROP TABLE IF EXISTS budget_alert;
DROP TABLE IF EXISTS budget;
`;

/**
 * V30：执行体拥有自己的工具策略。
 *
 * §2.2 说 Worker「挂载完整的执行工具」——那么"它装了哪些工具"就必须是它自己的属性，
 * 而不是某个人的。这一列从 `employee.tool_policy` 挪过来之后，执行体的工具集与模型
 * 都在 worker 行上，`employee` 就没有功能依赖了。
 *
 * 默认 `'{}'` = 全开：新起的执行体先用模板给的完整工具集，谁想收窄谁改它。
 */
const V30 = `
ALTER TABLE worker ADD COLUMN tool_policy TEXT NOT NULL DEFAULT '{}';
`;

/**
 * V31：组织架构与员工体系整体退场。
 *
 * v2 里干活的是**执行体**（`worker`），不是员工。部门、岗位、汇报线、招聘、面试、
 * 绩效考核、员工包、雇佣事件、项目组——这一整套在界面上早已没有入口，运行时也不再
 * 读它们；留下表只是在每次打开数据库时多背一份包袱。
 *
 * 顺序从子表到父表：`position` / `job` 引用 `department`，`assignment` 引用
 * `project_group`，先删引用方，外键检查才过得去。
 *
 * `department_job` 是 `repairJobCatalogue()` 动态建出来的关联表（`docs/v2/01-core.md`
 * 的 12 张清单里没列），它同样属于这个集群，一并删掉，否则会成为一个没有父表的孤儿。
 */
const V31 = `
DROP TABLE IF EXISTS assignment;
DROP TABLE IF EXISTS project_group;
DROP TABLE IF EXISTS position;
DROP TABLE IF EXISTS relationship;
DROP TABLE IF EXISTS evaluation;
DROP TABLE IF EXISTS interview;
DROP TABLE IF EXISTS employee_package;
DROP TABLE IF EXISTS employment_event;
DROP TABLE IF EXISTS agent_candidate;
DROP TABLE IF EXISTS department_job;
DROP TABLE IF EXISTS job;
DROP TABLE IF EXISTS employee;
DROP TABLE IF EXISTS department;
`;

/**
 * V32：任务记住老板中途改的方向。
 *
 * §8.2 说「让用户在后台执行过程中随时介入」是双层架构里最值得探索的一项。介入要
 * 生效，得先有个地方**存住**那句话——`brief` 是派活时说的话，往里追加会污染原始
 * 交代；所以单独一列。`produce` 每次尝试都重新从库里读任务，重试与返工自然继承它。
 *
 * 存 JSON 而不是另开一张 `task_steering` 表：它只被整体读、从不单独查，也不参与
 * 任何 join。
 */
const V32 = `
ALTER TABLE task ADD COLUMN steering TEXT NOT NULL DEFAULT '[]';
`;

/**
 * V33：「组织 / 老板 / 员工」这三个词从库里退场。
 *
 * v2 早就按"一个助手的个人工作台"在跑，但表和列还姓 old world：`employee_memory`、
 * `org_fact`、`worker.employee_id`、`acceptance.reviewer='boss'`。留着它们，每读一行
 * 代码都要先在脑子里翻译一次——而翻译出来的东西（部门、项目、汇报线）在库里已经
 * 没有对应的表了。
 *
 * 三件事，全是**改名**，不是改行为：
 *
 * 1. `employee_memory` → `memory`。作用域收敛成 `personal | thread`：`department` /
 *    `project` 两张表 V31 就删了，那些行落到 `personal`（"我的经验"是唯一还成立的读法）；
 *    `org` 也落到 `personal`。旧行一条不丢。
 * 2. `org_fact` → `fact`，`org` → `global`。它一直是"这个工作台里都算数的事"，
 *    从来没有真的按组织切分过；`department` / `project` 同样落到 `global`。
 * 3. 称呼：`worker.employee_id` 与 `consolidation_run.employee_id` → `owner_id`；
 *    `acceptance.reviewer` 的 `manager | boss` → `system | user`（连同 `evidence`
 *    里记的 `command: ["boss", …]`）；`app_user.id = 'boss'` → `'user'`，
 *    默认称呼 `老板` → `我`。
 *
 * CHECK 约束改不了，所以三张表（`memory` / `fact` / `acceptance` / `app_user`）是
 * 重建后搬数据，再删旧表。别名与列名都在同一个迁移里改完，中间没有半旧半新的状态。
 */
const V33 = `
CREATE TABLE memory (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL,
  kind             TEXT NOT NULL,
  content          TEXT NOT NULL,
  scope_type       TEXT NOT NULL CHECK (scope_type IN ('personal','thread')),
  scope_id         TEXT,
  embedding        BLOB,
  embedding_model  TEXT,
  source_type      TEXT NOT NULL CHECK (source_type IN ('task','conversation','consolidation','manual')),
  source_id        TEXT,
  valid_from       INTEGER NOT NULL,
  valid_until      INTEGER,
  strength         REAL NOT NULL DEFAULT 1.0,
  recall_count     INTEGER NOT NULL DEFAULT 0,
  last_recalled_at INTEGER,
  is_archived      INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
INSERT INTO memory (id, owner_id, kind, content, scope_type, scope_id, embedding, embedding_model,
                    source_type, source_id, valid_from, valid_until, strength, recall_count,
                    last_recalled_at, is_archived, created_at, updated_at)
SELECT id, owner_id, kind, content,
       CASE scope_type WHEN 'thread' THEN 'thread' ELSE 'personal' END,
       scope_id, embedding, embedding_model, source_type, source_id, valid_from, valid_until,
       strength, recall_count, last_recalled_at, is_archived, created_at, updated_at
  FROM employee_memory;
DROP TABLE employee_memory;
CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory(owner_id, scope_type, scope_id);
CREATE INDEX IF NOT EXISTS idx_memory_thread ON memory(scope_type, scope_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_recent ON memory(owner_id, created_at DESC);

CREATE TABLE fact (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL,
  scope_type   TEXT NOT NULL CHECK (scope_type IN ('global','thread')),
  scope_id     TEXT NOT NULL DEFAULT '',
  subject      TEXT NOT NULL,
  predicate    TEXT NOT NULL,
  object       TEXT NOT NULL DEFAULT '',
  statement    TEXT NOT NULL,
  source_type  TEXT NOT NULL,
  source_id    TEXT,
  valid_from   INTEGER NOT NULL,
  valid_until  INTEGER,
  confidence   REAL NOT NULL DEFAULT 1.0,
  is_archived  INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
INSERT INTO fact (id, company_id, scope_type, scope_id, subject, predicate, object, statement,
                  source_type, source_id, valid_from, valid_until, confidence, is_archived,
                  created_at, updated_at)
SELECT id, company_id,
       CASE scope_type WHEN 'thread' THEN 'thread' ELSE 'global' END,
       scope_id, subject, predicate, object, statement, source_type, source_id, valid_from,
       valid_until, confidence, is_archived, created_at, updated_at
  FROM org_fact;
DROP TABLE org_fact;
CREATE INDEX IF NOT EXISTS idx_fact_scope ON fact(company_id, scope_type, scope_id, valid_from DESC);

ALTER TABLE worker RENAME COLUMN employee_id TO owner_id;
ALTER TABLE consolidation_run RENAME COLUMN employee_id TO owner_id;
DROP INDEX IF EXISTS idx_worker_employee;
CREATE INDEX IF NOT EXISTS idx_worker_owner ON worker(owner_id);
DROP INDEX IF EXISTS idx_consol_emp;
CREATE INDEX IF NOT EXISTS idx_consol_owner ON consolidation_run(owner_id, started_at DESC);

CREATE TABLE acceptance_v33 (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  verdict     TEXT NOT NULL CHECK (verdict IN ('pass','fail')),
  reason      TEXT NOT NULL DEFAULT '',
  evidence    TEXT NOT NULL DEFAULT '{}',
  reviewer    TEXT NOT NULL DEFAULT 'auto' CHECK (reviewer IN ('auto','system','user')),
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES task(id)
);
INSERT INTO acceptance_v33 (id, task_id, verdict, reason, evidence, reviewer, created_at)
SELECT id, task_id, verdict, reason,
       REPLACE(REPLACE(evidence, '"boss"', '"user"'), '"manager"', '"system"'),
       CASE reviewer WHEN 'boss' THEN 'user' WHEN 'manager' THEN 'system' ELSE reviewer END,
       created_at
  FROM acceptance;
DROP TABLE acceptance;
ALTER TABLE acceptance_v33 RENAME TO acceptance;
CREATE INDEX IF NOT EXISTS idx_acceptance_task ON acceptance(task_id, created_at);

CREATE TABLE app_user_v33 (
  id         TEXT PRIMARY KEY CHECK (id = 'user'),
  name       TEXT NOT NULL,
  avatar     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO app_user_v33 (id, name, avatar, created_at, updated_at)
SELECT 'user', CASE WHEN name = '老板' THEN '我' ELSE name END, avatar, created_at, updated_at
  FROM app_user;
DROP TABLE app_user;
ALTER TABLE app_user_v33 RENAME TO app_user;

UPDATE message SET payload = REPLACE(payload, '"senderId":"boss"', '"senderId":"user"')
 WHERE payload LIKE '%"senderId":"boss"%';
`;

/**
 * V34：`industry` / `vision` 也换掉。
 *
 * 这两个字段是"公司资料"页留下来的：一个行业、一个愿景。产品现在是**一个助手的
 * 个人工作台**，所以它们是同一件事的两种问法——「你在做什么」和「一句话目标」。
 * 词换了，值不动（`company.domain` 里存的 id 只有渲染层认得，换的是列名）。
 *
 * `profile.vision` 是 `app_setting` 里的一行，所以是搬键而不是改名。`UPDATE OR REPLACE`
 * 是为了防"两个键都存在"的库：新键赢，旧键消失，而不是让主键冲突把升级卡死。
 */
const V34 = `
ALTER TABLE company RENAME COLUMN industry TO domain;
UPDATE OR REPLACE app_setting SET key = 'profile.goal' WHERE key = 'profile.vision';
`;

/**
 * V35：一条线的**环境身份**。
 *
 * 原文说"具备连续/完整上下文的 request 才叫 Thread"——一个 PR、一封邮件的往来、一个
 * IM 话题。它们能被称为一条线，靠的是**外面那个东西有自己的 id**，而不是我们给它起
 * 了个标题。所以线要记住自己是谁的影子：来源 + 外部 id。
 *
 * 三条一起做，因为它们是一个东西：
 *
 * 1. `source` / `external_id` 从 `thread_key` 的前缀反解出来，界面与排查都读它；
 * 2. **同一身份上只允许一条活线**。老代码只按 `last_activity_at` 取最新的一条，重复
 *    的键不会报错，只会让旧的那条永远收不到事件——静默的孤儿。先把手上的重复摘掉键
 *    （内容都在，只是不再声称自己是那个身份），再建部分唯一索引把它焊死；
 * 3. 索引是**部分**的：终态的线不占位，同一个 PR 关掉之后重新打开是一条新线。
 */
const V35 = `
ALTER TABLE thread ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'
  CHECK (source IN ('manual','folder','calendar','github','im'));
ALTER TABLE thread ADD COLUMN external_id TEXT;

UPDATE thread
   SET source = CASE
         WHEN thread_key LIKE 'github:%'   THEN 'github'
         WHEN thread_key LIKE 'im:%'       THEN 'im'
         WHEN thread_key LIKE 'calendar:%' THEN 'calendar'
         WHEN thread_key LIKE 'folder:%'   THEN 'folder'
         ELSE 'manual' END,
       external_id = CASE WHEN instr(thread_key, ':') > 0
                          THEN substr(thread_key, instr(thread_key, ':') + 1) END
 WHERE thread_key IS NOT NULL;

UPDATE thread SET thread_key = NULL
 WHERE thread_key IS NOT NULL
   AND state NOT IN ('done','failed','archived')
   AND EXISTS (
     SELECT 1 FROM thread other
      WHERE other.thread_key = thread.thread_key
        AND other.state NOT IN ('done','failed','archived')
        AND (other.last_activity_at > thread.last_activity_at
             OR (other.last_activity_at = thread.last_activity_at AND other.id > thread.id))
   );

CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_key_live ON thread(thread_key)
  WHERE thread_key IS NOT NULL AND state NOT IN ('done','failed','archived');

ALTER TABLE event ADD COLUMN dedupe_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_dedupe ON event(dedupe_key)
  WHERE dedupe_key IS NOT NULL;
`;

/**
 * V36：记忆的**层**。
 *
 * 原文把"必须每轮生效的东西"和"按需回忆的东西"混成一句话（§2.1 的"记忆"），但它们的
 * 失效方式完全不同：一条「回答不要客套」漏一次用户就看见了；一条"上次那个客户叫张伟"
 * 想不起来只是慢一点。混在一张表里用同一条衰减曲线，必然要么漏掉前者，要么被后者撑爆。
 *
 * 所以加一列：
 *
 * - `standing`：常驻约束。**每轮进上下文**，不参与检索、不衰减、有硬上限（20 条）。
 *   只能被显式撤掉或被更新的版本取代。
 * - `long`：长期记忆。按相关度召回，衰减只影响排序（`07-memory.md` §1 公理 A2）。
 *
 * 默认值是 `long`：老库里的所有行都是"按需回忆"的那一类，没有一条该自动变成常驻约束——
 * 常驻是要用户明说的。
 */
const V36 = `
ALTER TABLE memory ADD COLUMN tier TEXT NOT NULL DEFAULT 'long'
  CHECK (tier IN ('long','standing'));
CREATE INDEX IF NOT EXISTS idx_memory_tier ON memory(tier, owner_id, created_at);
`;

/**
 * V37：记忆的**类型**、**主题**和**时间常数**。
 *
 * 三列都是为了让"这条和那条是不是同一件事"能由程序回答，而不是靠模型每次重新猜：
 *
 * - `subject`：规范化的主题键（`output.format`、`称呼`）。同一个 subject 上**只留一条
 *   活着的**，由部分唯一索引焊死。没有它，一句「别写注释」被记三遍就是三条，之后
 *   recall 时三条挤占五个名额里的三个。
 * - `superseded_by`：被谁取代。旧行只写 `valid_until`，不删——「他以前要求过什么、
 *   后来改成什么」本身就是信息。
 * - `volatility`：时间常数。「他最近在做一个 Rust 项目」会过期，「他讨厌客套话」不会。
 *   一条衰减曲线套在所有记忆上，必然要么让稳定的过早消失，要么让易变的变成陈词。
 *
 * 默认值让老库完全保持现在的行为：没有 subject 就不参与去重，`slow` 就是过去那条
 * 30 天半衰期。
 */
const V37 = `
ALTER TABLE memory ADD COLUMN subject TEXT;
ALTER TABLE memory ADD COLUMN superseded_by TEXT;
ALTER TABLE memory ADD COLUMN volatility TEXT NOT NULL DEFAULT 'slow'
  CHECK (volatility IN ('stable','slow','session'));
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_subject_live
  ON memory(owner_id, subject, tier)
  WHERE subject IS NOT NULL AND is_archived = 0 AND valid_until IS NULL;
`;

/**
 * V38：**免费的偏好信号**。
 *
 * 用户表达偏好最可靠的方式不是聊天里随口一句，是**他让活儿返工时的理由**：
 * 「图表要标上单位」「结论放前面」。那是他明确说"这版不对，应该是 X"——比任何
 * 语气猜测都干净。第二个同样可靠的信号是 `steer_line`：他中途改方向时写的那句话。
 *
 * 这两个信号一直在库里（返工理由被拼进下一版任务的 brief，半路被稀释掉；改方向
 * 存在 `task.steering`），**从来没有人把它们当成偏好证据**。
 *
 * 现在先原样收下来，处理是后置的、批量的、可能失败的——所以它必须自己是一张表：
 *
 * - 收（`record`）是同步的、幂等的，发生在用户点下"重做"的那一刻，不能失败；
 * - 处理（抽取）是异步的，一次可能处理 0 条、N 条，也可能整个失败。
 *
 * `processed_at` 是唯一的进度标记。抽取失败时它保持 NULL，下一轮重来——**宁可多问
 * 一遍，不可漏掉一次**（和事件队列同一条规矩）。
 */
const V38 = `
CREATE TABLE IF NOT EXISTS memory_signal (
  id           TEXT PRIMARY KEY,
  origin       TEXT NOT NULL CHECK (origin IN ('rework','steering')),
  thread_id    TEXT,
  text         TEXT NOT NULL,
  at           INTEGER NOT NULL,
  processed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_memory_signal_pending ON memory_signal(processed_at, at);
`;

/**
 * V39：**观察次数**，用来判断一条偏好要不要升进常驻层。
 *
 * 「同一件事被要求过三次」比「说过一次」可靠得多，而这件事以前数不出来：P2 的去重会
 * 把重复的那次合成一条，历史行又只是"被取代的旧版本"。所以要一个计数器，它回答的是
 * 「这个主题被独立观察到几次」。
 *
 * 默认 1 让老库保持现状：谁也不会因为升级而突然多出一条常驻约束。
 */
const V39 = `
ALTER TABLE memory ADD COLUMN observations INTEGER NOT NULL DEFAULT 1;

-- 一个主题只留一条活着的，**不分层**：同一条偏好在常驻层和长期层各躺一份是最糟的
-- 状态——用户看到两行一样的字，而只有其中一行真的每轮生效。
DROP INDEX IF EXISTS idx_memory_subject_live;
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_subject_live
  ON memory(owner_id, subject)
  WHERE subject IS NOT NULL AND is_archived = 0 AND valid_until IS NULL;
`;

/**
 * V40：**静默线**（§3.4 投机执行在我们这里能被搬过来的那一半）。
 *
 * Router 有时会判断"这件事值得跑，但值不值得让他知道还不确定"——比如群里有人报了个错。
 * 这种线的规矩是反的：**永远不 decide**。跑通了才 notify（"我查了一下，是这样"），
 * 没跑通就 silent 归档（"我试过了，不值得"也是一条结论，但不该打断他）。
 *
 * 默认 0 让老库保持现状：已有的线全都还是"跑完了要说话"的。
 */
const V40 = `
ALTER TABLE thread ADD COLUMN speculative INTEGER NOT NULL DEFAULT 0;
`;

/** V41：保存原始信道的回复地址，异步任务完成后 Router 仍能回到来源。 */
const V41 = `
ALTER TABLE thread ADD COLUMN reply_target TEXT;
`;

/**
 * V42：执行体的**动作流**（`09-worker-spec.md` W6 / §3.4）。
 *
 * 在这之前，一次尝试只往 `task_step` 写四条系统旁白（交给 pi 循环 / 模型用量 / 循环结束），
 * 工具调用、改了哪个文件全都不在库里。后果是三个消费方同时瞎：
 * 界面上的进度是装饰、Watchdog 的"转圈"永远不触发、事后复盘只能看四句话。
 *
 * `seq` 是单调的，裁剪只删中间那一段，所以序号会留空洞——读的人据此说「略去 N 步」，
 * 而不是把"被裁掉"误读成"什么都没发生"。
 */
const V42 = `
CREATE TABLE IF NOT EXISTS task_trace (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  at          INTEGER NOT NULL,
  kind        TEXT NOT NULL
    CHECK (kind IN ('tool','file','decision','usage','error')),
  name        TEXT NOT NULL,
  args_digest TEXT NOT NULL DEFAULT '',
  ok          INTEGER,
  ms          INTEGER,
  tokens      INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_trace_seq ON task_trace(task_id, seq);
`;

/**
 * V43：`task_trace.ok` 要能是 `null`。
 *
 * 一开始把它写成了 `NOT NULL DEFAULT 1`，因为"成败"看起来必然是二值的。真实跑过一次
 * 之后发现不是：pi 在工具任务 faulted、或者调用所在的运行结束时都会发一个**不带结果**的
 * `tool_execution_end`，而我们没法区分这两件事。把"不知道"写成"成功"或"失败"都是让界面
 * 替系统撒谎，所以这一列改成可空。
 *
 * SQLite 不能 ALTER 掉 NOT NULL，只能重建。这张表是纯观测数据、没有任何外键指过来，
 * 重建的代价是丢掉已有的观测记录——比留一个隐形的写入失败便宜。
 */
const V43 = `
DROP TABLE IF EXISTS task_trace;
CREATE TABLE IF NOT EXISTS task_trace (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  at          INTEGER NOT NULL,
  kind        TEXT NOT NULL
    CHECK (kind IN ('tool','file','decision','usage','error')),
  name        TEXT NOT NULL,
  args_digest TEXT NOT NULL DEFAULT '',
  ok          INTEGER,
  ms          INTEGER,
  tokens      INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_trace_seq ON task_trace(task_id, seq);
`;

/**
 * V44：`task.error_kind`（`09-worker-spec.md` §3.7）。
 *
 * 在这之前只有一句 `error`，于是「没模型」和「闸门没过」长得一模一样：前者会得到一个
 * 永远不会好的重试，后者被说成"跑挂了"。这一列存的是**哪一类**，它决定的不是措辞，
 * 而是要不要重试、线停在哪个状态、要不要打扰人。
 *
 * 可空：老任务没有分类，读到 `undefined` 就按"没分类"处理，而不是猜一个。
 */
const V44 = `
ALTER TABLE task ADD COLUMN error_kind TEXT;
`;

/**
 * V45：汇报分两种话，而且知道它是哪件活说的。
 *
 * 在这之前，`report` 里混着两种东西：「结果给你看」（验收过了/没过）和「问题要你答」
 * （执行体请示）。它们长得一模一样，于是收件端只有两个动词——认可和返工——而这两个
 * 都回答不了一句问句。`task_id` 也是必须的：回答要落到**问问题的那件活**上，不能落到
 * "这条线上最近的一件"。
 *
 * 默认值让老库保持现状：以前的汇报全是"结果"，没有一件知道自己是哪件活说的。
 */
const V45 = `
ALTER TABLE report ADD COLUMN task_id TEXT;
ALTER TABLE report ADD COLUMN kind TEXT NOT NULL DEFAULT 'report'
  CHECK (kind IN ('report','question'));
`;

/**
 * V46：**动作级审批**（M3）。
 *
 * 两件事：
 *
 * 1. `report.kind` 多一种 `approval`——「这件事需要你点头」和「这个问题需要你回答」不是
 *    同一句话。前者要的是**放行**，后者要的是**内容**；用一个框收两种东西，收件端就只能猜。
 *    SQLite 改不了 CHECK 约束，所以这张表重建一次（数据原样搬过去）。
 *    `subject` 记的是"这条汇报是关于哪个东西的"（审批时就是一个工具名）：收件端要能
 *    把"允许"落回到**那个工具**上，而不能靠解析标题——标题是给人看的，随时会改文案。
 * 2. `mcp_permit`：谁被放行了。键是（哪件活 × 哪个工具），**不是一次性**：你答了"可以"，
 *    是"这件活用这个工具可以"，不是"这一次可以、下一次再问你一遍"——问第二遍正是 E3 里
 *    那条"同一件事请示第二次就是噪音"。
 */
const V46 = `
CREATE TABLE report_next (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
  level TEXT NOT NULL DEFAULT 'notify'
    CHECK (level IN ('decide','notify','silent')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  announced_at INTEGER,
  task_id TEXT,
  subject TEXT,
  kind TEXT NOT NULL DEFAULT 'report'
    CHECK (kind IN ('report','question','approval'))
);
INSERT INTO report_next
  (id, thread_id, level, title, body, created_at, read_at, announced_at, task_id, subject, kind)
SELECT id, thread_id, level, title, body, created_at, read_at, announced_at, task_id, NULL,
       CASE WHEN kind = 'question' THEN 'question' ELSE 'report' END
  FROM report;
DROP TABLE report;
ALTER TABLE report_next RENAME TO report;
CREATE INDEX IF NOT EXISTS idx_report_queue ON report(read_at, level, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_report_unannounced ON report(announced_at, created_at DESC);

CREATE TABLE IF NOT EXISTS mcp_permit (
  task_id    TEXT NOT NULL,
  tool       TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, tool)
);
`;

/**
 * V47：**主进程心跳与系统故障事件**（`11-watchdog-spec.md` W1）。
 *
 * 在这之前，"系统自己出毛病了"这件事只存在于控制台：Router 交给会话失败、
 * 任务恢复失败、MCP 连不上，全都是一行 `console.error`。Watchdog 读的是库，
 * 所以它对这些一无所知——它只能看见"某个任务卡住了"，看不见"为什么整个轮次
 * 都在失败"。
 *
 * 两张表：
 *
 * 1. `system_heartbeat`：主进程还活着吗。`instance_id` 每次启动都不一样，所以
 *    下一轮启动时能区分"上一个进程没正常关"和"这次刚起来"。只有一行（`id='main'`）。
 * 2. `system_event`：结构性故障。只存可安全展示的东西——类型、时间、关联对象、
 *    一句摘要、一段脱敏 JSON。**不存凭据，也不存完整提示词**。
 */
const V47 = `
CREATE TABLE IF NOT EXISTS system_heartbeat (
  id          TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  pid         INTEGER NOT NULL,
  at          INTEGER NOT NULL,
  state       TEXT NOT NULL DEFAULT 'running'
    CHECK (state IN ('running','stopping'))
);

CREATE TABLE IF NOT EXISTS system_event (
  id           TEXT PRIMARY KEY,
  at           INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  severity     TEXT NOT NULL DEFAULT 'error'
    CHECK (severity IN ('info','warning','error')),
  subject_type TEXT NOT NULL DEFAULT '',
  subject_id   TEXT NOT NULL DEFAULT '',
  summary      TEXT NOT NULL DEFAULT '',
  detail       TEXT NOT NULL DEFAULT '',
  handled_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_system_event_recent ON system_event(at DESC);
CREATE INDEX IF NOT EXISTS idx_system_event_open ON system_event(handled_at, at DESC);
CREATE INDEX IF NOT EXISTS idx_system_event_subject ON system_event(subject_type, subject_id, at DESC);
`;

/**
 * V48：**Watchdog 的 incident 镜像**（`11-watchdog-spec.md` W3）。
 *
 * 事实源在 Watchdog 自己的库里：状态机必须能在主进程卡住时继续推进，所以它
 * 不能住在一个"主进程不可用就写不进去"的地方。这张表是**镜像**，给 Router 与
 * 界面读，由父进程按子进程每轮的 `tick` 刷新。
 *
 * 镜像可以丢：下一轮 tick 会重新写平。所以它不需要和子进程保持事务一致，
 * 也不需要保留历史——历史在子进程那边。
 */
const V48 = `
CREATE TABLE IF NOT EXISTS watchdog_incident (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active','rechecking','escalated','resolved')),
  subject_type TEXT NOT NULL DEFAULT '',
  subject_id   TEXT NOT NULL DEFAULT '',
  summary      TEXT NOT NULL DEFAULT '',
  detail       TEXT NOT NULL DEFAULT '',
  first_at     INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  resolved_at  INTEGER,
  reopen_count INTEGER NOT NULL DEFAULT 0,
  synced_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_watchdog_incident_open
  ON watchdog_incident(state, last_seen_at DESC);
`;

/**
 * V49：**Watchdog 的动作审计**（`11-watchdog-spec.md` W6）。
 *
 * 每一次"它请求系统做一件事"都落一行，包括被拒绝的那些。三件事靠它：
 *
 * 1. **幂等**：唯一键 (incident_id, action) —— 同一个请求重发多少次都只执行一次；
 * 2. **审计**：谁在什么时候、因为什么、动了什么；
 * 3. **回写**：执行结果（ok/message）留在库里，不会被"下一步又好了"覆盖掉。
 *
 * 这里只记**动作请求**，不记动作实现——实现永远在主进程（凭据与业务不变量都在那边）。
 */
const V49 = `
CREATE TABLE IF NOT EXISTS watchdog_action (
  id           TEXT PRIMARY KEY,
  incident_id  TEXT NOT NULL,
  action       TEXT NOT NULL,
  reason       TEXT NOT NULL DEFAULT '',
  evidence     TEXT NOT NULL DEFAULT '',
  requested_at INTEGER NOT NULL,
  executed_at  INTEGER,
  status       TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','done','failed','refused')),
  result       TEXT NOT NULL DEFAULT '',
  UNIQUE (incident_id, action)
);
CREATE INDEX IF NOT EXISTS idx_watchdog_action_recent ON watchdog_action(requested_at DESC);
`;

/**
 * V50：**Watchdog 的恢复能力**（审查修复）。
 *
 * 1. `watchdog_action.attempts`：动作请求失败后要能重试。没有次数，就只能
 *    "一次失败永不重试"或"无限重试"，两种都不对。
 * 2. `watchdog_incident.announced_at` / `announce_attempts`：**状态迁移 ≠ 已经通知到人**。
 *    以前镜像一升到 escalated 就算通知过；写报告失败那次就永远丢了。
 *    现在"升级"和"通知成功"是两件事，通知失败下一轮还会再试。
 */
const V50 = `
ALTER TABLE watchdog_action ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1;
ALTER TABLE watchdog_incident ADD COLUMN announced_at INTEGER;
ALTER TABLE watchdog_incident ADD COLUMN announce_attempts INTEGER NOT NULL DEFAULT 0;
`;

/** V51：把模型 verdict 作为结构化 incident 字段镜像，不混进规则摘要。 */
const V51 = `
ALTER TABLE watchdog_incident ADD COLUMN verdict TEXT NOT NULL DEFAULT '';
ALTER TABLE watchdog_incident ADD COLUMN verdict_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE watchdog_incident ADD COLUMN verdict_confidence REAL NOT NULL DEFAULT 0;
ALTER TABLE watchdog_incident ADD COLUMN judged_at INTEGER;
ALTER TABLE watchdog_incident ADD COLUMN judged_by TEXT NOT NULL DEFAULT '';
`;

/** V52: explicit Worker delivery contracts and captured final answers. */
const V52 = `
ALTER TABLE task ADD COLUMN contract_json TEXT;
ALTER TABLE task ADD COLUMN answer TEXT;
`;

/** V53: SQLite-backed personal context ontology.
 *
 * The existing business tables remain authoritative. These tables add durable
 * graph semantics (entities, evidence, temporal assertions and commands) without
 * copying or replacing task/worker/approval rows.
 */
const V53 = String.raw`
CREATE TABLE IF NOT EXISTS ontology_entity (
  id              TEXT PRIMARY KEY,
  entity_type     TEXT NOT NULL,
  canonical_name  TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  properties_json TEXT NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','archived')),
  version         INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ontology_entity_type ON ontology_entity(entity_type, status);
CREATE INDEX IF NOT EXISTS idx_ontology_entity_name ON ontology_entity(entity_type, canonical_name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS ontology_entity_alias (
  id          TEXT PRIMARY KEY,
  entity_id   TEXT NOT NULL,
  alias       TEXT NOT NULL,
  normalized  TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'user',
  created_at  INTEGER NOT NULL,
  UNIQUE (entity_id, normalized),
  FOREIGN KEY (entity_id) REFERENCES ontology_entity(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ontology_alias_lookup ON ontology_entity_alias(normalized);

CREATE TABLE IF NOT EXISTS ontology_episode (
  id             TEXT PRIMARY KEY,
  source_type    TEXT NOT NULL,
  source_id      TEXT,
  actor          TEXT NOT NULL DEFAULT 'system',
  content        TEXT NOT NULL,
  content_hash   TEXT NOT NULL,
  occurred_at    INTEGER NOT NULL,
  metadata_json  TEXT NOT NULL DEFAULT '{}',
  created_at     INTEGER NOT NULL,
  UNIQUE (source_type, source_id, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_ontology_episode_time ON ontology_episode(occurred_at DESC);

CREATE TABLE IF NOT EXISTS ontology_predicate (
  name             TEXT PRIMARY KEY,
  subject_types    TEXT NOT NULL DEFAULT '[]',
  object_types     TEXT NOT NULL DEFAULT '[]',
  cardinality      TEXT NOT NULL DEFAULT 'many'
                   CHECK (cardinality IN ('one','many')),
  sensitivity      TEXT NOT NULL DEFAULT 'normal'
                   CHECK (sensitivity IN ('normal','sensitive')),
  description      TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS ontology_assertion (
  id                  TEXT PRIMARY KEY,
  subject_entity_id   TEXT NOT NULL,
  predicate           TEXT NOT NULL,
  object_entity_id    TEXT,
  object_value        TEXT,
  value_type          TEXT NOT NULL DEFAULT 'text'
                      CHECK (value_type IN ('entity','text','number','boolean','json')),
  confidence          REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  status              TEXT NOT NULL DEFAULT 'current'
                      CHECK (status IN ('current','superseded','retracted')),
  source_episode_id   TEXT NOT NULL,
  evidence_span       TEXT,
  valid_from          INTEGER NOT NULL,
  valid_until         INTEGER,
  superseded_by       TEXT,
  version             INTEGER NOT NULL DEFAULT 1,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  FOREIGN KEY (subject_entity_id) REFERENCES ontology_entity(id),
  FOREIGN KEY (object_entity_id) REFERENCES ontology_entity(id),
  FOREIGN KEY (predicate) REFERENCES ontology_predicate(name),
  FOREIGN KEY (source_episode_id) REFERENCES ontology_episode(id),
  FOREIGN KEY (superseded_by) REFERENCES ontology_assertion(id),
  CHECK ((value_type = 'entity' AND object_entity_id IS NOT NULL AND object_value IS NULL)
      OR (value_type <> 'entity' AND object_value IS NOT NULL AND object_entity_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_ontology_assertion_subject ON ontology_assertion(subject_entity_id, predicate, status, valid_from DESC);
CREATE INDEX IF NOT EXISTS idx_ontology_assertion_object ON ontology_assertion(object_entity_id, status) WHERE object_entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ontology_assertion_episode ON ontology_assertion(source_episode_id);

CREATE TABLE IF NOT EXISTS ontology_profile_projection (
  subject_entity_id       TEXT PRIMARY KEY,
  profile_json            TEXT NOT NULL DEFAULT '{}',
  source_assertion_ids    TEXT NOT NULL DEFAULT '[]',
  version                 INTEGER NOT NULL DEFAULT 1,
  generated_at            INTEGER NOT NULL,
  FOREIGN KEY (subject_entity_id) REFERENCES ontology_entity(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ontology_action_command (
  command_id          TEXT PRIMARY KEY,
  actor               TEXT NOT NULL CHECK (actor IN ('user','router','worker')),
  object_type         TEXT NOT NULL,
  object_id           TEXT NOT NULL,
  action              TEXT NOT NULL,
  args_json           TEXT NOT NULL DEFAULT '{}',
  expected_version    INTEGER,
  idempotency_key     TEXT NOT NULL UNIQUE,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','running','succeeded','failed','rejected')),
  approval_id         TEXT,
  result_json         TEXT,
  error               TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  completed_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ontology_command_status ON ontology_action_command(status, created_at);

CREATE TABLE IF NOT EXISTS ontology_outbox_event (
  id             TEXT PRIMARY KEY,
  event_type     TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id   TEXT NOT NULL,
  payload_json   TEXT NOT NULL DEFAULT '{}',
  occurred_at    INTEGER NOT NULL,
  delivered_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ontology_outbox_pending ON ontology_outbox_event(delivered_at, occurred_at);
`;

/** V54: durable outbox retry metadata. */
const V54 = `
ALTER TABLE ontology_outbox_event ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ontology_outbox_event ADD COLUMN last_error TEXT;
ALTER TABLE ontology_outbox_event ADD COLUMN next_attempt_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_ontology_outbox_due ON ontology_outbox_event(delivered_at, next_attempt_at, occurred_at);
`;

/** V55: structured Worker result retained alongside the human-readable report. */
const V55 = `
ALTER TABLE report ADD COLUMN result_json TEXT;
`;

/** V56: durable, call-level usage records for the Settings → Usage report. */
const V56 = `
CREATE TABLE IF NOT EXISTS ai_call (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  duration_ms INTEGER,
  employee_id TEXT,
  worker_id TEXT,
  task_id TEXT,
  conversation_id TEXT,
  capability TEXT NOT NULL,
  operation TEXT NOT NULL,
  origin TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  status TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  token_source TEXT NOT NULL DEFAULT 'missing',
  billing_unit TEXT NOT NULL,
  billed_quantity REAL NOT NULL DEFAULT 0,
  provider_cost_usd REAL,
  configured_cost_usd REAL,
  charged_cost_usd REAL,
  cost_source TEXT NOT NULL DEFAULT 'unpriced',
  price_snapshot TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_call_time ON ai_call(started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_ai_call_model ON ai_call(provider_id, model_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_call_scope ON ai_call(capability, origin, worker_id, started_at DESC);
`;

/** V57: persistent Router schedules and their idempotent execution history. */
const V57 = `
CREATE TABLE IF NOT EXISTS router_schedule (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  instruction TEXT NOT NULL,
  rule_json TEXT NOT NULL,
  timezone TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','paused','cancelled','completed')),
  next_run_at INTEGER,
  last_run_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_router_schedule_due ON router_schedule(status, next_run_at);
CREATE TABLE IF NOT EXISTS router_schedule_occurrence (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES router_schedule(id),
  scheduled_for INTEGER NOT NULL,
  enqueued_at INTEGER NOT NULL,
  event_id TEXT NOT NULL UNIQUE REFERENCES event(id),
  missed_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(schedule_id, scheduled_for)
);
CREATE INDEX IF NOT EXISTS idx_router_schedule_occurrence_recent
  ON router_schedule_occurrence(schedule_id, scheduled_for DESC);
`;

export const MIGRATIONS: readonly string[] = [V1, V2, V3, V4, V5, V6, V7, V8, V9, V10, V11, V12, V13, V14, V15, V16, V17, V18, V19, V20, V21, V22, V23, V24, V25, V26, V27, V28, V29, V30, V31, V32, V33, V34, V35, V36, V37, V38, V39, V40, V41, V42, V43, V44, V45, V46, V47, V48, V49, V50, V51, V52, V53, V54, V55, V56, V57];
/** Default company policy (§4.2 `settings`), overridable per installation. */
export const DEFAULT_COMPANY_SETTINGS = {
  heartbeatMinutes: 15,
  defaultDailyWakeQuota: 5,
  maxConversationTurns: 10,
  maxTaskDepth: 3,
  maxTaskFanout: 5,
  maxActiveTasksPerEmployee: 3,
  archiveAfterHours: 24,
} as const;
