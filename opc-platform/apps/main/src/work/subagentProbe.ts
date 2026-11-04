import { readdirSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { AppPaths } from '../env';
import type { CompanyDatabase } from '../data/companyDatabase';
import type { ModelConfigService } from '../models/modelConfigService';

/**
 * 探针：子代理走完整条链路（`09-team.md` §8 的验收）。
 *
 * 要验的不是"类型对得上"，是**模型会不会在子会话里真的跑完一轮**：父任务在跑，工具
 * 里开了一个归它所有的子会话，子会话用自己的上下文查一件事，父拿回结论继续干，最后
 * 父的交付物通过真闸门。
 *
 * 用临时库和临时目录：探针失败不能污染真库，也不能往任何人的 `agents/` 里写会话。
 * 模型配置来自真库（那是唯一不能造的东西）。
 */

export interface WorkSubagentProbeResult {
  ok: boolean;
  model: { providerId: string; modelId: string } | null;
  taskStatus: string;
  /** 模型有没有真的派子代理。没派时其余字段都没有意义。 */
  investigated: boolean;
  /** 子代理回来时说了什么（步骤流里那一行）。 */
  answerLine: string;
  /** 父的交付物过没过闸门。 */
  verdict: string | null;
  artifacts: string[];
  tokensUsed: number;
  /** 会话文件：子会话是不是留在了**执行体自己那份存储**里。 */
  agentStores: string[];
  elapsedMs: number;
  steps: string[];
  error?: string;
}

const STORE_TIMEOUT_MS = 5 * 60_000;

export async function probeWorkSubagent(input: {
  modelConfig: ModelConfigService;
  /** 临时目录，探针自己建。 */
  root: string;
}): Promise<WorkSubagentProbeResult> {
  const startedAt = Date.now();
  const result: WorkSubagentProbeResult = {
    ok: false,
    model: null,
    taskStatus: 'not-started',
    investigated: false,
    answerLine: '',
    verdict: null,
    artifacts: [],
    tokensUsed: 0,
    agentStores: [],
    elapsedMs: 0,
    steps: [],
  };

  const { openCompanyDatabase } = await import('../data/companyDatabase');
  const { ThreadRepository } = await import('../data/threadRepository');
  const { WorkService } = await import('./workService');

  const paths: AppPaths = {
    userData: input.root,
    database: path.join(input.root, 'company.db'),
    agentsDir: path.join(input.root, 'agents'),
    artifactsDir: path.join(input.root, 'artifacts'),
    workspaceDir: path.join(input.root, 'workspace'),
    logsDir: path.join(input.root, 'logs'),
    probeDir: path.join(input.root, 'probe'),
    cacheDir: path.join(input.root, 'cache'),
  };
  for (const dir of [paths.agentsDir, paths.artifactsDir, paths.workspaceDir, paths.logsDir]) {
    mkdirSync(dir, { recursive: true });
  }

  let db: CompanyDatabase | null = null;
  let work: InstanceType<typeof WorkService> | null = null;
  try {
    db = openCompanyDatabase(paths.database);
    const threads = new ThreadRepository(db);
    const home = threads.createThread({ title: '探针工作台', goal: '探针' });
    const executor = threads.createWorker({ name: '探针执行体', threadId: home.id });

    const llm = input.modelConfig.getDefaults().llm;
    result.model = llm;

    work = new WorkService({
      db,
      paths,
      upsertTaskCard: () => undefined,
      modelConfig: input.modelConfig,
    });

    const thread = threads.createThread({ title: '查一件事，再写一个服务' });
    const created = work.createTask({
      title: '先查清最小 http 服务要几行，再写 server.js',
      // 这句话逼出 `investigate`：它是本题唯一"查了才能写"的路径。
      brief:
        '先用 investigate 工具派一个子代理查清「node 内置 http 模块起一个最小服务器需要几行代码」，' +
        '拿到结论之后再自己写 server.js。不要凭记忆直接写。',
      deliverableSpec: 'server.js 监听 3000 并返回 ok',
      assigneeId: executor.id,
      estTokens: 20_000,
      acceptanceCommand: ['node', '{checks}/verify.mjs'],
      acceptanceTemplate: 'http-ok',
      threadId: thread.id,
    });
    if (!created.ok) throw new Error(created.error.message);

    const deadline = Date.now() + STORE_TIMEOUT_MS;
    let finished = await work.runTaskAndWait(created.task.id);
    while (Date.now() < deadline && ['open', 'running'].includes(finished.status)) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      finished = work.getTask(finished.id) ?? finished;
    }

    const steps = finished.steps.map((step) => step.text);
    result.taskStatus = finished.status;
    result.steps = steps.slice(-20);
    result.investigated =
      steps.some((text) => text.startsWith('[查 1]')) &&
      steps.some((text) => text.includes('回来了'));
    result.answerLine = steps.find((text) => text.includes('回来了')) ?? '';
    result.verdict = finished.acceptance?.verdict ?? null;
    result.artifacts = finished.artifacts.map((artifact) => artifact.relPath);
    result.tokensUsed = finished.tokensUsed;

    // 子会话应该在**执行体自己那份存储**里，而不是某个 `--sub.sqlite`。
    // 只数 `.sqlite`：`-wal` / `-shm` 是同一份存储的伴生文件，不是第二份。
    try {
      result.agentStores = readdirSync(paths.agentsDir).filter((name) => name.endsWith('.sqlite'));
    } catch {
      result.agentStores = [];
    }

    result.ok =
      result.investigated && result.taskStatus === 'accepted' && result.agentStores.length === 1;
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  } finally {
    await work?.dispose().catch(() => undefined);
    db?.close();
    result.elapsedMs = Date.now() - startedAt;
    rmSync(input.root, { recursive: true, force: true });
  }
}
