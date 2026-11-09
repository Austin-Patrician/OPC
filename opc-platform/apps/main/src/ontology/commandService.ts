import type { CreateTaskInput } from '@opc/shared/domain';
import type { CompanyDatabase } from '../data/companyDatabase';
import type { CompanyService } from '../company/companyService';
import type { WorkService } from '../work/workService';
import type { ContextGraphStore, OntologyCommand, OntologyEntity } from './types';

export interface OntologyCommandServiceDeps {
  db: CompanyDatabase;
  graph: ContextGraphStore;
  work: WorkService;
  company: CompanyService;
  /** Existing approval-card surface. Return an approval id when a card was created. */
  requestApproval?: (input: { command: OntologyCommand; reason: string }) => string | null;
  onApprovalResolved?: (command: OntologyCommand, state: 'approved' | 'rejected' | 'failed') => void;
}

export interface ExecuteCommandInput {
  actor: OntologyCommand['actor'];
  objectType: string;
  objectId: string;
  action: string;
  args?: unknown;
  expectedVersion?: number;
  idempotencyKey: string;
  approvalId?: string;
}

export type ExecuteCommandResult =
  | { ok: true; command: OntologyCommand; result: unknown }
  | { ok: false; command: OntologyCommand; error: string };

const RISKY_ACTIONS = new Set(['create_task', 'delegate_task', 'approve_tool']);

/**
 * The single write boundary for ontology actions. It deliberately delegates
 * business mutations to the existing services, so task/worker/approval tables
 * remain authoritative and ontology rows only describe the resulting context.
 */
export class OntologyCommandService {
  constructor(private readonly deps: OntologyCommandServiceDeps) {}

  transition(commandId: string, status: OntologyCommand['status'], result?: unknown, error?: string): OntologyCommand | null {
    const command = this.deps.graph.transitionCommand(commandId, status, result, error);
    if (command && (status === 'succeeded' || status === 'failed' || status === 'rejected')) {
      if (command.approvalId) this.deps.onApprovalResolved?.(command, status === 'succeeded' ? 'approved' : status === 'failed' ? 'failed' : 'rejected');
    }
    return command;
  }

  async approve(commandId: string): Promise<ExecuteCommandResult> {
    const command = this.deps.graph.getCommand(commandId);
    if (!command) return { ok: false, command: { commandId, actor: 'user', objectType: '', objectId: '', action: '', args: {}, expectedVersion: null, idempotencyKey: '', status: 'rejected', approvalId: null, result: null, error: '命令不存在', createdAt: 0, updatedAt: 0, completedAt: null }, error: '命令不存在' };
    if (command.status === 'pending' && !command.approvalId) {
      return { ok: false, command, error: '命令没有绑定待处理审批，不能直接批准' };
    }
    if (command.status === 'pending') this.deps.graph.transitionCommand(commandId, 'approved');
    return this.execute({ actor: command.actor, objectType: command.objectType, objectId: command.objectId, action: command.action, args: command.args, expectedVersion: command.expectedVersion ?? undefined, idempotencyKey: command.idempotencyKey, approvalId: command.approvalId ?? commandId });
  }

  async execute(input: ExecuteCommandInput): Promise<ExecuteCommandResult> {
    let command = this.deps.graph.enqueueCommand({ ...input, args: input.args ?? {}, expectedVersion: input.expectedVersion ?? null });
    if (input.approvalId && !command.approvalId) {
      command = this.deps.graph.attachCommandApproval(command.commandId, input.approvalId) ?? command;
    }
    if (['succeeded', 'failed', 'rejected'].includes(command.status)) {
      return command.status === 'succeeded'
        ? { ok: true, command, result: command.result }
        : { ok: false, command, error: command.error ?? `命令已${command.status}` };
    }

    const authorization = this.authorize(command);
    if (!authorization.ok) {
      const rejected = this.transition(command.commandId, 'rejected', undefined, authorization.error)!;
      return { ok: false, command: rejected, error: authorization.error };
    }

    if (RISKY_ACTIONS.has(command.action) && command.actor !== 'user' && !command.approvalId) {
      let approvalId: string | null;
      try {
        approvalId = this.deps.requestApproval?.({ command, reason: `命令 ${command.action} 需要用户确认` }) ?? null;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failed = this.transition(command.commandId, 'failed', undefined, `审批卡创建失败：${message}`)!;
        return { ok: false, command: failed, error: failed.error ?? message };
      }
      if (!approvalId) {
        return { ok: false, command, error: '等待用户审批' };
      }
      command = this.deps.graph.attachCommandApproval(command.commandId, approvalId) ?? command;
      if (!command.approvalId) {
        const failed = this.transition(command.commandId, 'failed', undefined, '审批绑定失败')!;
        return { ok: false, command: failed, error: failed.error ?? '审批绑定失败' };
      }
      return { ok: false, command, error: `等待用户审批：${approvalId}` };
    }

    try {
      this.checkExpectedVersion(command);
      this.deps.graph.transitionCommand(command.commandId, 'running');
      const result = await this.apply(command);
      const done = this.transition(command.commandId, 'succeeded', result)!;
      return { ok: true, command: done, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = this.transition(command.commandId, 'failed', undefined, message)!;
      return { ok: false, command: failed, error: message };
    }
  }

  private authorize(command: OntologyCommand): { ok: true } | { ok: false; error: string } {
    if (!command.actor || !['user', 'router', 'worker'].includes(command.actor)) return { ok: false, error: '非法命令主体' };
    if (!command.objectType.trim() || !command.objectId.trim()) return { ok: false, error: '命令对象不能为空' };
    if (!command.action.trim()) return { ok: false, error: '命令动作不能为空' };
    if (command.actor === 'worker' && ['update_preference', 'approve_tool'].includes(command.action)) {
      return { ok: false, error: 'Worker 无权修改用户偏好或审批工具' };
    }
    return { ok: true };
  }

  private checkExpectedVersion(command: OntologyCommand): void {
    if (command.expectedVersion === null) return;
    const row = this.deps.db.prepare('SELECT version FROM ontology_entity WHERE id = ?').get(command.objectId) as { version: number } | undefined;
    if (!row) throw new Error(`对象不存在：${command.objectId}`);
    if (row.version !== command.expectedVersion) throw new Error(`对象版本冲突：期望 ${command.expectedVersion}，实际 ${row.version}`);
  }

  private async apply(command: OntologyCommand): Promise<unknown> {
    const args = (command.args && typeof command.args === 'object' ? command.args : {}) as Record<string, unknown>;
    switch (command.action) {
      case 'update_goal': {
        const entity = this.requireEntity(command.objectId, 'Goal');
        const name = typeof args.name === 'string' ? args.name : entity.canonicalName;
        const updated = this.deps.graph.ensureEntity({ id: entity.id, entityType: 'Goal', canonicalName: name, description: typeof args.description === 'string' ? args.description : entity.description, properties: typeof args.properties === 'object' && args.properties !== null ? args.properties as Record<string, unknown> : entity.properties });
        return updated;
      }
      case 'update_preference': {
        const value = typeof args.value === 'string' ? args.value : JSON.stringify(args.value ?? '');
        const episode = this.deps.graph.appendEpisode({ sourceType: 'ontology.command', sourceId: command.commandId, actor: command.actor, content: value, metadata: { action: command.action } });
        return this.deps.graph.assertFact({ subjectEntityId: 'ontology-user', predicate: 'prefers', objectValue: value, sourceEpisodeId: episode.id, confidence: 1 });
      }
      case 'retract_assertion': {
        if (typeof args.assertionId !== 'string') throw new Error('retract_assertion 需要 assertionId');
        const episode = this.deps.graph.appendEpisode({ sourceType: 'ontology.command', sourceId: command.commandId, actor: command.actor, content: `撤回断言 ${args.assertionId}` });
        return this.deps.graph.retractAssertion(args.assertionId, episode.id);
      }
      case 'create_task':
      case 'delegate_task': {
        const input = args.input;
        if (!input || typeof input !== 'object') throw new Error(`${command.action} 需要 input`);
        const created = this.deps.work.createTask(input as CreateTaskInput);
        if (!created.ok) throw new Error(created.error.message);
        return created.task;
      }
      case 'create_project': {
        const name = typeof args.name === 'string' ? args.name.trim() : '';
        if (!name) throw new Error('create_project 需要 name');
        return this.deps.graph.ensureEntity({ entityType: 'Project', canonicalName: name, description: typeof args.description === 'string' ? args.description : '' });
      }
      case 'approve_tool': {
        if (typeof args.reportId !== 'string') throw new Error('approve_tool 需要 reportId');
        return this.deps.work.answerFor({ reportId: args.reportId, text: '', allow: true });
      }
      default:
        throw new Error(`不支持的 Ontology 动作：${command.action}`);
    }
  }

  private requireEntity(id: string, type: OntologyEntity['entityType']): OntologyEntity {
    const entity = this.deps.graph.resolveEntity(id, type);
    if (!entity || entity.entityType !== type) throw new Error(`找不到 ${type}：${id}`);
    return entity;
  }
}
