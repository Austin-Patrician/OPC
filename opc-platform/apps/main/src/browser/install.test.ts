import { describe, expect, it } from 'vitest';
import { normalizeBrowserSettings } from './install';

describe('browser settings normalization', () => {
  it('preserves an explicitly empty approval policy', () => {
    expect(normalizeBrowserSettings({ requireApprovalFor: [] }).requireApprovalFor).toEqual([]);
  });

  it('uses default approvals only when the policy is absent', () => {
    expect(normalizeBrowserSettings({}).requireApprovalFor).toEqual([
      'external-submit', 'download', 'upload', 'authentication', 'destructive',
    ]);
  });
});
