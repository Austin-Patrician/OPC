import { describe, expect, it } from 'vitest';
import {
  PROXY_OVERRIDE,
  decideRoute,
  describeRoute,
  envProxy,
  parseScutilProxy,
  parseWindowsOverride,
  parseWindowsProxyServer,
  proxyEnvironment,
  proxyUrl,
} from './ocr-proxy.mjs';

/**
 * The download script is not Electron, so the app's proxy settings never reach
 * it. These tests pin the two things that has to get right:
 *
 * - **which route** to take (explicit env beats the OS setting; `direct` wins
 *   over both), and
 * - **what the OS setting means** (`reg query` and `scutil --proxy` output).
 *
 * A wrong parse here fails silently in the worst way: the build machine has a
 * proxy, the script does not use it, and the error reads "fetch failed".
 */

describe('envProxy', () => {
  it('takes the first variable that is actually set', () => {
    expect(envProxy({ HTTPS_PROXY: 'http://p:1' })).toBe('http://p:1');
    expect(envProxy({ https_proxy: 'http://p:2' })).toBe('http://p:2');
    expect(envProxy({ HTTPS_PROXY: '   ', ALL_PROXY: 'socks5://p:3' })).toBe('socks5://p:3');
    expect(envProxy({})).toBeNull();
  });
});

describe('proxyUrl', () => {
  it('a bare host:port gets the scheme', () => {
    expect(proxyUrl('127.0.0.1:7897')).toBe('http://127.0.0.1:7897');
    expect(proxyUrl('127.0.0.1:7897', 'https')).toBe('https://127.0.0.1:7897');
  });

  it('a host without a port gets the scheme default', () => {
    expect(proxyUrl('proxy.corp', 'http')).toBe('http://proxy.corp:80');
    expect(proxyUrl('proxy.corp', 'https')).toBe('https://proxy.corp:443');
    expect(proxyUrl('proxy.corp', 'socks5')).toBe('socks5://proxy.corp:1080');
  });

  it('an explicit scheme is kept as typed', () => {
    expect(proxyUrl('socks5://proxy.corp:1080')).toBe('socks5://proxy.corp:1080');
  });

  it('empty input is not a route', () => {
    expect(proxyUrl('')).toBeNull();
    expect(proxyUrl('   ')).toBeNull();
  });
});

describe('parseWindowsProxyServer', () => {
  it('the common single string is one plain-HTTP proxy for both schemes', () => {
    // Regression: reading it as `https://…` means "TLS *to the proxy*", which a
    // normal HTTP proxy answers by dropping the connection.
    expect(parseWindowsProxyServer('127.0.0.1:7897')).toEqual({
      http: 'http://127.0.0.1:7897',
      https: 'http://127.0.0.1:7897',
    });
  });

  it('the per-scheme form is read scheme by scheme', () => {
    const parsed = parseWindowsProxyServer('http=10.0.0.1:8080;https=10.0.0.2:8443');
    expect(parsed).toEqual({ http: 'http://10.0.0.1:8080', https: 'https://10.0.0.2:8443' });
  });

  it('a socks-only setting keeps its scheme; it is not passed off as HTTP', () => {
    const parsed = parseWindowsProxyServer('socks=127.0.0.1:1080');
    expect(parsed).toEqual({ http: 'socks5://127.0.0.1:1080', https: 'socks5://127.0.0.1:1080' });
  });

  it('nothing set is no route', () => {
    expect(parseWindowsProxyServer('')).toBeNull();
    expect(parseWindowsProxyServer('   ')).toBeNull();
  });
});

describe('parseWindowsOverride', () => {
  it('keeps wildcards and drops <local>, which NO_PROXY cannot express', () => {
    expect(parseWindowsOverride('localhost;127.*;192.168.*;<local>')).toBe('localhost,127.*,192.168.*');
  });

  it('an empty override is undefined, not an empty string', () => {
    expect(parseWindowsOverride('')).toBeUndefined();
    expect(parseWindowsOverride('<local>')).toBeUndefined();
  });
});

describe('parseScutilProxy', () => {
  const output = [
    '<dictionary> {',
    '  ExceptionsList : <array> {',
    '    0 : *.local',
    '  }',
    '  HTTPEnable : 1',
    '  HTTPPort : 7890',
    '  HTTPProxy : 127.0.0.1',
    '  HTTPSEnable : 1',
    '  HTTPSPort : 7890',
    '  HTTPSProxy : 127.0.0.1',
    '}',
  ].join('\n');

  it('both entries are plain-HTTP proxies, even the HTTPS one', () => {
    expect(parseScutilProxy(output)).toEqual({
      http: 'http://127.0.0.1:7890',
      https: 'http://127.0.0.1:7890',
    });
  });

  it('a disabled scheme is not a route', () => {
    expect(parseScutilProxy(output.replace('HTTPEnable : 1', 'HTTPEnable : 0'))).toEqual({
      http: 'http://127.0.0.1:7890',
      https: 'http://127.0.0.1:7890',
    });
  });

  it('no proxy configured at all', () => {
    expect(parseScutilProxy('  HTTPEnable : 0\n  HTTPSEnable : 0')).toBeNull();
  });
});

describe('decideRoute', () => {
  const system = { http: 'http://10.0.0.1:8080', https: 'https://10.0.0.1:8443' };

  it('an explicit environment variable beats the OS setting', () => {
    const { route } = decideRoute({ env: { HTTPS_PROXY: 'http://env:1' }, system });
    expect(route).toMatchObject({ url: 'http://env:1', source: 'env' });
  });

  it('falls back to the OS setting when the environment says nothing', () => {
    const { route } = decideRoute({ env: {}, system });
    expect(route).toMatchObject({ url: 'https://10.0.0.1:8443', source: 'system' });
  });

  it('OPC_OCR_PROXY=direct wins over both', () => {
    const { route, reason } = decideRoute({
      env: { [PROXY_OVERRIDE]: 'direct', HTTPS_PROXY: 'http://env:1' },
      system,
    });
    expect(route).toBeNull();
    expect(reason).toContain('direct');
  });

  it('carries NO_PROXY along, from either source', () => {
    expect(decideRoute({ env: { HTTPS_PROXY: 'http://env:1', NO_PROXY: '*.corp' } }).route).toMatchObject({
      noProxy: '*.corp',
    });
    expect(decideRoute({ env: {}, system: { ...system, noProxy: 'localhost' } }).route).toMatchObject({
      noProxy: 'localhost',
    });
  });

  it('no proxy anywhere stays direct', () => {
    expect(decideRoute({ env: {}, system: null }).route).toBeNull();
  });
});

describe('proxyEnvironment', () => {
  it('an http proxy also serves plain HTTP', () => {
    expect(proxyEnvironment({ url: 'http://127.0.0.1:7897' })).toEqual({
      HTTPS_PROXY: 'http://127.0.0.1:7897',
      https_proxy: 'http://127.0.0.1:7897',
      HTTP_PROXY: 'http://127.0.0.1:7897',
      http_proxy: 'http://127.0.0.1:7897',
    });
  });

  it('an https proxy does not claim to be an HTTP proxy', () => {
    const env = proxyEnvironment({ url: 'https://127.0.0.1:8443' });
    expect(env.HTTPS_PROXY).toBe('https://127.0.0.1:8443');
    expect(env).not.toHaveProperty('HTTP_PROXY');
  });

  it('carries NO_PROXY in both spellings', () => {
    const env = proxyEnvironment({ url: 'http://p:1', noProxy: 'localhost,127.*' });
    expect(env.NO_PROXY).toBe('localhost,127.*');
    expect(env.no_proxy).toBe('localhost,127.*');
  });
});

describe('describeRoute', () => {
  it('never prints credentials', () => {
    expect(describeRoute('http://user:secret@127.0.0.1:7897')).toBe('127.0.0.1:7897');
  });

  it('an unparsable value still yields a sentence, not a throw', () => {
    expect(describeRoute('not a url')).toContain('无法解析');
  });
});
