import { describe, expect, it } from 'vitest';
import {
  clearProxyEnvironment,
  DEFAULT_PROXY_CONFIG,
  formatAuthority,
  normalizeBypass,
  normalizeProxyHost,
  normalizeProxyInput,
  normalizeProxyPort,
  parseSystemProxy,
  proxyBypassRules,
  proxyChildEnvironment,
  proxyEnvironment,
  proxyRules,
  proxyUrl,
  type ResolvedProxy,
} from './proxyConfig';

/** The pure half of the feature: parsing, Chromium rules and child env vars. */

const manual = (overrides: Partial<ResolvedProxy> = {}): ResolvedProxy => ({
  ...DEFAULT_PROXY_CONFIG,
  mode: 'manual',
  host: '127.0.0.1',
  port: 7890,
  password: '',
  ...overrides,
});

describe('normalizeProxyHost', () => {
  it('accepts what people paste', () => {
    expect(normalizeProxyHost('http://127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeProxyHost('socks5://proxy.corp:1080')).toBe('proxy.corp');
    expect(normalizeProxyHost('user:pass@proxy.corp')).toBe('proxy.corp');
    expect(normalizeProxyHost('  proxy.corp/path ')).toBe('proxy.corp');
  });

  it('keeps IPv6 literals intact', () => {
    expect(normalizeProxyHost('[::1]')).toBe('[::1]');
    expect(normalizeProxyHost('[::1]:7890')).toBe('[::1]');
    expect(normalizeProxyHost('::1')).toBe('::1');
  });

  it('caps absurd input instead of storing it', () => {
    expect(normalizeProxyHost('x'.repeat(400))).toHaveLength(255);
    expect(normalizeProxyHost(undefined)).toBe('');
  });
});

describe('ports and bypass lists', () => {
  it('only accepts a real port', () => {
    expect(normalizeProxyPort('7890')).toBe(7890);
    expect(normalizeProxyPort(1080)).toBe(1080);
    expect(normalizeProxyPort('0')).toBe(0);
    expect(normalizeProxyPort('65536')).toBe(0);
    expect(normalizeProxyPort('abc')).toBe(0);
  });

  it('dedupes bypass entries whatever separator was used', () => {
    expect(normalizeBypass('a.com, b.com  a.com; c.com')).toBe('a.com,b.com,c.com');
    expect(normalizeBypass('')).toBe('');
  });

  it('always bypasses loopback', () => {
    const rules = proxyBypassRules('*.corp.example.com');
    expect(rules.split(',')).toEqual(
      expect.arrayContaining(['localhost', '127.0.0.1', '::1', '*.corp.example.com']),
    );
  });
});

describe('normalizeProxyInput', () => {
  it('requires a server only for manual mode', () => {
    expect(normalizeProxyInput({ mode: 'system' }).mode).toBe('system');
    expect(normalizeProxyInput({ mode: 'direct', host: '', port: 0 }).port).toBe(7890);
    expect(() => normalizeProxyInput({ mode: 'manual', host: '', port: 7890 })).toThrow('代理服务器地址');
    expect(() => normalizeProxyInput({ mode: 'manual', host: '127.0.0.1', port: 0 })).toThrow('端口');
  });

  it('drops unknown modes and protocols back to the defaults', () => {
    const input = normalizeProxyInput({ mode: 'nope', protocol: 'ftp', host: 'p', port: 1 });
    expect(input.mode).toBe('system');
    expect(input.protocol).toBe('http');
  });

  it('keeps the three-state password contract', () => {
    expect(normalizeProxyInput({ mode: 'system' }).password).toBeUndefined();
    expect(normalizeProxyInput({ mode: 'system', password: '' }).password).toBe('');
    expect(normalizeProxyInput({ mode: 'system', password: 's3cret' }).password).toBe('s3cret');
  });
});

describe('proxyRules', () => {
  it('uses a bare authority for an HTTP proxy (all schemes)', () => {
    expect(proxyRules({ protocol: 'http', host: '127.0.0.1', port: 7890 })).toBe('127.0.0.1:7890');
  });

  it('marks a TLS-speaking proxy and a SOCKS5 proxy explicitly', () => {
    expect(proxyRules({ protocol: 'https', host: 'proxy.corp', port: 443 })).toBe('https://proxy.corp:443');
    expect(proxyRules({ protocol: 'socks5', host: '127.0.0.1', port: 1080 })).toBe(
      'socks5://127.0.0.1:1080',
    );
  });

  it('brackets IPv6 so the port is unambiguous', () => {
    expect(formatAuthority('::1', 7890)).toBe('[::1]:7890');
    expect(proxyUrl({ protocol: 'http', host: '::1', port: 7890 })).toBe('http://[::1]:7890');
  });
});

describe('proxyEnvironment', () => {
  it('writes both cases for an HTTP proxy, with credentials URL-encoded', () => {
    const env = proxyEnvironment(manual({ username: 'bo ss', password: 'p@ss' }));
    const expected = 'http://bo%20ss:p%40ss@127.0.0.1:7890';
    expect(env.HTTP_PROXY).toBe(expected);
    expect(env.https_proxy).toBe(expected);
    expect(env.NO_PROXY).toContain('127.0.0.1');
  });

  it('leaves HTTP_PROXY unset for SOCKS5 and only exports ALL_PROXY', () => {
    const env = proxyEnvironment(manual({ protocol: 'socks5', port: 1080 }));
    expect(env.HTTP_PROXY).toBeNull();
    expect(env.https_proxy).toBeNull();
    expect(env.ALL_PROXY).toBe('socks5://127.0.0.1:1080');
    expect(env.no_proxy).toContain('localhost');
  });
});

describe('parseSystemProxy', () => {
  it('reads the first hop of a PAC result', () => {
    expect(parseSystemProxy('PROXY proxy.corp:8080; DIRECT')).toEqual({
      protocol: 'http',
      host: 'proxy.corp',
      port: 8080,
    });
  });

  it('understands HTTPS and SOCKS directives', () => {
    expect(parseSystemProxy('HTTPS proxy.corp:443')).toEqual({
      protocol: 'https',
      host: 'proxy.corp',
      port: 443,
    });
    expect(parseSystemProxy('SOCKS5 127.0.0.1:1080')).toEqual({
      protocol: 'socks5',
      host: '127.0.0.1',
      port: 1080,
    });
  });

  it('keeps IPv6 literals bracketed', () => {
    expect(parseSystemProxy('PROXY [::1]:7890')).toEqual({
      protocol: 'http',
      host: '[::1]',
      port: 7890,
    });
  });

  it('returns null for DIRECT, empty or malformed results', () => {
    expect(parseSystemProxy('DIRECT')).toBeNull();
    expect(parseSystemProxy('')).toBeNull();
    expect(parseSystemProxy(null)).toBeNull();
    expect(parseSystemProxy('PROXY no-port')).toBeNull();
    expect(parseSystemProxy('PROXY host:0')).toBeNull();
  });
});

describe('proxyChildEnvironment', () => {
  const systemConfig = (): ResolvedProxy => ({ ...DEFAULT_PROXY_CONFIG, mode: 'system', password: '' });
  const directConfig = (): ResolvedProxy => ({ ...DEFAULT_PROXY_CONFIG, mode: 'direct', password: '' });

  it('uses the manual config verbatim', () => {
    expect(proxyChildEnvironment(manual())?.HTTP_PROXY).toBe('http://127.0.0.1:7890');
  });

  it('clears every variable in direct mode', () => {
    const env = proxyChildEnvironment(directConfig());
    expect(Object.keys(env ?? {})).toHaveLength(8);
    expect(Object.values(env ?? {})).toEqual(Array(8).fill(null));
    expect(clearProxyEnvironment()).toEqual(env);
  });

  it('translates a resolved system proxy into env vars', () => {
    const env = proxyChildEnvironment(systemConfig(), 'PROXY proxy.corp:8080');
    expect(env?.HTTP_PROXY).toBe('http://proxy.corp:8080');
  });

  it('clears variables when the system is known to be direct', () => {
    const env = proxyChildEnvironment(systemConfig(), 'DIRECT');
    expect(env?.HTTPS_PROXY).toBeNull();
  });

  it('returns null only when the system proxy could not be resolved', () => {
    expect(proxyChildEnvironment(systemConfig())).toBeNull();
  });
});
