import { describe, expect, it } from 'vitest';
import { browserDomainAllowed, isBrowserActionRisky } from './broker';

describe('browserDomainAllowed', () => {
  const base = { enabled: true, allowedDomains: ['example.com', '*.company.test'], blockedDomains: [], allowAllDomains: false, requireApprovalFor: [], maxOutputBytes: 32_000 };

  it('matches exact and wildcard domains without allowing lookalikes', () => {
    expect(browserDomainAllowed(base, 'https://example.com/a')).toBe(true);
    expect(browserDomainAllowed(base, 'https://sub.company.test/a')).toBe(true);
    expect(browserDomainAllowed(base, 'https://example.com.evil.test')).toBe(false);
  });

  it('gives blocked domains precedence', () => {
    expect(browserDomainAllowed({ ...base, allowAllDomains: true, blockedDomains: ['*.company.test'] }, 'https://sub.company.test')).toBe(false);
  });

  it('rejects malformed and unsupported URLs', () => {
    expect(browserDomainAllowed({ ...base, allowAllDomains: true }, 'not a url')).toBe(false);
    expect(browserDomainAllowed({ ...base, allowAllDomains: true }, 'file:///tmp/secret')).toBe(false);
  });

  it('recognizes consequential controls from accessible labels', () => {
    expect(isBrowserActionRisky('button "Submit application"')).toBe(true);
    expect(isBrowserActionRisky('按钮「提交订单」')).toBe(true);
    expect(isBrowserActionRisky('link "Documentation"')).toBe(false);
  });
});

