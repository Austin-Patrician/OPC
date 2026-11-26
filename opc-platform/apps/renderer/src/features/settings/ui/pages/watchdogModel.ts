import type {
  WatchdogActionView,
  WatchdogIncidentView,
  WatchdogPolicyView,
} from '@opc/shared/ipc';

export type WatchdogTab = 'monitor' | 'rules';
export type IncidentViewFilter = 'open' | 'resolved';

export type IncidentStateTone = 'red' | 'blue' | 'amber' | 'gray';
export type SemanticTone = 'green' | 'amber' | 'red' | 'blue' | 'gray';

export type IncidentKindKey =
  | 'repeatFailure'
  | 'noProgress'
  | 'mainUnresponsive'
  | 'mcpConnectFailed'
  | 'routerSessionFailed'
  | 'processUncleanExit'
  | 'watchdogUnresponsive'
  | 'watchdogSpawnFailed'
  | 'watchdogDbUnavailable'
  | 'watchdogExited'
  | 'watchdogProcess'
  | 'other';

export type VerdictKey =
  | 'progressing'
  | 'stalled'
  | 'looping'
  | 'deviating'
  | 'insufficientEvidence'
  | 'other';

export type JudgedByKey = 'child' | 'parent' | null;
export type SubjectTypeKey = 'task' | 'mcp' | 'process' | 'other';
export type ActionNameKey = 'mcpReconnect' | 'other';

/** Human-friendly policy editor state (minutes / seconds instead of ms). */
export interface WatchdogPolicyDraft {
  enabled: boolean;
  idleMinutes: number;
  repeatFailure: number;
  staleSeconds: number;
  recheckMinutes: number;
  escalateMinutes: number;
  judgeMinutes: number;
  actionMinutes: number;
}

export const WATCHDOG_POLICY_RANGES = {
  idleMinutes: { min: 5, max: 1440 },
  repeatFailure: { min: 2, max: 20 },
  staleSeconds: { min: 30, max: 1800 },
  recheckMinutes: { min: 1, max: 360 },
  escalateMinutes: { min: 2, max: 1440 },
  judgeMinutes: { min: 1, max: 1440 },
  actionMinutes: { min: 1, max: 1440 },
} as const;

/** Mirrors backend `DEFAULT_WATCHDOG_POLICY` so resetting yields deterministic defaults. */
export const DEFAULT_WATCHDOG_DRAFT: WatchdogPolicyDraft = {
  enabled: true,
  idleMinutes: 30,
  repeatFailure: 3,
  staleSeconds: 90,
  recheckMinutes: 2,
  escalateMinutes: 15,
  judgeMinutes: 30,
  actionMinutes: 10,
};

const MINUTE_MS = 60_000;

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.round(Math.min(max, Math.max(min, value)));
}

export function toWatchdogDraft(policy: WatchdogPolicyView): WatchdogPolicyDraft {
  return {
    enabled: policy.enabled,
    idleMinutes: clampInt(
      Math.round(policy.idleTaskMs / MINUTE_MS),
      WATCHDOG_POLICY_RANGES.idleMinutes.min,
      WATCHDOG_POLICY_RANGES.idleMinutes.max,
    ),
    repeatFailure: clampInt(
      policy.repeatFailure,
      WATCHDOG_POLICY_RANGES.repeatFailure.min,
      WATCHDOG_POLICY_RANGES.repeatFailure.max,
    ),
    staleSeconds: clampInt(
      Math.round(policy.staleMainMs / 1000),
      WATCHDOG_POLICY_RANGES.staleSeconds.min,
      WATCHDOG_POLICY_RANGES.staleSeconds.max,
    ),
    recheckMinutes: clampInt(
      Math.round(policy.recheckAfterMs / MINUTE_MS),
      WATCHDOG_POLICY_RANGES.recheckMinutes.min,
      WATCHDOG_POLICY_RANGES.recheckMinutes.max,
    ),
    escalateMinutes: clampInt(
      Math.round(policy.escalateAfterMs / MINUTE_MS),
      WATCHDOG_POLICY_RANGES.escalateMinutes.min,
      WATCHDOG_POLICY_RANGES.escalateMinutes.max,
    ),
    judgeMinutes: clampInt(
      Math.round(policy.judgeCooldownMs / MINUTE_MS),
      WATCHDOG_POLICY_RANGES.judgeMinutes.min,
      WATCHDOG_POLICY_RANGES.judgeMinutes.max,
    ),
    actionMinutes: clampInt(
      Math.round(policy.actionCooldownMs / MINUTE_MS),
      WATCHDOG_POLICY_RANGES.actionMinutes.min,
      WATCHDOG_POLICY_RANGES.actionMinutes.max,
    ),
  };
}

export function toWatchdogPatch(draft: WatchdogPolicyDraft): Omit<WatchdogPolicyView, 'updatedAt'> {
  return {
    enabled: draft.enabled,
    idleTaskMs:
      clampInt(
        draft.idleMinutes,
        WATCHDOG_POLICY_RANGES.idleMinutes.min,
        WATCHDOG_POLICY_RANGES.idleMinutes.max,
      ) * MINUTE_MS,
    repeatFailure: clampInt(
      draft.repeatFailure,
      WATCHDOG_POLICY_RANGES.repeatFailure.min,
      WATCHDOG_POLICY_RANGES.repeatFailure.max,
    ),
    staleMainMs:
      clampInt(
        draft.staleSeconds,
        WATCHDOG_POLICY_RANGES.staleSeconds.min,
        WATCHDOG_POLICY_RANGES.staleSeconds.max,
      ) * 1000,
    recheckAfterMs:
      clampInt(
        draft.recheckMinutes,
        WATCHDOG_POLICY_RANGES.recheckMinutes.min,
        WATCHDOG_POLICY_RANGES.recheckMinutes.max,
      ) * MINUTE_MS,
    escalateAfterMs:
      clampInt(
        draft.escalateMinutes,
        WATCHDOG_POLICY_RANGES.escalateMinutes.min,
        WATCHDOG_POLICY_RANGES.escalateMinutes.max,
      ) * MINUTE_MS,
    judgeCooldownMs:
      clampInt(
        draft.judgeMinutes,
        WATCHDOG_POLICY_RANGES.judgeMinutes.min,
        WATCHDOG_POLICY_RANGES.judgeMinutes.max,
      ) * MINUTE_MS,
    actionCooldownMs:
      clampInt(
        draft.actionMinutes,
        WATCHDOG_POLICY_RANGES.actionMinutes.min,
        WATCHDOG_POLICY_RANGES.actionMinutes.max,
      ) * MINUTE_MS,
  };
}

export function areWatchdogDraftsEqual(
  left: WatchdogPolicyDraft | null,
  right: WatchdogPolicyDraft | null,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.enabled === right.enabled &&
    left.idleMinutes === right.idleMinutes &&
    left.repeatFailure === right.repeatFailure &&
    left.staleSeconds === right.staleSeconds &&
    left.recheckMinutes === right.recheckMinutes &&
    left.escalateMinutes === right.escalateMinutes &&
    left.judgeMinutes === right.judgeMinutes &&
    left.actionMinutes === right.actionMinutes
  );
}

const STATE_PRIORITY: Record<WatchdogIncidentView['state'], number> = {
  escalated: 0,
  rechecking: 1,
  active: 2,
  resolved: 3,
};

export interface IncidentSplitCounts {
  total: number;
  open: number;
  escalated: number;
  rechecking: number;
  active: number;
  resolved: number;
}

export interface WatchdogIncidentSplit {
  open: WatchdogIncidentView[];
  resolved: WatchdogIncidentView[];
  counts: IncidentSplitCounts;
}

/**
 * Separates open incidents (escalated -> rechecking -> active, newest seen first)
 * from resolved history (newest resolved first) so live triage stays focused.
 */
export function splitWatchdogIncidents(
  incidents: readonly WatchdogIncidentView[],
): WatchdogIncidentSplit {
  const open: WatchdogIncidentView[] = [];
  const resolved: WatchdogIncidentView[] = [];
  let escalated = 0;
  let rechecking = 0;
  let active = 0;

  for (const incident of incidents) {
    if (incident.state === 'resolved') {
      resolved.push(incident);
      continue;
    }
    if (incident.state === 'escalated') escalated += 1;
    else if (incident.state === 'rechecking') rechecking += 1;
    else active += 1;
    open.push(incident);
  }

  open.sort((a, b) => {
    const priorityDiff = STATE_PRIORITY[a.state] - STATE_PRIORITY[b.state];
    if (priorityDiff !== 0) return priorityDiff;
    if (b.lastSeenAt !== a.lastSeenAt) return b.lastSeenAt - a.lastSeenAt;
    return b.firstAt - a.firstAt;
  });

  resolved.sort((a, b) => {
    const aTime = a.resolvedAt ?? a.lastSeenAt;
    const bTime = b.resolvedAt ?? b.lastSeenAt;
    if (bTime !== aTime) return bTime - aTime;
    return b.firstAt - a.firstAt;
  });

  return {
    open,
    resolved,
    counts: {
      total: incidents.length,
      open: open.length,
      escalated,
      rechecking,
      active,
      resolved: resolved.length,
    },
  };
}

export function resolveIncidentStateTone(state: WatchdogIncidentView['state']): IncidentStateTone {
  switch (state) {
    case 'escalated':
      return 'red';
    case 'rechecking':
      return 'blue';
    case 'active':
      return 'amber';
    case 'resolved':
      return 'gray';
  }
}

const KIND_MAP: Record<string, IncidentKindKey> = {
  repeat_failure: 'repeatFailure',
  no_progress: 'noProgress',
  main_unresponsive: 'mainUnresponsive',
  'mcp.connect_failed': 'mcpConnectFailed',
  'router.session_failed': 'routerSessionFailed',
  'process.unclean_exit': 'processUncleanExit',
  'watchdog.unresponsive': 'watchdogUnresponsive',
  'watchdog.spawn_failed': 'watchdogSpawnFailed',
  'watchdog.business_db_unavailable': 'watchdogDbUnavailable',
  'watchdog.exited': 'watchdogExited',
  'watchdog.restart_given_up': 'watchdogExited',
};

export function resolveIncidentKindKey(kind: string): IncidentKindKey {
  const direct = KIND_MAP[kind];
  if (direct) return direct;
  if (kind.startsWith('watchdog.')) return 'watchdogProcess';
  return 'other';
}

const VERDICT_MAP: Record<string, { key: VerdictKey; tone: SemanticTone }> = {
  progressing: { key: 'progressing', tone: 'green' },
  stalled: { key: 'stalled', tone: 'amber' },
  looping: { key: 'looping', tone: 'red' },
  deviating: { key: 'deviating', tone: 'red' },
  insufficient_evidence: { key: 'insufficientEvidence', tone: 'gray' },
};

export function resolveVerdictInfo(verdict?: string): { key: VerdictKey; tone: SemanticTone } {
  if (!verdict) return { key: 'other', tone: 'gray' };
  return VERDICT_MAP[verdict] ?? { key: 'other', tone: 'gray' };
}

export function resolveJudgedByKey(judgedBy?: string): JudgedByKey {
  if (judgedBy === 'child') return 'child';
  if (judgedBy === 'parent') return 'parent';
  return null;
}

export function resolveSubjectTypeKey(subjectType: string): SubjectTypeKey {
  if (subjectType === 'task' || subjectType === 'mcp' || subjectType === 'process') {
    return subjectType;
  }
  return 'other';
}

export function formatShortSubjectId(subjectType: string, subjectId: string): string {
  const trimmed = subjectId.trim();
  if (!trimmed) return '';
  if (subjectType === 'mcp' || trimmed.length <= 16) return trimmed;
  return `${trimmed.slice(0, 8)}…`;
}

export function resolveActionInfo(
  action: string,
  status: WatchdogActionView['status'],
): { nameKey: ActionNameKey; tone: SemanticTone } {
  const nameKey: ActionNameKey = action === 'mcp.reconnect' ? 'mcpReconnect' : 'other';
  const tone: SemanticTone =
    status === 'done'
      ? 'green'
      : status === 'failed'
        ? 'red'
        : status === 'pending'
          ? 'blue'
          : 'gray';
  return { nameKey, tone };
}

export interface WatchdogActionStats {
  total: number;
  done: number;
  failed: number;
  pending: number;
  refused: number;
}

export function summarizeWatchdogActions(
  actions: readonly WatchdogActionView[],
): WatchdogActionStats {
  let done = 0;
  let failed = 0;
  let pending = 0;
  let refused = 0;

  for (const item of actions) {
    if (item.status === 'done') done += 1;
    else if (item.status === 'failed') failed += 1;
    else if (item.status === 'pending') pending += 1;
    else refused += 1;
  }

  return {
    total: actions.length,
    done,
    failed,
    pending,
    refused,
  };
}

/** Keeps only the newest self-healing action for each incident so rows show immediate feedback. */
export function indexLatestActionByIncident(
  actions: readonly WatchdogActionView[],
): Record<string, WatchdogActionView> {
  const map: Record<string, WatchdogActionView> = {};
  for (const item of actions) {
    const existing = map[item.incidentId];
    if (!existing || item.at > existing.at) {
      map[item.incidentId] = item;
    }
  }
  return map;
}

export function hasOpenInfraIncident(incidents: readonly WatchdogIncidentView[]): boolean {
  return incidents.some(
    (item) =>
      item.state !== 'resolved' &&
      (item.kind === 'main_unresponsive' || item.kind.startsWith('watchdog.')),
  );
}

/** Safely parses structured incident `detail` JSON into compact readable text without throwing. */
export function formatIncidentDetail(detail?: string): string | null {
  const trimmed = detail?.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return JSON.stringify(parsed, null, 2);
    }
    return String(parsed);
  } catch {
    return trimmed;
  }
}
