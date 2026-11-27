import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolExecutionApi } from '@earendil-works/pi-durable';
import type { ChannelStore } from '../store';
import { createGitHubToolsExtension } from './githubTools';

function createFakeStore(opts?: { token?: string; watchRepos?: string[] }) {
  let watchRepos = [...(opts?.watchRepos ?? [])];
  const token = opts?.token ?? 'github_pat_main';

  const store = {
    getGitHubConfig: () => ({
      enabled: true,
      hasToken: Boolean(token),
      hasNotificationsToken: false,
      token,
      notificationsToken: '',
      apiBaseUrl: '',
      pollIntervalSec: 60,
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
        dmAllowlist: [],
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

function getToolText(result: { output?: Array<{ type: string; text?: string }> }): string {
  return result.output?.map((b) => b.text ?? '').join('\n') ?? '';
}

const dummyApi = {} as ToolExecutionApi;
const dummyCtx = {} as never;

describe('githubTools', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders dynamic github-context prompt section only when token is configured', async () => {
    const emptyExt = createGitHubToolsExtension(createFakeStore({ token: '' }).store);
    const emptySec = await emptyExt.sections![0]!.render({} as never, {} as never);
    expect(emptySec).toBeUndefined();

    const { store, setWatchRepos } = createFakeStore({
      token: 'github_pat_123',
      watchRepos: ['austin/wordless', 'austin/opc-platform'],
    });
    const ext = createGitHubToolsExtension(store);
    const sec1 = await ext.sections![0]!.render({} as never, {} as never);
    expect(sec1).toContain('austin/wordless');
    expect(sec1).toContain('austin/opc-platform');
    expect(sec1).toContain('github_list_repos');
    expect(sec1).toContain('严禁跳过本人仓库去 web_search');

    setWatchRepos(['austin/wordless']);
    const sec2 = await ext.sections![0]!.render({} as never, {} as never);
    expect(sec2).toContain('austin/wordless');
    expect(sec2).not.toContain('austin/opc-platform');
  });

  it('github_list_repos lists watched + accessible repos, supports query & watched_only', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ id: 1, login: 'austin' }), { status: 200 });
      }
      if (url.includes('/user/repos?')) {
        return new Response(
          JSON.stringify([
            {
              full_name: 'austin/wordless',
              private: true,
              description: 'Personal wordless writing workspace',
              pushed_at: '2026-11-26T10:00:00Z',
            },
            {
              full_name: 'austin/opc-platform',
              private: false,
              description: 'One-person company AI workspace',
              pushed_at: '2026-11-27T01:00:00Z',
            },
          ]),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { store } = createFakeStore({
      watchRepos: ['austin/wordless', 'external/watched-oss'],
    });
    const ext = createGitHubToolsExtension(store);
    const listReposTool = ext.tools!.find((t) => t.name === 'github_list_repos')!;

    const watchedOnlyRes = await listReposTool.execute({ watched_only: true }, dummyApi, dummyCtx);
    expect(getToolText(watchedOnlyRes)).toContain('austin/wordless [重点关注]');
    expect(getToolText(watchedOnlyRes)).toContain('external/watched-oss [重点关注]');
    expect(fetchMock).not.toHaveBeenCalled();

    const filteredRes = await listReposTool.execute({ query: 'wordless' }, dummyApi, dummyCtx);
    const text = getToolText(filteredRes);
    expect(text).toContain('@austin');
    expect(text).toContain('austin/wordless');
    expect(text).toContain('重点关注');
    expect(text).toContain('私有');
    expect(text).not.toContain('opc-platform');
  });

  it('resolves short repo names against watchRepos and fetches PRs directly via /pulls', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/repos/austin/wordless/pulls?')) {
        return new Response(
          JSON.stringify([
            {
              id: 88,
              number: 14,
              title: 'feat: sync reader layout',
              state: 'open',
              html_url: 'https://github.com/austin/wordless/pull/14',
              user: { id: 1, login: 'austin' },
              requested_reviewers: [{ id: 2, login: 'alice' }],
              created_at: '2026-11-27T01:00:00Z',
              updated_at: '2026-11-27T09:00:00Z',
            },
          ]),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { store } = createFakeStore({
      watchRepos: ['austin/wordless'],
    });
    const ext = createGitHubToolsExtension(store);
    const listItemsTool = ext.tools!.find((t) => t.name === 'github_list_items')!;

    const res = await listItemsTool.execute(
      { repo: 'wordless', kind: 'pr', state: 'open' },
      dummyApi,
      dummyCtx,
    );
    const text = getToolText(res);
    expect(text).toContain('#14 [PR · open] feat: sync reader layout');
    expect(text).toContain('@alice');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/repos/austin/wordless/pulls?state=open');
  });

  it('falls back to /user/repos for short names and errors clearly on ambiguous short names', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify([
          { full_name: 'austin/wordless', private: true },
          { full_name: 'org/wordless', private: false },
        ]),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { store } = createFakeStore({ watchRepos: [] });
    const ext = createGitHubToolsExtension(store);
    const listItemsTool = ext.tools!.find((t) => t.name === 'github_list_items')!;

    await expect(
      listItemsTool.execute({ repo: 'wordless', kind: 'pr' }, dummyApi, dummyCtx),
    ).rejects.toThrow(/austin\/wordless.*org\/wordless/);
  });
});
