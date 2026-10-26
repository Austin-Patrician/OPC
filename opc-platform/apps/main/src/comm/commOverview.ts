import type { Message } from '@opc/shared/domain';
import type {
  CommGuardView,
  CommInboxView,
  CommOverview,
  CommQuotaView,
  CommRelationshipView,
} from '@opc/shared/ipc';
import type { OrgService } from '../org/orgService';
import type { CommService } from './commService';

export interface CommOverviewDeps {
  comm: CommService;
  org: OrgService;
  /** Injected: the preview must come from the message table, like everything else. */
  readTranscript: (conversationId: string) => Message[];
  now?: () => number;
  limit?: number;
}

/** How much of a message the list shows before it is cut. */
const PREVIEW_CHARS = 90;

/**
 * The read model behind `/notifications`.
 *
 * It exists because Step 1 made suppression and waiting visible in the database but
 * not to the boss: an inbox nobody can see is not "保留可见性", it is a log file. The
 * overview is a plain projection — no business rules, no writes.
 */
export function buildCommOverview(deps: CommOverviewDeps): CommOverview {
  const now = deps.now?.() ?? Date.now();
  const limit = deps.limit ?? 200;
  const everyone = deps.org.everyone();
  const nameOf = (id: string): string => everyone.find((member) => member.id === id)?.name ?? id;

  const inbox: CommInboxView[] = deps.comm.inboxAll(limit).map((item) => {
    const view: CommInboxView = {
      id: item.id,
      employeeId: item.employeeId,
      employeeName: nameOf(item.employeeId),
      sourceType: item.sourceType,
      priority: item.priority,
      requiresWake: item.requiresWake,
      createdAt: item.createdAt,
    };
    if (item.conversationId) view.conversationId = item.conversationId;

    if (item.sourceType === 'message' && item.conversationId) {
      const source = deps
        .readTranscript(item.conversationId)
        .find((message) => message.id === item.sourceId);
      if (source) {
        view.fromName = source.senderName;
        view.preview = previewOf(source.text ?? '');
      }
    }
    return view;
  });

  const guards: CommGuardView[] = deps.comm.guards(undefined, limit).map((guard) => {
    const view: CommGuardView = {
      id: guard.id,
      employeeId: guard.employeeId,
      employeeName: nameOf(guard.employeeId),
      kind: guard.kind,
      detail: flattenDetail(guard.detail, nameOf),
      createdAt: guard.createdAt,
    };
    if (guard.conversationId) view.conversationId = guard.conversationId;
    return view;
  });

  const relationships: CommRelationshipView[] = deps.comm.relationships().map((edge) => ({
    id: edge.id,
    fromEmployeeId: edge.fromEmployeeId,
    fromName: nameOf(edge.fromEmployeeId),
    toEmployeeId: edge.toEmployeeId,
    toName: nameOf(edge.toEmployeeId),
    kind: edge.kind,
    strength: edge.strength,
    interactionCount: edge.interactionCount,
    ...(edge.lastInteractionAt ? { lastInteractionAt: edge.lastInteractionAt } : {}),
  }));

  const quotas: CommQuotaView[] = deps.comm.activeEmployees().map((employee) => {
    const quota = deps.comm.quota(employee.id, now);
    return {
      employeeId: employee.id,
      employeeName: employee.name,
      limit: quota.limit,
      used: quota.used,
      remaining: quota.remaining,
    };
  });

  return { generatedAt: now, inbox, guards, relationships, quotas };
}

function previewOf(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > PREVIEW_CHARS ? `${clean.slice(0, PREVIEW_CHARS)}…` : clean;
}

/**
 * Guard details are `unknown` JSON straight from the row. Only primitives are kept
 * (the renderer prints them), and any id gets a resolved name next to it, so the
 * page never shows a raw uuid where a person is meant.
 */
function flattenDetail(
  detail: Record<string, unknown>,
  nameOf: (id: string) => string,
): Readonly<Record<string, string | number | boolean>> {
  const flat: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (typeof value === 'string') flat[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') flat[key] = value;
  }

  for (const [idKey, nameKey] of [
    ['fromEmployeeId', 'fromName'],
    ['toEmployeeId', 'toName'],
  ] as const) {
    const id = flat[idKey];
    if (typeof id === 'string' && flat[nameKey] === undefined) flat[nameKey] = nameOf(id);
  }

  return flat;
}
