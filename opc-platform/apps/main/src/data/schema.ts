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

export const SCHEMA_VERSION = 11;

/** v1.0 is one company per installation (§1.3); its row is seeded on first open. */
export const COMPANY_ID = 'company-local';

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
  parent_id         TEXT,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  deleted_at        INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
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
-- Imported agent packages that are not employees yet (§4.4, reduced: evaluation /
-- interview / employee_package are Phase 4 and will be added by migration).
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

export const MIGRATIONS: readonly string[] = [V1, V2, V3, V4, V5, V6, V7, V8, V9, V10, V11];

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
