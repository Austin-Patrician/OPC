import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelInboundMessage, ChannelPluginContext } from '../types';
import type { ChannelStore } from '../store';
import { GitHubPlugin } from './githubPlugin';

function createFakeStore(
  initialWatchRepos: string[],
  opts?: { notificationsToken?: string; token?: string; pollIntervalSec?: number },
) {
  let watchRepos = [...initialWatchRepos];
  const token = opts?.token ?? 'github_pat_main';
  const notificationsToken = opts?.notificationsToken ?? '';
  const pollIntervalSec = opts?.pollIntervalSec ?? 60;

  const store = {
    getGitHubConfig: () => ({
      enabled: true,
      hasToken: Boolean(token),
      hasNotificationsToken: Boolean(notificationsToken),
      token,
      notificationsToken,
      apiBaseUrl: '',
      pollIntervalSec,
      watchRepos: [...watchRepos],
      events: {
        mention: true,
        reviewRequested: true,
        assigned: true,
        repoActivity: false,
      },
      wakeWord: '/buddy',
      autoReplyToGitHub: true,
      thinkingReaction: true,
      mirrorToDesktop: true,
      access: {
        dmPolicy: 'allowlist' as const,
        dmAllowlist: ['octocat', 'alice'],
        groupPolicy: 'allowlist' as const,
        groupAllowlist: [],
      },
    }),
    getGitHubSettingsView: () => ({
      enabled: true,
      hasToken: Boolean(token),
      hasNotificationsToken: Boolean(notificationsToken),
      apiBaseUrl: '',
      pollIntervalSec,
      watchRepos: [...watchRepos],
      events: {
        mention: true,
        reviewRequested: true,
        assigned: true,
        repoActivity: false,
      },
      wakeWord: '/buddy',
      autoReplyToGitHub: true,
      thinkingReaction: true,
      mirrorToDesktop: true,
      access: {
        dmPolicy: 'allowlist' as const,
        dmAllowlist: ['octocat', 'alice'],
        groupPolicy: 'allowlist' as const,
        groupAllowlist: [],
      },
    }),
  } as unknown as ChannelStore;

  return {
    store,
    setWatchRepos(next: string[]) {
      watchRepos = [...next];
    },
  };
}

function createPluginContext(inbound?: ChannelInboundMessage[]): ChannelPluginContext {
  return {
    onInboundMessage: async (msg) => {
      inbound?.push(msg);
    },
    getAttachmentsDir: () => '',
    onStatusChange: () => undefined,
  };
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 600): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}

describe('GitHubPlugin', () => {
  const pluginsToStop: GitHubPlugin[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    while (pluginsToStop.length > 0) {
      const p = pluginsToStop.pop();
      if (p) await p.stop();
    }
  });

  it('degrades to repos_only mode with PR review polling when single Fine-grained PAT gets 403 on /notifications', async () => {
    const inbound: ChannelInboundMessage[] = [];
    const nowIso = new Date().toISOString();

    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ id: 1, login: 'octocat' }), { status: 200 });
      }
      if (url.includes('/notifications')) {
        return new Response(
          JSON.stringify({ message: 'Resource not accessible by personal access token' }),
          { status: 403 },
        );
      }
      if (url.includes('/repos/acme/app/issues/comments')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/repos/acme/app/issues?')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/repos/acme/app/pulls?')) {
        return new Response(
          JSON.stringify([
            {
              id: 42,
              number: 9,
              title: 'Refactor auth',
              body: 'Please take a look',
              state: 'open',
              html_url: 'https://github.com/acme/app/pull/9',
              user: { id: 2, login: 'alice', type: 'User' },
              requested_reviewers: [{ id: 1, login: 'octocat' }],
              created_at: nowIso,
              updated_at: nowIso,
            },
          ]),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ message: `Unexpected ${url}` }), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { store } = createFakeStore(['acme/app']);
    const plugin = new GitHubPlugin(store);
    pluginsToStop.push(plugin);

    await plugin.start(createPluginContext(inbound));
    await waitForCondition(() => inbound.length === 1);

    const status = plugin.getRuntimeStatus();
    expect(status.state).toBe('connected');
    expect(status.pollingMode).toBe('repos_only');
    expect(status.lastError).toBeUndefined();
    expect(inbound[0]?.eventKind).toBe('github.pr_review');
    expect(inbound[0]?.threadKey).toBe('github:acme/app#9');

    const callsBeforeWake = fetchMock.mock.calls.length;
    plugin.refreshWatchRepos();
    await waitForCondition(() => fetchMock.mock.calls.length > callsBeforeWake);

    const notifCalls = fetchMock.mock.calls.filter(([u]) =>
      String(u).includes('/notifications'),
    ).length;
    expect(notifCalls).toBe(1);
    expect(plugin.getRuntimeStatus().pollingMode).toBe('repos_only');
  });

  it('uses dedicated notificationsToken for /notifications and primary token for repo details without crashing on unauthorized cross-repo 403', async () => {
    const inbound: ChannelInboundMessage[] = [];
    const nowIso = new Date().toISOString();

    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;

      if (url.endsWith('/user')) {
        expect(auth).toBe('Bearer github_pat_main');
        return new Response(JSON.stringify({ id: 1, login: 'octocat' }), { status: 200 });
      }
      if (url.includes('/notifications')) {
        expect(auth).toBe('Bearer ghp_notif_only');
        return new Response(
          JSON.stringify([
            {
              id: 'n-private',
              reason: 'mention',
              unread: true,
              updated_at: nowIso,
              repository: { full_name: 'other/private-repo' },
              subject: {
                title: 'Secret issue',
                url: 'https://api.github.com/repos/other/private-repo/issues/3',
                latest_comment_url: null,
                type: 'Issue',
              },
            },
            {
              id: 'n-allowed',
              reason: 'mention',
              unread: true,
              updated_at: nowIso,
              repository: { full_name: 'acme/app' },
              subject: {
                title: 'Fix CI',
                url: 'https://api.github.com/repos/acme/app/issues/12',
                latest_comment_url: null,
                type: 'Issue',
              },
            },
          ]),
          { status: 200 },
        );
      }
      if (url.endsWith('/repos/other/private-repo/issues/3')) {
        expect(auth).toBe('Bearer github_pat_main');
        return new Response(
          JSON.stringify({ message: 'Resource not accessible by personal access token' }),
          { status: 403 },
        );
      }
      if (url.endsWith('/repos/acme/app/issues/12')) {
        expect(auth).toBe('Bearer github_pat_main');
        return new Response(
          JSON.stringify({
            id: 12,
            number: 12,
            title: 'Fix CI',
            body: '@octocat please investigate',
            state: 'open',
            html_url: 'https://github.com/acme/app/issues/12',
            user: { id: 2, login: 'alice', type: 'User' },
            created_at: nowIso,
            updated_at: nowIso,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { store } = createFakeStore([], { notificationsToken: 'ghp_notif_only' });
    const plugin = new GitHubPlugin(store);
    pluginsToStop.push(plugin);

    await plugin.start(createPluginContext(inbound));
    await waitForCondition(() => inbound.length === 1);

    const status = plugin.getRuntimeStatus();
    expect(status.state).toBe('connected');
    expect(status.pollingMode).toBe('notifications_and_repos');
    expect(status.lastError).toBeUndefined();
    expect(inbound[0]?.threadKey).toBe('github:acme/app#12');
  });

  it('surfaces explicit error when dedicated notificationsToken lacks /notifications permission', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ id: 1, login: 'octocat' }), { status: 200 });
      }
      if (url.includes('/notifications')) {
        return new Response(
          JSON.stringify({ message: 'Resource not accessible by personal access token' }),
          { status: 403 },
        );
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { store } = createFakeStore(['acme/app'], { notificationsToken: 'bad_notif_token' });
    const plugin = new GitHubPlugin(store);
    pluginsToStop.push(plugin);

    await plugin.start(createPluginContext());
    await waitForCondition(() => plugin.getRuntimeStatus().state === 'reconnecting');

    expect(plugin.getRuntimeStatus().lastError).toContain('通知专用 Classic PAT');
  });

  it('validates both primary and notifications tokens in testConnection', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ id: 1, login: 'octocat' }), { status: 200 });
      }
      if (url.includes('/notifications')) {
        if (auth === 'Bearer ghp_good_notif') {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        return new Response(
          JSON.stringify({ message: 'Resource not accessible by personal access token' }),
          { status: 403 },
        );
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { store } = createFakeStore([]);
    const plugin = new GitHubPlugin(store);

    const singleFineGrained = await plugin.testConnection({ token: 'github_pat_main' });
    expect(singleFineGrained.ok).toBe(true);
    expect(singleFineGrained.detail).toContain('仅关注仓库模式');

    const dualGood = await plugin.testConnection({
      token: 'github_pat_main',
      notificationsToken: 'ghp_good_notif',
    });
    expect(dualGood.ok).toBe(true);
    expect(dualGood.detail).toContain('双 Token 校验通过');

    const dualBadNotif = await plugin.testConnection({
      token: 'github_pat_main',
      notificationsToken: 'bad_token',
    });
    expect(dualBadNotif.ok).toBe(false);
    expect(dualBadNotif.error).toContain('通知专用 Classic PAT');
  });

  it('surfaces clear guidance when /notifications returns 403 and watchRepos is empty, then recovers when a repo is added', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ id: 1, login: 'octocat' }), { status: 200 });
      }
      if (url.includes('/notifications')) {
        return new Response(
          JSON.stringify({ message: 'Resource not accessible by personal access token' }),
          { status: 403 },
        );
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { store, setWatchRepos } = createFakeStore([]);
    const plugin = new GitHubPlugin(store);
    pluginsToStop.push(plugin);

    await plugin.start(createPluginContext());
    await waitForCondition(() => plugin.getRuntimeStatus().state === 'reconnecting');

    const errorStatus = plugin.getRuntimeStatus();
    expect(errorStatus.lastError).toContain('重点关注仓库');
    expect(errorStatus.lastError).toContain('通知专用 Classic PAT');

    setWatchRepos(['acme/app']);
    plugin.refreshWatchRepos();
    await waitForCondition(() => plugin.getRuntimeStatus().state === 'connected');

    expect(plugin.getRuntimeStatus().lastError).toBeUndefined();
    expect(plugin.getRuntimeStatus().pollingMode).toBe('repos_only');
  });

  it('reports specific repo name when a watched repo itself returns 403', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ id: 1, login: 'octocat' }), { status: 200 });
      }
      if (url.includes('/notifications')) {
        return new Response(
          JSON.stringify({ message: 'Resource not accessible by personal access token' }),
          { status: 403 },
        );
      }
      if (url.includes('/repos/acme/secret/')) {
        return new Response(
          JSON.stringify({ message: 'Resource not accessible by personal access token' }),
          { status: 403 },
        );
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { store } = createFakeStore(['acme/secret']);
    const plugin = new GitHubPlugin(store);
    pluginsToStop.push(plugin);

    await plugin.start(createPluginContext());
    await waitForCondition(() => plugin.getRuntimeStatus().state === 'reconnecting');

    const err = plugin.getRuntimeStatus().lastError ?? '';
    expect(err).toContain('acme/secret');
    expect(err).toContain('Issues / Pull requests');
  });

  it('honors configured 30s pollIntervalSec in repos_only mode without flooring at 60s', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ id: 1, login: 'octocat' }), { status: 200 });
      }
      if (url.includes('/notifications')) {
        return new Response(
          JSON.stringify({ message: 'Resource not accessible by personal access token' }),
          { status: 403 },
        );
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const { store } = createFakeStore(['acme/app'], { pollIntervalSec: 30 });
    const plugin = new GitHubPlugin(store);
    pluginsToStop.push(plugin);

    await plugin.start(createPluginContext());
    await waitForCondition(() => plugin.getRuntimeStatus().pollingMode === 'repos_only');

    const pollDelays = setTimeoutSpy.mock.calls.map((call) => call[1]);
    expect(pollDelays).toContain(30_000);
    setTimeoutSpy.mockRestore();
  });
});
