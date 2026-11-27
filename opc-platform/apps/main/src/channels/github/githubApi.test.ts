import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GITHUB_API_BASE,
  GitHubApi,
  normalizeGitHubApiBaseUrl,
} from './githubApi';

describe('githubApi', () => {
  it('normalizes API base URLs and rejects invalid protocols', () => {
    expect(normalizeGitHubApiBaseUrl('')).toBe(DEFAULT_GITHUB_API_BASE);
    expect(normalizeGitHubApiBaseUrl('https://git.corp.local/api/v3///')).toBe(
      'https://git.corp.local/api/v3',
    );
    expect(() => normalizeGitHubApiBaseUrl('ftp://git.corp.local')).toThrow();
    expect(() => normalizeGitHubApiBaseUrl('not-a-url')).toThrow();
  });

  it('verifies authenticated user via GET /user', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ id: 7, login: 'octocat', name: 'The Octocat' }),
        { status: 200 },
      ),
    );
    const api = new GitHubApi({ token: 'ghp_test', fetchImpl: fetchMock });
    const res = await api.verifyConnection();
    expect(res.ok).toBe(true);
    expect(res.botName).toBe('@octocat (The Octocat)');
    expect(res.botOpenId).toBe('octocat');
  });

  it('supports conditional polling with If-None-Match returning 304 Not Modified cleanly', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 304,
          headers: { etag: '"abc"', 'x-poll-interval': '90' },
        }),
      );
    const api = new GitHubApi({ token: 'ghp_test', fetchImpl: fetchMock });
    const res = await api.listNotifications({
      etag: '"abc"',
      lastModified: 'Thu, 01 Jan 2026 00:00:00 GMT',
    });

    expect(res.notModified).toBe(true);
    expect(res.items).toEqual([]);
    expect(res.etag).toBe('"abc"');
    expect(res.pollIntervalSec).toBe(90);

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers['If-None-Match']).toBe('"abc"');
    expect(headers['If-Modified-Since']).toBe('Thu, 01 Jan 2026 00:00:00 GMT');
  });

  it('blocks cross-origin SSRF URLs in fetchByUrl and posts comments/reviews properly', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: 501, html_url: 'https://github.com/acme/api/issues/1#issuecomment-501' }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 901, state: 'COMMENTED' }), { status: 200 }),
      );

    const api = new GitHubApi({ token: 'ghp_test', fetchImpl: fetchMock });
    await expect(api.fetchByUrl('https://evil.example.com/steal-token')).rejects.toThrow();

    const created = await api.createIssueComment('acme', 'api', 1, 'Looks good');
    expect(created.id).toBe(501);

    const review = await api.submitPullReview('acme', 'api', 12, {
      event: 'COMMENT',
      body: 'Reviewed PR diff',
    });
    expect(review.state).toBe('COMMENTED');
  });

  it('lists accessible viewer repos sorted by recent push and handles pagination', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { full_name: 'acme/app', private: true, description: 'Main app' },
            { full_name: 'Acme/App', private: true },
          ]),
          {
            status: 200,
            headers: {
              link: '<https://api.github.com/user/repos?page=2>; rel="next"',
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { full_name: 'acme/docs', private: false, archived: true },
          ]),
          { status: 200 },
        ),
      );

    const api = new GitHubApi({ token: 'ghp_test', fetchImpl: fetchMock });
    const res = await api.listViewerRepos({ perPage: 2, maxPages: 3 });

    expect(res.repos).toHaveLength(2);
    expect(res.repos.map((r) => r.full_name)).toEqual(['acme/app', 'acme/docs']);
    expect(res.hasMore).toBe(false);

    const firstUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(firstUrl).toContain('/user/repos?');
    expect(firstUrl).toContain('affiliation=owner%2Ccollaborator%2Corganization_member');
    expect(firstUrl).toContain('sort=pushed');
    expect(firstUrl).not.toContain('type=');
  });

  it('marks hasMore true when maxPages still has a next link', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { full_name: 'acme/repo-1', private: false },
          { full_name: 'acme/repo-2', private: true },
        ]),
        {
          status: 200,
          headers: {
            link: '<https://api.github.com/user/repos?page=2>; rel="next"',
          },
        },
      ),
    );

    const api = new GitHubApi({ token: 'ghp_test', fetchImpl: fetchMock });
    const res = await api.listViewerRepos({ perPage: 2, maxPages: 1 });

    expect(res.repos).toHaveLength(2);
    expect(res.hasMore).toBe(true);
  });

  it('probes /notifications access cleanly without marking anything read', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ message: 'Resource not accessible by personal access token' }),
          { status: 403 },
        ),
      );

    const api = new GitHubApi({ token: 'ghp_test', fetchImpl: fetchMock });
    const okRes = await api.probeNotificationsAccess();
    expect(okRes).toEqual({ ok: true, status: 200 });

    const deniedRes = await api.probeNotificationsAccess();
    expect(deniedRes.ok).toBe(false);
    expect(deniedRes.status).toBe(403);
    expect(deniedRes.error).toContain('Resource not accessible');
  });

  it('lists open repository pull requests with conditional ETag 304 caching', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 71,
              number: 18,
              title: 'feat: oauth',
              state: 'open',
              html_url: 'https://github.com/acme/api/pull/18',
              requested_reviewers: [{ id: 1, login: 'octocat' }],
              created_at: '2026-11-27T01:00:00Z',
              updated_at: '2026-11-27T01:05:00Z',
            },
          ]),
          { status: 200, headers: { etag: '"pr-v1"' } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 304, headers: { etag: '"pr-v1"' } }));

    const api = new GitHubApi({ token: 'ghp_test', fetchImpl: fetchMock });
    const first = await api.listRepoPulls({ owner: 'acme', repo: 'api' });
    expect(first.notModified).toBe(false);
    expect(first.etag).toBe('"pr-v1"');
    expect(first.items[0]?.requested_reviewers?.[0]?.login).toBe('octocat');

    const second = await api.listRepoPulls({
      owner: 'acme',
      repo: 'api',
      etag: '"pr-v1"',
    });
    expect(second.notModified).toBe(true);
    expect(second.items).toEqual([]);
  });
});
