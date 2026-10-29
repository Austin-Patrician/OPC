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

export const SCHEMA_VERSION = 21;

/** v1.0 is one company per installation (§1.3); its row is seeded on first open. */
export const COMPANY_ID = 'company-local';

/**
 * The one human in the company.
 *
 * `'boss'` was a magic string spread through `employment_event.actor`,
 * `evaluation.reviewer`, `acceptance.reviewer` and message sender ids. It is now the
 * primary key of a real `app_user` row, so "who did this" resolves to a person with a
 * name and a portrait instead of to a literal.
 *
 * The id stays stable on purpose: it is already written into existing rows, and
 * renaming the boss must not rewrite history.
 */
export const BOSS_USER_ID = 'boss';

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
  employee_id         TEXT NOT NULL,
  -- Denormalised on purpose: a task card must still render after its assignee is
  -- terminated and their position is gone.
  employee_name       TEXT NOT NULL DEFAULT '',
  parent_task_id      TEXT,
  -- Set when this task *is* the manager's sign-off of another task.
  review_of_task_id   TEXT,
  is_review           INTEGER NOT NULL DEFAULT 0,
  depth               INTEGER NOT NULL DEFAULT 0,
  est_tokens          INTEGER NOT NULL DEFAULT 0,
  -- argv JSON, never a shell string.
  acceptance_command  TEXT NOT NULL DEFAULT '[]',
  acceptance_template TEXT NOT NULL DEFAULT 'http-ok'
                      CHECK (acceptance_template IN ('http-ok','image-200','review-verdict')),
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
  started_at          INTEGER,
  finished_at         INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  FOREIGN KEY (employee_id) REFERENCES employee(id),
  FOREIGN KEY (parent_task_id) REFERENCES task(id),
  FOREIGN KEY (review_of_task_id) REFERENCES task(id)
);
CREATE INDEX IF NOT EXISTS idx_task_employee ON task(employee_id, status);
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
  employee_id      TEXT NOT NULL,
  kind             TEXT NOT NULL,
  content          TEXT NOT NULL,
  scope_type       TEXT NOT NULL CHECK (scope_type IN ('personal','org','department','project')),
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
  updated_at       INTEGER NOT NULL,
  FOREIGN KEY (employee_id) REFERENCES employee(id)
);
CREATE INDEX IF NOT EXISTS idx_memory_scope ON employee_memory(employee_id, scope_type, scope_id);
CREATE INDEX IF NOT EXISTS idx_memory_recent ON employee_memory(employee_id, created_at DESC);

-- Shared facts (org / department / project). Not personal: everyone scoped to the
-- same project sees the same rows.
CREATE TABLE IF NOT EXISTS org_fact (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL,
  scope_type   TEXT NOT NULL CHECK (scope_type IN ('org','department','project')),
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
 * - `tool_policy` 存 `EmployeeToolPolicy`（JSON，禁用名单）。默认空对象 = 当前运行环境
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

export const MIGRATIONS: readonly string[] = [V1, V2, V3, V4, V5, V6, V7, V8, V9, V10, V11, V12, V13, V14, V15, V16, V17, V18, V19, V20, V21];
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
