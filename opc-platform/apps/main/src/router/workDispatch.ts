import type {
  AcceptanceTemplate,
  CreateTaskInput,
  CreateTaskResult,
  WorkerTemplate,
  WorkTask,
} from '@opc/shared/domain';
import { inferTemplate } from '../work/workerPool';
import { UNVERIFIED_GATE as NO_GATE } from '../work/acceptanceGate';
import type { DispatchInput, DispatchOutcome } from './router';

/**
 * Turns an accepted event into real work through the existing task pipeline.
 *
 * This is the seam between the v2 router and the v1 executor: the router decides
 * *whether* something is worth doing, the task pipeline is what actually does it
 * (workspace, pi loop, acceptance command, budget, artifacts). Nothing here
 * re-implements any of that.
 *
 * The mapping back to the boss is the product decision, and it is deliberate:
 *
 * - **verifiable and passed** → `delivered` → the thread closes quietly. The boss
 *   asked for something and got it; being told is noise.
 * - **produced but not automatically verifiable / did not pass** → `needs-decision`.
 *   This is §16.3② ("验收的最后一公里") made explicit instead of being papered over
 *   with a fake pass.
 * - **never ran** → `failed`.
 */

export interface WorkDispatchDeps {
  createTask: (input: CreateTaskInput) => CreateTaskResult;
  runTaskAndWait: (taskId: string) => Promise<WorkTask>;
  /**
   * Who executes this event's work.
   *
   * Returns the execution body to use — both the person whose tools/model apply
   * and the worker row that owns the runtime. `null` means nobody can take it.
   */
  resolveWorker: (input: { threadId: string; template: WorkerTemplate; hint: string }) =>
    | { employeeId: string; workerId: string }
    | null;
  /** Free-token estimate charged before the run; the ledger settles the real cost. */
  estTokens?: number;
}

const DEFAULT_EST_TOKENS = 20_000;


const TEMPLATES: readonly AcceptanceTemplate[] = ['http-ok', 'node-test', 'image-200', 'review-verdict'];

export function createWorkDispatch(deps: WorkDispatchDeps) {
  return async ({ thread, event }: DispatchInput): Promise<DispatchOutcome> => {
    const payload = event.payload;
    const goal = thread.goal.trim() || thread.title.trim();

    const workerTemplate = isTemplate(payload.template)
      ? payload.template
      : inferTemplate(`${thread.title} ${goal}`);
    const picked = deps.resolveWorker({
      threadId: thread.id,
      template: workerTemplate,
      hint: `${thread.title} ${goal}`,
    });
    if (!picked) {
      return { status: 'failed', reason: '没有可用的执行者：先在设置里配一个能跑的模型' };
    }
    const command = stringList(payload.acceptanceCommand);
    // No command = no machine-checkable definition of done. We say so instead of
    // inventing one: the run still happens, the result still reaches the boss.
    const verified = command.length > 0;
    const template = TEMPLATES.includes(payload.acceptanceTemplate as AcceptanceTemplate)
      ? (payload.acceptanceTemplate as AcceptanceTemplate)
      : 'http-ok';

    const created = deps.createTask({
      title: thread.title,
      brief: typeof payload.brief === 'string' && payload.brief.trim() ? payload.brief : goal,
      deliverableSpec:
        typeof payload.deliverableSpec === 'string' && payload.deliverableSpec.trim()
          ? payload.deliverableSpec
          : goal,
      assigneeId: picked.employeeId,
      workerId: picked.workerId,
      estTokens: numberOr(payload.estTokens, deps.estTokens ?? DEFAULT_EST_TOKENS),
      acceptanceCommand: verified ? command : [...NO_GATE],
      acceptanceTemplate: template,
      threadId: thread.id,
    });

    if (!created.ok) {
      // Budget refusal is not a crash: it is a decision the boss has to make.
      return { status: 'needs-decision', question: created.error.message };
    }

    const final = await deps.runTaskAndWait(created.task.id);
    return toOutcome(final, verified);
  };
}

/**
 * Every outcome from here is already reported: the task pipeline writes the
 * line-of-work report (`WorkService.reportToThread`) with the real artifacts and
 * verdict in hand. The router only mirrors the state.
 */
function toOutcome(task: WorkTask, verified: boolean): DispatchOutcome {
  return { ...mapOutcome(task, verified), alreadyReported: true };
}

function mapOutcome(task: WorkTask, verified: boolean): DispatchOutcome {
  switch (task.status) {
    case 'accepted':
      // Two different endings wear the same status. With a real gate, "accepted"
      // means the work was proven; without one it only means something landed.
      return verified
        ? { status: 'delivered', summary: summarise(task) }
        : {
            status: 'needs-decision',
            question: `做完了，但我没有可执行的验收条件，判定不了对错。${summarise(task)}`,
          };
    case 'delivered':
      // `delivered` means the boss already signed it off; either way it is done.
      return { status: 'delivered', summary: summarise(task) };
    case 'rejected':
      return {
        status: 'needs-decision',
        question: `自动验收没过：${task.acceptance?.reason ?? '验收命令未通过'}`,
      };
    case 'review':
      return { status: 'needs-decision', question: '执行完停在负责人验收，需要你决定是否继续' };
    default:
      return { status: 'failed', reason: task.error ?? `任务停在 ${task.status}` };
  }
}

function summarise(task: WorkTask): string {
  const files = task.artifacts.map((artifact) => artifact.relPath);
  return files.length > 0 ? `产出：${files.join('、')}` : '没有产出文件';
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function isTemplate(value: unknown): value is WorkerTemplate {
  return value === 'code' || value === 'research' || value === 'ops';
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
