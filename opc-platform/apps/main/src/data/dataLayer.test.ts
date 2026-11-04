import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryService } from '../memory/memoryService';
import { CompanyService } from '../company/companyService';
import { openCompanyDatabase, probeSqlite, type CompanyDatabase } from './companyDatabase';
import { MIGRATIONS, SCHEMA_VERSION } from './schema';
import { TaskRepository, taskWorkspaceRelPath } from './taskRepository';
import { ThreadRepository } from './threadRepository';

/**
 * The data layer against a real SQLite file.
 *
 * These are not unit tests of SQL strings: they open company.db, migrate it, and
 * drive the exact call sequences the services use. A schema column that drifted
 * from a query shows up here, and nowhere else short of launching Electron.
 */
let dir: string;
let db: CompanyDatabase;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-data-'));
  db = openCompanyDatabase(path.join(dir, 'company.db'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A live execution body, plus the thread it belongs to. */
function seedWorker(name = '李雷') {
  const threads = new ThreadRepository(db);
  const thread = threads.createThread({ title: '测试', goal: '测试' });
  return threads.createWorker({ name, threadId: thread.id });
}

function tableNames(): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
  ).map((row) => row.name);
}

/**
 * Rebuild the file as an installation stopped at `steps` migrations, the way a
 * real old install looks — then hand it back through the normal open path.
 *
 * Winding `user_version` back on a current file is not the same thing: v31 drops
 * the org tables, so re-running v11 or v24 against it would reference tables that
 * are gone. An installation can never be in that state, so neither is the test.
 */
function upgradeFrom(target: number, seed?: (legacy: Database.Database) => void): CompanyDatabase {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(path.join(dir, `company.db${suffix}`), { force: true });
  }
  const legacy = new Database(path.join(dir, 'company.db'));
  try {
    legacy.pragma('journal_mode = WAL');
    for (let index = 0; index < target; index += 1) legacy.exec(MIGRATIONS[index]!);
    seed?.(legacy);
    legacy.pragma(`user_version = ${target}`);
  } finally {
    legacy.close();
  }
  db = openCompanyDatabase(path.join(dir, 'company.db'));
  return db;
}

describe('company.db', () => {
  it('persists an external reply target on a thread for later reports', () => {
    const threads = new ThreadRepository(db);
    const target = {
      adapterId: 'github',
      source: 'github' as const,
      address: 'github:acme/api#12',
      messageId: 'comment-1',
    };
    const thread = threads.createThread({ title: '外部线', goal: '处理评论', replyTarget: target });

    expect(threads.getThread(thread.id)?.replyTarget).toEqual(target);
    threads.addReport({ threadId: thread.id, level: 'notify', title: '完成' });
    expect(threads.listUnannouncedReports()[0]?.replyTarget).toEqual(target);
  });

  /**
   * 动作流（`09-worker-spec.md` W6）。锁两件事：读写按发生顺序，以及**裁剪之后
   * 序号留空洞**——那正是界面和 recall 用来写「略去 N 步」的依据。
   */
  it('keeps the head and tail of an action trace, and the gap survives the trim', () => {
    const threads = new ThreadRepository(db);
    const thread = threads.createThread({ title: 'trace', goal: 'trace' });
    const worker = threads.createWorker({ name: '执行体', threadId: thread.id });
    const tasks = new TaskRepository(db);
    const created = tasks.createTask(
      {
        title: '改健康检查',
        brief: 'x',
        deliverableSpec: 'x',
        assigneeId: worker.id,
        estTokens: 100,
        acceptanceCommand: ['true'],
        acceptanceTemplate: 'http-ok',
        threadId: thread.id,
      },
      'workspace/1',
      'task-trace',
    );
    expect(created.id).toBe('task-trace');

    for (let seq = 1; seq <= 300; seq += 1) {
      tasks.appendTrace({
        taskId: 'task-trace',
        seq,
        kind: 'tool',
        name: 'bash',
        argsDigest: `step ${seq}`,
      });
      tasks.pruneTrace('task-trace', 50, 200);
    }

    const rows = tasks.listTrace('task-trace', 500);
    // 头 50 + 尾 200。
    expect(rows).toHaveLength(250);
    expect(rows[0]?.seq).toBe(1);
    expect(rows.at(-1)?.seq).toBe(300);
    // 中间那一段是真的没了，不是没发生过。
    expect(rows.some((row) => row.seq === 75)).toBe(false);
    // 顺序是发生顺序（旧 → 新），界面直接往下排。
    expect(rows.map((row) => row.seq)).toEqual([...rows.map((row) => row.seq)].sort((a, b) => a - b));
  });

  /**
   * 失败分类（§3.7）。落库是为了让界面与 Router 都能回答同一个问题：
   * 这次停下是"再来一次就好"，还是"先把缺的东西补上"。
   */
  it('records the failure kind, and treats an unknown kind as unclassified', () => {
    const threads = new ThreadRepository(db);
    const thread = threads.createThread({ title: '失败分类', goal: 'g' });
    const worker = threads.createWorker({ name: '执行体', threadId: thread.id });
    const tasks = new TaskRepository(db);
    tasks.createTask(
      {
        title: '起不来的一次',
        brief: 'x',
        deliverableSpec: 'x',
        assigneeId: worker.id,
        estTokens: 100,
        acceptanceCommand: ['true'],
        acceptanceTemplate: 'http-ok',
        threadId: thread.id,
      },
      'workspace/2',
      'task-kind',
    );

    tasks.setStatus('task-kind', 'failed', { error: '未配置默认 LLM', errorKind: 'blocked' });
    expect(tasks.getTask('task-kind')?.errorKind).toBe('blocked');

    // 手改坏的 / 将来删掉的种类：读回来当"没分类"，而不是猜一个。
    db.prepare("UPDATE task SET error_kind = 'wat' WHERE id = 'task-kind'").run();
    expect(tasks.getTask('task-kind')?.errorKind).toBeUndefined();
  });

  it('applies the §4.1 pragmas and seeds one company row', () => {
    const probe = probeSqlite(db);
    expect(probe.integrity).toBe('ok');
    expect(probe.companyRows).toBe(1);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('is idempotent across reopen', () => {
    db.close();
    db = openCompanyDatabase(path.join(dir, 'company.db'));
    expect(probeSqlite(db).companyRows).toBe(1);
  });

  it('upgrades an existing database in place instead of wiping it', () => {
    // An installation stopped at v17: no thread/worker/event/report yet.
    upgradeFrom(17, (legacy) => {
      legacy
        .prepare(
          "INSERT INTO app_setting (key, value, updated_at) VALUES ('probe.keep', 'yes', 1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run();
    });
    const tables = tableNames();

    expect(tables).toContain('report');
    expect(tables).toContain('worker');
    // The point of migrating rather than recreating: existing rows survive.
    expect(db.prepare("SELECT value FROM app_setting WHERE key = 'probe.keep'").get()).toEqual({
      value: 'yes',
    });
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(SCHEMA_VERSION);
  });

  it('drops the whole org cluster once the schema reaches v31', () => {
    const tables = tableNames();

    for (const name of [
      'employee',
      'department',
      'position',
      'assignment',
      'relationship',
      'evaluation',
      'interview',
      'employee_package',
      'job',
      'employment_event',
      'agent_candidate',
      'project_group',
      // Built dynamically by repairJobCatalogue; it belongs to the same cluster.
      'department_job',
    ]) {
      expect(tables).not.toContain(name);
    }

    // The v2 tables the product actually runs on are still here.
    for (const name of ['company', 'thread', 'worker', 'task', 'event', 'report', 'memory']) {
      expect(tables).toContain(name);
    }
  });

  it('renames industry/vision to domain/goal at v34 and carries the values over', () => {
    upgradeFrom(33, (legacy) => {
      legacy
        .prepare(
          "INSERT INTO app_setting (key, value, updated_at) VALUES ('profile.vision', '把内容工作交给助手', 1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run();
      legacy
        .prepare(
          "INSERT INTO company (id, name, industry, settings, created_at, updated_at) VALUES ('company-local', '我的工作台', 'content', '{}', 1, 1) ON CONFLICT(id) DO UPDATE SET industry = 'content'",
        )
        .run();
    });

    const companyColumns = (
      db.prepare('PRAGMA table_info(company)').all() as { name: string }[]
    ).map((column) => column.name);
    expect(companyColumns).toContain('domain');
    expect(companyColumns).not.toContain('industry');

    const profile = new CompanyService(db).get();
    expect(profile.domain).toBe('content');
    expect(profile.goal).toBe('把内容工作交给助手');

    // 键是搬走的，不是复制：旧键不该留在库里。
    const keys = (
      db.prepare("SELECT key FROM app_setting WHERE key LIKE 'profile.%'").all() as { key: string }[]
    ).map((row) => row.key);
    expect(keys).not.toContain('profile.vision');
  });

  it('adds the steering column at v32 without disturbing existing tasks', () => {
    const columns = (
      db.prepare('PRAGMA table_info(task)').all() as { name: string }[]
    ).map((column) => column.name);

    // 你中途改的方向存在任务上（V32）：`brief` 是派活时说的话，不能往里追加。
    expect(columns).toContain('steering');
    // 默认 `'[]'`，所以老任务升级过来不需要回填。
    const row = db.prepare("SELECT steering AS value FROM task LIMIT 1").get() as
      | { value: string }
      | undefined;
    if (row) expect(row.value).toBe('[]');
  });

  it('does not resurrect a renamed column on the next open', () => {
    // `repairLegacyColumns` 会把历史上每一条 `ADD COLUMN` 重放一遍，而它重放的前提是
    // "这一列不存在"——改名正好制造了这个前提。不拦住的话，`worker.employee_id` 会在
    // 每次打开数据库时重新长出来，于是同一个概念永远删不干净。
    const file = path.join(dir, 'company.db');
    db.close();
    db = openCompanyDatabase(file);

    const workerColumns = (db.prepare('PRAGMA table_info(worker)').all() as { name: string }[]).map(
      (column) => column.name,
    );
    const runColumns = (
      db.prepare('PRAGMA table_info(consolidation_run)').all() as { name: string }[]
    ).map((column) => column.name);

    expect(workerColumns).toContain('owner_id');
    expect(runColumns).toContain('owner_id');
    expect(workerColumns).not.toContain('employee_id');
    expect(runColumns).not.toContain('employee_id');
  });

  it('drops a renamed column that an older build re-added', () => {
    const file = path.join(dir, 'company.db');
    // 旧版 `repairLegacyColumns` 会把 V1 里声明的 `industry` 补回来（V34 已经把它
    // 改名成 `domain`）。真实库就这么长出了两列；打开时应当收敛回一列。
    db.exec('ALTER TABLE company ADD COLUMN industry TEXT');
    db.close();
    db = openCompanyDatabase(file);

    const companyColumns = (
      db.prepare('PRAGMA table_info(company)').all() as { name: string }[]
    ).map((column) => column.name);
    expect(companyColumns).toContain('domain');
    expect(companyColumns).not.toContain('industry');
  });

  it('turns the stored user name and portrait into a single user row when upgrading to v18', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    // A v17 build kept you in `app_setting`, next to presentation preferences.
    // 键名是 `profile.bossName`：那是 v17 的写法，V18 的迁移 SQL 里读的就是这两个字面量，
    // 改它就等于改历史——历史是只读的。
    upgradeFrom(17, (legacy) => {
      legacy
        .prepare(
          "INSERT INTO app_setting (key, value, updated_at) VALUES ('profile.bossName', '阿星', 1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run();
      legacy
        .prepare(
          "INSERT INTO app_setting (key, value, updated_at) VALUES ('profile.bossAvatar', ?, 1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(png);
    });

    const rows = db.prepare('SELECT id, name, avatar FROM app_user').all() as {
      id: string;
      name: string;
      avatar: string;
    }[];
    // Exactly one human, carrying the name and portrait that were already there.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ id: 'user', name: '阿星', avatar: png });

    // And the profile reads from the row, not from the old setting.
    expect(new CompanyService(db).get().userName).toBe('阿星');

    // The legacy rows are left in place on purpose, so a one-version rollback renders.
    const legacy = db
      .prepare("SELECT value FROM app_setting WHERE key = 'profile.bossName'")
      .get() as { value: string };
    expect(legacy.value).toBe('阿星');
  });
});

describe('TaskRepository', () => {
  function setup() {
    const repository = new TaskRepository(db);
    return { repository, executor: seedWorker() };
  }

  function createTask(repository: TaskRepository, assigneeId: string, id = `task-${Math.random()}`) {
    return repository.createTask(
      {
        title: '返回 ok 的 HTTP 服务',
        brief: '用 node 内置 http',
        deliverableSpec: 'server.js 返回 ok',
        assigneeId,
        estTokens: 1000,
        acceptanceCommand: ['node', '{checks}/verify.mjs'],
        acceptanceTemplate: 'http-ok',
      },
      taskWorkspaceRelPath(id),
      id,
    );
  }

  it('records an artifact with its hash and reads it back with the task', () => {
    const { executor, repository } = setup();
    const task = createTask(repository, executor.id);
    const workspace = path.join(dir, 'workspace', task.workspaceRelPath);
    mkdirSync(workspace, { recursive: true });
    const file = path.join(workspace, 'server.js');
    writeFileSync(file, 'console.log("ok")\n');

    repository.addArtifact(task.id, 'server.js', file);
    repository.addStep(task.id, '第 1 次尝试');
    repository.addAcceptance(task.id, {
      verdict: 'pass',
      reason: '退出码 0',
      evidence: {
        command: ['node', 'checks/verify.mjs'],
        exitCode: 0,
        stdoutTail: 'ok',
        stderrTail: '',
        durationMs: 12,
      },
    });

    const stored = repository.getTask(task.id);
    expect(stored?.artifacts).toHaveLength(1);
    expect(stored?.artifacts[0]?.sha256).toHaveLength(64);
    expect(stored?.acceptance?.verdict).toBe('pass');
    expect(stored?.attempts).toBe(1);
    expect(stored?.steps.map((step) => step.text)).toEqual(['第 1 次尝试']);
  });

  it('links a manager sign-off and counts it as a review', () => {
    const { executor, repository } = setup();
    const task = createTask(repository, executor.id);
    const reviewId = 'task-review';
    repository.createTask(
      {
        title: `验收：${task.title}`,
        brief: '判定是否达标',
        deliverableSpec: 'verdict.json',
        assigneeId: executor.id,
        estTokens: 500,
        acceptanceCommand: ['node', '{checks}/verify.mjs'],
        acceptanceTemplate: 'review-verdict',
      },
      taskWorkspaceRelPath(reviewId),
      reviewId,
    );

    repository.markAsReview(reviewId, task.id);
    expect(repository.getTask(reviewId)?.isReview).toBe(true);
    expect(repository.listReviews(task.id).map((entry) => entry.id)).toEqual([reviewId]);
  });

  it('exposes exactly the tasks a restarted process must reconcile', () => {
    const { executor, repository } = setup();
    const open = createTask(repository, executor.id, 'task-open');
    const running = createTask(repository, executor.id, 'task-running');
    repository.setStatus(running.id, 'running', { startedAt: Date.now(), error: null });

    expect(repository.listPending().map((task) => task.id).sort()).toEqual(
      [open.id, running.id].sort(),
    );
    expect(repository.listRunning().map((task) => task.id)).toEqual([running.id]);
  });
});

describe('MemoryService', () => {
  it("never returns another line's memory", async () => {
    const worker = seedWorker();
    const memory = new MemoryService(db);
    const mine = seedWorker('小王').threadId!;
    const theirs = seedWorker('小李').threadId!;

    await memory.remember({
      ownerId: worker.id,
      kind: 'experience',
      content: '上线前先跑一遍冒烟脚本，避免端口冲突',
      scope: { type: 'thread', id: mine },
      sourceType: 'task',
    });

    const ownLine = await memory.retrieve({
      owners: [worker.id],
      query: '冒烟脚本',
      scopes: [{ type: 'thread', id: mine }],
      limit: 3,
    });
    expect(ownLine).toHaveLength(1);

    // 同一个执行体、另一条线：那条线的经验不该出现在这里。
    const otherLine = await memory.retrieve({
      owners: [worker.id],
      query: '冒烟脚本',
      scopes: [{ type: 'thread', id: theirs }],
      limit: 3,
    });
    expect(otherLine).toHaveLength(0);
  });
});

/**
 * A task can belong to a v2 line of work.
 *
 * What matters here is that the thread survives the FK, and that dropping a
 * thread does not take its tasks with it.
 */
describe('task ↔ thread', () => {
  function setup() {
    const repository = new TaskRepository(db);
    const threads = new ThreadRepository(db);
    const thread = threads.createThread({ title: '测试', goal: '测试' });
    const executor = threads.createWorker({ name: '李雷', threadId: thread.id });
    return { repository, threads, executor };
  }

  function draft(assigneeId: string, threadId?: string) {
    return {
      title: '整理 Q3 财报',
      brief: '读三份 PDF',
      deliverableSpec: '一页摘要',
      assigneeId,
      estTokens: 1000,
      acceptanceCommand: ['node', '{checks}/verify.mjs'],
      acceptanceTemplate: 'http-ok' as const,
      ...(threadId ? { threadId } : {}),
    };
  }

  it('keeps the thread a task was created for', () => {
    const { executor, repository, threads } = setup();
    const thread = threads.createThread({ title: '整理 Q3 财报' });
    const task = repository.createTask(
      draft(executor.id, thread.id),
      taskWorkspaceRelPath('task-t1'),
      'task-t1',
    );
    expect(task.threadId).toBe(thread.id);
    expect(repository.getTask('task-t1')?.threadId).toBe(thread.id);
  });

  it('leaves threadId absent for work that never belonged to a goal', () => {
    const { executor, repository } = setup();
    const task = repository.createTask(
      draft(executor.id),
      taskWorkspaceRelPath('task-t2'),
      'task-t2',
    );
    expect(task.threadId).toBeUndefined();
  });

  it('nulls the link instead of blocking when a thread is deleted', () => {
    const { executor, repository, threads } = setup();
    const thread = threads.createThread({ title: '临时线索' });
    repository.createTask(draft(executor.id, thread.id), taskWorkspaceRelPath('task-t3'), 'task-t3');

    db.prepare('DELETE FROM thread WHERE id = ?').run(thread.id);

    // The task survives: the work happened, and hiding it would be a lie.
    expect(repository.getTask('task-t3')).toBeDefined();
    expect(repository.getTask('task-t3')?.threadId).toBeUndefined();
  });
});
