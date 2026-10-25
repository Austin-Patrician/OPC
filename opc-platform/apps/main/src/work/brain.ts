import type { WorkTask } from '@opc/shared/domain';
import { writeFileWithin } from './workspace';

export interface AcceptanceFeedback {
  attempt: number;
  reason: string;
  evidence: { exitCode: number | null; stdoutTail: string; stderrTail: string; command: string[] };
}

export interface BrainContext {
  task: WorkTask;
  workspaceDir: string;
  /** Id of the durable task that owns this attempt (for child conversations). */
  durableTaskId?: string;
  /** Set on every attempt after the first: what the system observed when it failed. */
  feedback?: AcceptanceFeedback;
  /** Append a human-readable step (persisted to SQLite and the pi transcript). */
  log: (text: string) => void;
  /** Report real spend (tokens + USD) so the budget ledger charges it. */
  reportUsage?: (usage: {
    input: number;
    output: number;
    total: number;
    costUsd?: number;
  }) => void;
}

/**
 * The employee's "brain": produce the deliverable files in the workspace.
 *
 * Deliberately an interface. Today it is a deterministic scripted brain, which
 * makes the pipeline (workspace guard → execution → acceptance → evidence)
 * verifiable without an API key. The model-backed implementation plugs in here
 * without touching the runner, acceptance or UI.
 */
export interface TaskBrain {
  readonly name: string;
  /** Attempts allowed including the first; a repair costs one more attempt. */
  readonly maxAttempts?: number;
  execute(context: BrainContext): Promise<void>;
}

const SERVER_JS = `const http = require('node:http');

const port = Number(process.env.PORT || 3000);

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

server.listen(port, '127.0.0.1', () => {
  console.log('listening on ' + port);
});
`;

const SERVER_JS_BROKEN = SERVER_JS.replace("res.end('ok');", "res.end('nope');");

/**
 * Deterministic implementation used by the Phase 0 slice.
 * It really writes a working server; the acceptance gate really starts it.
 *
 * `OPC_BRAIN_VARIANT=broken` emits a deliberately wrong deliverable, so the
 * negative path ("the gate actually rejects") can be verified instead of assumed.
 */
export const scriptedBrain: TaskBrain = {
  name: 'scripted',
  maxAttempts: 3,
  async execute({ task, workspaceDir, log, feedback }) {
    const variant = process.env.OPC_BRAIN_VARIANT ?? 'ok';
    // `repair` writes a wrong deliverable first, then fixes it from the evidence —
    // a deterministic way to prove the repair loop without relying on a model.
    const broken = variant === 'broken' || (variant === 'repair' && !feedback);

    const delay = Number(process.env.OPC_BRAIN_SLEEP_MS ?? 0);
    if (delay > 0) {
      log(`模拟慢执行（${delay}ms）`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    log(`读取任务：${task.title}`);
    // Review tasks are judged on a machine-readable verdict, not on a server file.
    if (task.acceptanceTemplate === 'review-verdict') {
      const verdict = process.env.OPC_REVIEW_VERDICT === 'revise' ? 'revise' : 'pass';
      const reason =
        verdict === 'revise' ? '缺少 README，请补充使用说明后重新提交' : '产物可运行，符合交付要求';
      writeFileWithin(workspaceDir, 'verdict.json', JSON.stringify({ verdict, reason }, null, 2));
      log(`已写入 verdict.json（${verdict}），交由系统校验`);
      return;
    }
    log(`核对交付物：${task.deliverableSpec}`);
    if (feedback) {
      log(`根据验收证据修复：${feedback.reason}`);
      log(`证据：退出码 ${feedback.evidence.exitCode ?? 'null'} · ${feedback.evidence.stdoutTail.split('\n')[0] ?? ''}`);
    }
    log(broken ? '生成 server.js（故意返回错误内容，用于验证验收不通过）' : '生成 server.js（node:http，无外部依赖）');
    writeFileWithin(workspaceDir, 'server.js', broken ? SERVER_JS_BROKEN : SERVER_JS);
    log('已写入 server.js，交由系统验收');
  },
};
