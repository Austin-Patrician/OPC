import { describe, expect, it } from 'vitest';
import type {
  WatchdogActionView,
  WatchdogIncidentView,
  WatchdogPolicyView,
} from '@opc/shared/ipc';
import {
  areWatchdogDraftsEqual,
  DEFAULT_WATCHDOG_DRAFT,
  formatIncidentDetail,
  formatShortSubjectId,
  hasOpenInfraIncident,
  indexLatestActionByIncident,
  resolveActionInfo,
  resolveIncidentKindKey,
  resolveIncidentStateTone,
  resolveJudgedByKey,
  resolveSubjectTypeKey,
  resolveVerdictInfo,
  splitWatchdogIncidents,
  summarizeWatchdogActions,
  toWatchdogDraft,
  toWatchdogPatch,
} from './watchdogModel';

function makeIncident(
  overrides: Partial<WatchdogIncidentView> &
    Pick<WatchdogIncidentView, 'id' | 'state' | 'kind'>,
): WatchdogIncidentView {
  return {
    subjectType: 'task',
    subjectId: 'task-1234',
    summary: '测试异常描述',
    firstAt: 1_000,
    lastSeenAt: 2_000,
    reopenCount: 0,
    ...overrides,
  };
}

describe('watchdogModel', () => {
  it('converts policy views to drafts, patches back cleanly, and clamps out-of-range inputs', () => {
    const view: WatchdogPolicyView = {
      enabled: true,
      idleTaskMs: 30 * 60_000,
      repeatFailure: 3,
      staleMainMs: 90_000,
      recheckAfterMs: 2 * 60_000,
      escalateAfterMs: 15 * 60_000,
      judgeCooldownMs: 30 * 60_000,
      actionCooldownMs: 10 * 60_000,
      updatedAt: 123456,
    };

    const draft = toWatchdogDraft(view);
    expect(draft).toEqual(DEFAULT_WATCHDOG_DRAFT);
    expect(areWatchdogDraftsEqual(draft, DEFAULT_WATCHDOG_DRAFT)).toBe(true);
    expect(areWatchdogDraftsEqual(draft, { ...draft, repeatFailure: 5 })).toBe(false);

    const patch = toWatchdogPatch({ ...draft, idleMinutes: 1, repeatFailure: 99, staleSeconds: 5 });
    expect(patch.idleTaskMs).toBe(5 * 60_000);
    expect(patch.repeatFailure).toBe(20);
    expect(patch.staleMainMs).toBe(30_000);
  });

  it('splits open incidents by escalation severity and separates resolved history newest-first', () => {
    const incidents: WatchdogIncidentView[] = [
      makeIncident({ id: 'a1', state: 'active', kind: 'no_progress', lastSeenAt: 5_000 }),
      makeIncident({
        id: 'r1',
        state: 'resolved',
        kind: 'mcp.connect_failed',
        lastSeenAt: 3_000,
        resolvedAt: 4_000,
      }),
      makeIncident({ id: 'e1', state: 'escalated', kind: 'repeat_failure', lastSeenAt: 2_000 }),
      makeIncident({ id: 'c1', state: 'rechecking', kind: 'no_progress', lastSeenAt: 6_000 }),
      makeIncident({
        id: 'r2',
        state: 'resolved',
        kind: 'no_progress',
        lastSeenAt: 8_000,
        resolvedAt: 9_000,
      }),
      makeIncident({ id: 'e2', state: 'escalated', kind: 'main_unresponsive', lastSeenAt: 7_000 }),
    ];

    const result = splitWatchdogIncidents(incidents);
    expect(result.open.map((item) => item.id)).toEqual(['e2', 'e1', 'c1', 'a1']);
    expect(result.resolved.map((item) => item.id)).toEqual(['r2', 'r1']);
    expect(result.counts).toEqual({
      total: 6,
      open: 4,
      escalated: 2,
      rechecking: 1,
      active: 1,
      resolved: 2,
    });
  });

  it('maps state tones, incident kinds, verdicts, judge sources, and actions semantically', () => {
    expect(resolveIncidentStateTone('escalated')).toBe('red');
    expect(resolveIncidentStateTone('rechecking')).toBe('blue');
    expect(resolveIncidentStateTone('active')).toBe('amber');
    expect(resolveIncidentStateTone('resolved')).toBe('gray');

    expect(resolveIncidentKindKey('repeat_failure')).toBe('repeatFailure');
    expect(resolveIncidentKindKey('mcp.connect_failed')).toBe('mcpConnectFailed');
    expect(resolveIncidentKindKey('watchdog.spawn_failed')).toBe('watchdogSpawnFailed');
    expect(resolveIncidentKindKey('watchdog.custom_future')).toBe('watchdogProcess');
    expect(resolveIncidentKindKey('unknown_kind')).toBe('other');

    expect(resolveVerdictInfo('looping')).toEqual({ key: 'looping', tone: 'red' });
    expect(resolveVerdictInfo('progressing')).toEqual({ key: 'progressing', tone: 'green' });
    expect(resolveVerdictInfo('unknown')).toEqual({ key: 'other', tone: 'gray' });

    expect(resolveJudgedByKey('child')).toBe('child');
    expect(resolveJudgedByKey('parent')).toBe('parent');
    expect(resolveJudgedByKey('')).toBeNull();

    expect(resolveSubjectTypeKey('mcp')).toBe('mcp');
    expect(resolveSubjectTypeKey('other-type')).toBe('other');
    expect(formatShortSubjectId('mcp', 'very-long-mcp-server-name')).toBe(
      'very-long-mcp-server-name',
    );
    expect(formatShortSubjectId('task', '1234567890abcdef1234')).toBe('12345678…');

    expect(resolveActionInfo('mcp.reconnect', 'done')).toEqual({
      nameKey: 'mcpReconnect',
      tone: 'green',
    });
    expect(resolveActionInfo('other.action', 'refused')).toEqual({
      nameKey: 'other',
      tone: 'gray',
    });
  });

  it('indexes newest action per incident, summarizes action counts, and detects infra incidents', () => {
    const actions: WatchdogActionView[] = [
      { incidentId: 'i1', action: 'mcp.reconnect', status: 'failed', at: 100, result: 'timeout' },
      { incidentId: 'i1', action: 'mcp.reconnect', status: 'done', at: 200, result: 'reconnected' },
      { incidentId: 'i2', action: 'mcp.reconnect', status: 'pending', at: 150, result: 'trying' },
    ];

    const latest = indexLatestActionByIncident(actions);
    expect(latest.i1?.status).toBe('done');
    expect(latest.i2?.status).toBe('pending');
    expect(summarizeWatchdogActions(actions)).toEqual({
      total: 3,
      done: 1,
      failed: 1,
      pending: 1,
      refused: 0,
    });

    expect(
      hasOpenInfraIncident([makeIncident({ id: 'x', state: 'resolved', kind: 'main_unresponsive' })]),
    ).toBe(false);
    expect(
      hasOpenInfraIncident([
        makeIncident({ id: 'y', state: 'active', kind: 'watchdog.unresponsive' }),
      ]),
    ).toBe(true);
  });

  it('formats JSON incident detail safely and preserves non-JSON fallbacks', () => {
    expect(formatIncidentDetail('')).toBeNull();
    expect(formatIncidentDetail('{"tool":"bash","attempts":3}')).toBe(
      '{\n  "tool": "bash",\n  "attempts": 3\n}',
    );
    expect(formatIncidentDetail('plain detail string')).toBe('plain detail string');
  });
});
