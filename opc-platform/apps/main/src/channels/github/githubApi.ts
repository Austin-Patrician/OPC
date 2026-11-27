export const DEFAULT_GITHUB_API_BASE = 'https://api.github.com';
const VERIFY_TIMEOUT_MS = 10_000;

export type FetchLike = typeof fetch;

export function normalizeGitHubApiBaseUrl(raw?: string): string {
  const trimmed = (raw ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return DEFAULT_GITHUB_API_BASE;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`无效的 GitHub API 地址: ${trimmed}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`GitHub API 地址仅支持 http/https 协议: ${trimmed}`);
  }
  return parsed.toString().replace(/\/+$/, '');
}

export class GitHubApiError extends Error {
  readonly status: number;
  readonly retryAfterSec?: number;

  constructor(message: string, opts: { status: number; retryAfterSec?: number }) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = opts.status;
    this.retryAfterSec = opts.retryAfterSec;
  }
}

export interface GitHubUser {
  id: number;
  login: string;
  name?: string | null;
  type?: string;
}

export interface GitHubRepository {
  full_name: string;
  private?: boolean;
  html_url?: string;
}

export interface GitHubUserRepo {
  full_name: string;
  private?: boolean;
  description?: string | null;
  pushed_at?: string | null;
  archived?: boolean;
}

export interface GitHubNotification {
  id: string;
  reason: string;
  unread: boolean;
  updated_at: string;
  repository: GitHubRepository;
  subject: {
    title: string;
    url: string | null;
    latest_comment_url: string | null;
    type: string;
  };
}

export interface GitHubIssueOrPr {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  state: string;
  html_url: string;
  user?: GitHubUser | null;
  assignees?: GitHubUser[];
  pull_request?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface GitHubPullSummary {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  state: string;
  html_url: string;
  user?: GitHubUser | null;
  requested_reviewers?: GitHubUser[];
  created_at: string;
  updated_at: string;
}

export interface GitHubIssueComment {
  id: number;
  body?: string | null;
  html_url: string;
  issue_url?: string;
  user?: GitHubUser | null;
  created_at: string;
  updated_at: string;
}

export interface GitHubPullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface GitHubWorkflowRun {
  id: number;
  name?: string | null;
  head_branch?: string | null;
  status?: string | null;
  conclusion?: string | null;
  html_url: string;
  created_at: string;
  head_commit?: {
    message?: string;
  } | null;
}

export interface GitHubPollResult<T> {
  notModified: boolean;
  items: T[];
  etag?: string;
  lastModified?: string;
  pollIntervalSec?: number;
}

export interface GitHubApiConfig {
  token: string;
  apiBaseUrl?: string;
  fetchImpl?: FetchLike;
}

export class GitHubApi {
  readonly baseUrl: string;
  private readonly baseOrigin: string;
  private readonly token: string;
  private readonly fetchFn: FetchLike;

  constructor(config: GitHubApiConfig) {
    this.token = config.token.trim();
    this.baseUrl = normalizeGitHubApiBaseUrl(config.apiBaseUrl);
    this.baseOrigin = new URL(this.baseUrl).origin;
    this.fetchFn = config.fetchImpl ?? globalThis.fetch;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'OPC-Buddy/1.0',
      ...(extra ?? {}),
    };
  }

  private async requestJson<T>(
    url: string,
    init?: RequestInit,
  ): Promise<{ status: number; headers: Headers; data: T }> {
    const res = await this.fetchFn(url, {
      ...init,
      headers: this.headers(init?.headers as Record<string, string> | undefined),
    });

    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as { message?: string };
      const retryRaw = res.headers.get('retry-after');
      const retryAfterSec = retryRaw && /^\d+$/.test(retryRaw) ? Number(retryRaw) : undefined;
      throw new GitHubApiError(
        payload.message ? `GitHub API 失败: ${payload.message}` : `GitHub API 失败 (HTTP ${res.status})`,
        {
          status: res.status,
          ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
        },
      );
    }

    const data =
      res.status === 204 ? (undefined as T) : ((await res.json()) as T);
    return { status: res.status, headers: res.headers, data };
  }

  private async pollCollection<T>(
    url: string,
    opts?: { etag?: string; lastModified?: string; signal?: AbortSignal },
  ): Promise<GitHubPollResult<T>> {
    const conditionalHeaders: Record<string, string> = {};
    if (opts?.etag) conditionalHeaders['If-None-Match'] = opts.etag;
    if (opts?.lastModified) conditionalHeaders['If-Modified-Since'] = opts.lastModified;

    const res = await this.fetchFn(url, {
      method: 'GET',
      headers: this.headers(conditionalHeaders),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });

    const etag = res.headers.get('etag') ?? opts?.etag;
    const lastModified = res.headers.get('last-modified') ?? opts?.lastModified;
    const pollRaw = res.headers.get('x-poll-interval');
    const pollIntervalSec =
      pollRaw && /^\d+$/.test(pollRaw) ? Number(pollRaw) : undefined;

    if (res.status === 304) {
      return {
        notModified: true,
        items: [],
        ...(etag ? { etag } : {}),
        ...(lastModified ? { lastModified } : {}),
        ...(pollIntervalSec !== undefined ? { pollIntervalSec } : {}),
      };
    }

    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as { message?: string };
      const retryRaw = res.headers.get('retry-after');
      const retryAfterSec = retryRaw && /^\d+$/.test(retryRaw) ? Number(retryRaw) : undefined;
      throw new GitHubApiError(
        payload.message ? `GitHub API 失败: ${payload.message}` : `GitHub API 失败 (HTTP ${res.status})`,
        {
          status: res.status,
          ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
        },
      );
    }

    const items = (await res.json()) as T[];
    return {
      notModified: false,
      items: Array.isArray(items) ? items : [],
      ...(etag ? { etag } : {}),
      ...(lastModified ? { lastModified } : {}),
      ...(pollIntervalSec !== undefined ? { pollIntervalSec } : {}),
    };
  }

  async fetchByUrl<T>(rawUrl: string, signal?: AbortSignal): Promise<T> {
    const parsed = new URL(rawUrl);
    if (parsed.origin !== this.baseOrigin) {
      throw new Error(`拒绝请求跨域 GitHub 资源 URL: ${parsed.origin}`);
    }
    const { data } = await this.requestJson<T>(parsed.toString(), {
      method: 'GET',
      ...(signal ? { signal } : {}),
    });
    return data;
  }

  async getViewer(signal?: AbortSignal): Promise<GitHubUser> {
    const { data } = await this.requestJson<GitHubUser>(`${this.baseUrl}/user`, {
      method: 'GET',
      ...(signal ? { signal } : {}),
    });
    return data;
  }

  async verifyConnection(): Promise<{
    ok: boolean;
    botName?: string;
    botOpenId?: string;
    error?: string;
    latencyMs: number;
  }> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
    try {
      const user = await this.getViewer(controller.signal);
      const label = user.name ? `@${user.login} (${user.name})` : `@${user.login}`;
      return {
        ok: true,
        botName: label,
        botOpenId: user.login,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      const message =
        error instanceof Error && error.name === 'AbortError'
          ? '连接 GitHub API 超时，请检查「设置 → 网络与代理」配置'
          : error instanceof Error
            ? error.message
            : String(error);
      return {
        ok: false,
        error: message,
        latencyMs: Date.now() - startedAt,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async listNotifications(opts?: {
    etag?: string;
    lastModified?: string;
    participating?: boolean;
    signal?: AbortSignal;
  }): Promise<GitHubPollResult<GitHubNotification>> {
    const params = new URLSearchParams({
      participating: opts?.participating === false ? 'false' : 'true',
      per_page: '30',
    });
    return this.pollCollection<GitHubNotification>(
      `${this.baseUrl}/notifications?${params.toString()}`,
      opts,
    );
  }

  async probeNotificationsAccess(signal?: AbortSignal): Promise<{
    ok: boolean;
    status?: number;
    error?: string;
  }> {
    const res = await this.fetchFn(
      `${this.baseUrl}/notifications?participating=true&per_page=1`,
      {
        method: 'GET',
        headers: this.headers(),
        ...(signal ? { signal } : {}),
      },
    );
    if (res.ok || res.status === 304) {
      return { ok: true, status: res.status };
    }
    const payload = (await res.json().catch(() => ({}))) as { message?: string };
    return {
      ok: false,
      status: res.status,
      error: payload.message ?? `HTTP ${res.status}`,
    };
  }

  async listRepoPulls(params: {
    owner: string;
    repo: string;
    state?: 'open' | 'closed' | 'all';
    etag?: string;
    perPage?: number;
    signal?: AbortSignal;
  }): Promise<GitHubPollResult<GitHubPullSummary>> {
    const qs = new URLSearchParams({
      state: params.state ?? 'open',
      sort: 'updated',
      direction: 'desc',
      per_page: String(params.perPage ?? 20),
    });
    return this.pollCollection<GitHubPullSummary>(
      `${this.baseUrl}/repos/${params.owner}/${params.repo}/pulls?${qs.toString()}`,
      {
        ...(params.etag ? { etag: params.etag } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
      },
    );
  }

  async listViewerRepos(opts?: {
    maxPages?: number;
    perPage?: number;
    signal?: AbortSignal;
  }): Promise<{ repos: GitHubUserRepo[]; hasMore: boolean }> {
    const perPage = Math.max(1, Math.min(100, Math.round(opts?.perPage ?? 100)));
    const maxPages = Math.max(1, Math.min(5, Math.round(opts?.maxPages ?? 2)));
    const seen = new Set<string>();
    const repos: GitHubUserRepo[] = [];
    let hasMore = false;

    for (let page = 1; page <= maxPages; page += 1) {
      const qs = new URLSearchParams({
        affiliation: 'owner,collaborator,organization_member',
        sort: 'pushed',
        direction: 'desc',
        per_page: String(perPage),
        page: String(page),
      });
      const { headers, data } = await this.requestJson<GitHubUserRepo[]>(
        `${this.baseUrl}/user/repos?${qs.toString()}`,
        {
          method: 'GET',
          ...(opts?.signal ? { signal: opts.signal } : {}),
        },
      );
      const batch = Array.isArray(data) ? data : [];
      for (const item of batch) {
        if (!item?.full_name) continue;
        const key = item.full_name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        repos.push(item);
      }

      const linkHeader = headers.get('link') ?? '';
      const hasNextLink = /rel="next"/.test(linkHeader);
      if (batch.length < perPage) {
        hasMore = false;
        break;
      }
      if (linkHeader && !hasNextLink) {
        hasMore = false;
        break;
      }
      if (page === maxPages) {
        hasMore = hasNextLink || !linkHeader;
      }
    }

    return { repos, hasMore };
  }

  async listRepoComments(params: {
    owner: string;
    repo: string;
    sinceIso?: string;
    etag?: string;
    signal?: AbortSignal;
  }): Promise<GitHubPollResult<GitHubIssueComment>> {
    const qs = new URLSearchParams({
      sort: 'created',
      direction: 'desc',
      per_page: '20',
      ...(params.sinceIso ? { since: params.sinceIso } : {}),
    });
    return this.pollCollection<GitHubIssueComment>(
      `${this.baseUrl}/repos/${params.owner}/${params.repo}/issues/comments?${qs.toString()}`,
      {
        ...(params.etag ? { etag: params.etag } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
      },
    );
  }

  async listRepoIssues(params: {
    owner: string;
    repo: string;
    state?: 'open' | 'closed' | 'all';
    sinceIso?: string;
    etag?: string;
    perPage?: number;
    signal?: AbortSignal;
  }): Promise<GitHubPollResult<GitHubIssueOrPr>> {
    const qs = new URLSearchParams({
      state: params.state ?? 'open',
      sort: 'created',
      direction: 'desc',
      per_page: String(params.perPage ?? 20),
      ...(params.sinceIso ? { since: params.sinceIso } : {}),
    });
    return this.pollCollection<GitHubIssueOrPr>(
      `${this.baseUrl}/repos/${params.owner}/${params.repo}/issues?${qs.toString()}`,
      {
        ...(params.etag ? { etag: params.etag } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
      },
    );
  }

  async getIssueOrPr(
    owner: string,
    repo: string,
    number: number,
    signal?: AbortSignal,
  ): Promise<GitHubIssueOrPr> {
    const { data } = await this.requestJson<GitHubIssueOrPr>(
      `${this.baseUrl}/repos/${owner}/${repo}/issues/${number}`,
      { method: 'GET', ...(signal ? { signal } : {}) },
    );
    return data;
  }

  async listIssueComments(
    owner: string,
    repo: string,
    number: number,
    perPage = 10,
    signal?: AbortSignal,
  ): Promise<GitHubIssueComment[]> {
    const { data } = await this.requestJson<GitHubIssueComment[]>(
      `${this.baseUrl}/repos/${owner}/${repo}/issues/${number}/comments?per_page=${perPage}`,
      { method: 'GET', ...(signal ? { signal } : {}) },
    );
    return Array.isArray(data) ? data : [];
  }

  async getPullFiles(
    owner: string,
    repo: string,
    number: number,
    perPage = 30,
    signal?: AbortSignal,
  ): Promise<GitHubPullFile[]> {
    const { data } = await this.requestJson<GitHubPullFile[]>(
      `${this.baseUrl}/repos/${owner}/${repo}/pulls/${number}/files?per_page=${perPage}`,
      { method: 'GET', ...(signal ? { signal } : {}) },
    );
    return Array.isArray(data) ? data : [];
  }

  async listWorkflowRuns(
    owner: string,
    repo: string,
    perPage = 10,
    signal?: AbortSignal,
  ): Promise<GitHubWorkflowRun[]> {
    const { data } = await this.requestJson<{ workflow_runs?: GitHubWorkflowRun[] }>(
      `${this.baseUrl}/repos/${owner}/${repo}/actions/runs?per_page=${perPage}`,
      { method: 'GET', ...(signal ? { signal } : {}) },
    );
    return Array.isArray(data.workflow_runs) ? data.workflow_runs : [];
  }

  async createIssueComment(
    owner: string,
    repo: string,
    number: number,
    body: string,
  ): Promise<{ id: number; html_url: string }> {
    const { data } = await this.requestJson<{ id: number; html_url: string }>(
      `${this.baseUrl}/repos/${owner}/${repo}/issues/${number}/comments`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ body }),
      },
    );
    return data;
  }

  async createIssue(
    owner: string,
    repo: string,
    input: { title: string; body?: string; labels?: string[] },
  ): Promise<{ number: number; html_url: string; title: string }> {
    const { data } = await this.requestJson<{ number: number; html_url: string; title: string }>(
      `${this.baseUrl}/repos/${owner}/${repo}/issues`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(input),
      },
    );
    return data;
  }

  async submitPullReview(
    owner: string,
    repo: string,
    number: number,
    input: { event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'; body: string },
  ): Promise<{ id: number; state: string; html_url?: string }> {
    const { data } = await this.requestJson<{ id: number; state: string; html_url?: string }>(
      `${this.baseUrl}/repos/${owner}/${repo}/pulls/${number}/reviews`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(input),
      },
    );
    return data;
  }

  async addReaction(
    target: { kind: 'comment'; commentId: number } | { kind: 'issue'; number: number },
    owner: string,
    repo: string,
    content: 'eyes' | '+1' | 'rocket' = 'eyes',
  ): Promise<number | undefined> {
    const url =
      target.kind === 'comment'
        ? `${this.baseUrl}/repos/${owner}/${repo}/issues/comments/${target.commentId}/reactions`
        : `${this.baseUrl}/repos/${owner}/${repo}/issues/${target.number}/reactions`;
    const { data } = await this.requestJson<{ id?: number }>(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ content }),
    });
    return data?.id;
  }

  async deleteReaction(
    target: { kind: 'comment'; commentId: number } | { kind: 'issue'; number: number },
    owner: string,
    repo: string,
    reactionId: number,
  ): Promise<void> {
    const url =
      target.kind === 'comment'
        ? `${this.baseUrl}/repos/${owner}/${repo}/issues/comments/${target.commentId}/reactions/${reactionId}`
        : `${this.baseUrl}/repos/${owner}/${repo}/issues/${target.number}/reactions/${reactionId}`;
    await this.requestJson<void>(url, { method: 'DELETE' });
  }
}
