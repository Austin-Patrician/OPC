import type {
  ChannelAccessConfig,
  ChannelConnectionTestResult,
  ChannelPairingRequest,
  ChannelRuntimeStatus,
  ChannelTargetView,
  ChannelTestDraft,
  ChannelView,
  GitHubRepoListResult,
} from '@opc/shared/domain';
import type { ChannelStore } from '../store';
import type {
  ChannelInboundMessage,
  ChannelPlugin,
  ChannelPluginContext,
  ChannelSendPayload,
  ChannelSendResult,
  ChannelThinkingCleanup,
} from '../types';
import {
  GitHubApi,
  GitHubApiError,
  normalizeGitHubApiBaseUrl,
  type GitHubIssueComment,
  type GitHubIssueOrPr,
  type GitHubNotification,
  type GitHubPullSummary,
} from './githubApi';
import {
  buildGitHubOutboundMessages,
  formatGitHubAddress,
  hasWakeWord,
  isSelfBotReply,
  matchesGitHubRepoPattern,
  parseGitHubAddress,
  parseGitHubRepoName,
  stripGitHubMention,
  stripWakeWord,
} from './githubFormat';

const MAX_SEEN_FINGERPRINTS = 1000;
const MAX_REACTION_TARGETS = 300;
const BASE_BACKOFF_MS = 10_000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const COLD_BOOT_GRACE_MS = 2 * 60 * 1000;
const REPO_LIST_TIMEOUT_MS = 12_000;

type ReactionTargetRef = {
  owner: string;
  repo: string;
  target: { kind: 'comment'; commentId: number } | { kind: 'issue'; number: number };
};

export class GitHubPlugin implements ChannelPlugin {
  readonly id = 'github' as const;
  readonly name = 'GitHub';
  readonly transport = 'polling' as const;
  /** Never post public pairing prompts onto GitHub repositories. */
  readonly silentPairing = true;

  private ctx: ChannelPluginContext | null = null;
  private api: GitHubApi | null = null;
  private selfLogin: string | undefined;
  private activeRunId = 0;
  private pollAbort: AbortController | null = null;
  private waitTimer: ReturnType<typeof setTimeout> | null = null;
  private waitResolve: (() => void) | null = null;

  private startedAtMs = 0;
  private usingDedicatedNotificationsToken = false;
  private notificationsDisabledForRun = false;
  private notificationsEtag: string | undefined;
  private notificationsLastModified: string | undefined;
  private serverPollIntervalSec = 0;
  private repoCommentEtags = new Map<string, string>();
  private repoIssueEtags = new Map<string, string>();
  private repoPullEtags = new Map<string, string>();
  private knownWatchRepos = new Set<string>();
  private repoWatchedSinceMs = new Map<string, number>();
  private seenFingerprints = new Set<string>();
  private reactionTargets = new Map<string, ReactionTargetRef>();

  private status: ChannelRuntimeStatus = {
    channelId: 'github',
    transport: 'polling',
    state: 'disabled',
  };

  constructor(private readonly store: ChannelStore) {}

  isConfigured(): boolean {
    return Boolean(this.store.getGitHubConfig().token);
  }

  isEnabled(): boolean {
    return this.store.getGitHubConfig().enabled;
  }

  shouldMirrorToDesktop(): boolean {
    return this.store.getGitHubConfig().mirrorToDesktop;
  }

  getAccessConfig(): ChannelAccessConfig {
    const access = this.store.getGitHubConfig().access;
    if (this.selfLogin && !access.dmAllowlist.includes(this.selfLogin)) {
      return {
        ...access,
        dmAllowlist: [...access.dmAllowlist, this.selfLogin],
      };
    }
    return access;
  }

  getRuntimeStatus(): ChannelRuntimeStatus {
    return { ...this.status };
  }

  toChannelView(extra: {
    pendingPairings: ChannelPairingRequest[];
    knownTargets: ChannelTargetView[];
  }): ChannelView {
    return {
      id: this.id,
      name: this.name,
      transport: this.transport,
      configured: this.isConfigured(),
      status: this.getRuntimeStatus(),
      settings: this.store.getGitHubSettingsView(),
      pendingPairings: extra.pendingPairings,
      knownTargets: extra.knownTargets,
    };
  }

  matchesAddress(address: string): boolean {
    return parseGitHubAddress(address) !== null;
  }

  formatTargetAddress(
    _chatKind: 'p2p' | 'group',
    ids: { chatId: string; senderId: string },
  ): string {
    return ids.chatId.includes('#') ? `github:${ids.chatId}` : ids.chatId || ids.senderId;
  }

  extractDisplayChatId(address: string): string {
    const parsed = parseGitHubAddress(address);
    return parsed ? `${parsed.fullRepo}#${parsed.number}` : address;
  }

  private setStatus(patch: Partial<ChannelRuntimeStatus>): void {
    this.status = {
      ...this.status,
      ...patch,
      channelId: this.id,
      transport: this.transport,
    };
    this.ctx?.onStatusChange();
  }

  private stopPollingOnly(): void {
    this.activeRunId += 1;
    if (this.pollAbort) {
      this.pollAbort.abort();
      this.pollAbort = null;
    }
    if (this.waitTimer) {
      clearTimeout(this.waitTimer);
      this.waitTimer = null;
    }
    if (this.waitResolve) {
      const resolve = this.waitResolve;
      this.waitResolve = null;
      resolve();
    }
    this.api = null;
  }

  async start(ctx: ChannelPluginContext): Promise<void> {
    this.ctx = ctx;
    this.stopPollingOnly();

    const cfg = this.store.getGitHubConfig();
    if (!cfg.enabled) {
      this.setStatus({
        state: 'disabled',
        pollingMode: undefined,
        lastError: undefined,
        lastErrorAt: undefined,
      });
      return;
    }

    if (!cfg.token) {
      this.setStatus({
        state: 'disconnected',
        pollingMode: undefined,
        lastError: '请填写 GitHub 主 Personal Access Token (PAT)',
        lastErrorAt: Date.now(),
      });
      return;
    }

    let api: GitHubApi;
    let notificationsApi: GitHubApi;
    try {
      api = new GitHubApi({
        token: cfg.token,
        apiBaseUrl: cfg.apiBaseUrl,
      });
      notificationsApi = cfg.notificationsToken
        ? new GitHubApi({
            token: cfg.notificationsToken,
            apiBaseUrl: cfg.apiBaseUrl,
          })
        : api;
    } catch (error) {
      this.setStatus({
        state: 'error',
        pollingMode: undefined,
        lastError: error instanceof Error ? error.message : String(error),
        lastErrorAt: Date.now(),
      });
      return;
    }

    this.api = api;
    this.usingDedicatedNotificationsToken = Boolean(cfg.notificationsToken);
    const runId = this.activeRunId;
    this.setStatus({
      state: 'connecting',
      pollingMode: undefined,
      lastError: undefined,
      lastErrorAt: undefined,
    });

    try {
      const viewer = await api.getViewer();
      if (this.activeRunId !== runId) return;
      this.selfLogin = viewer.login.toLowerCase();
      this.startedAtMs = Date.now();
      this.notificationsDisabledForRun = false;
      this.notificationsEtag = undefined;
      this.notificationsLastModified = undefined;
      this.serverPollIntervalSec = 0;
      this.repoCommentEtags.clear();
      this.repoIssueEtags.clear();
      this.repoPullEtags.clear();
      this.knownWatchRepos = new Set(cfg.watchRepos);
      this.repoWatchedSinceMs.clear();

      const label = viewer.name ? `@${viewer.login} (${viewer.name})` : `@${viewer.login}`;
      this.setStatus({
        state: 'connected',
        botName: label,
        botOpenId: viewer.login,
        connectedAt: Date.now(),
        lastError: undefined,
        lastErrorAt: undefined,
      });
    } catch (error) {
      if (this.activeRunId !== runId) return;
      this.setStatus({
        state: 'error',
        pollingMode: undefined,
        lastError: error instanceof Error ? error.message : String(error),
        lastErrorAt: Date.now(),
      });
      return;
    }

    void this.pollLoop(runId, api, notificationsApi);
  }

  async stop(): Promise<void> {
    this.stopPollingOnly();
    const cfg = this.store.getGitHubConfig();
    this.setStatus({
      state: cfg.enabled ? 'disconnected' : 'disabled',
      pollingMode: undefined,
    });
  }

  async reconnect(): Promise<void> {
    if (!this.ctx) return;
    await this.start(this.ctx);
  }

  async testConnection(draft?: unknown): Promise<ChannelConnectionTestResult> {
    const startedAt = Date.now();
    const stored = this.store.getGitHubConfig();
    const patch = (draft && typeof draft === 'object' ? draft : {}) as ChannelTestDraft;
    const token =
      typeof patch.token === 'string' && patch.token.trim() ? patch.token.trim() : stored.token;
    const notificationsToken =
      typeof patch.notificationsToken === 'string' && patch.notificationsToken.trim()
        ? patch.notificationsToken.trim()
        : patch.notificationsToken === ''
          ? ''
          : stored.notificationsToken;
    const apiBaseUrl =
      typeof patch.apiBaseUrl === 'string' ? patch.apiBaseUrl.trim() : stored.apiBaseUrl;

    if (!token) {
      return {
        ok: false,
        error: '请先填写 GitHub 主 Personal Access Token (PAT)',
        latencyMs: 0,
      };
    }

    try {
      normalizeGitHubApiBaseUrl(apiBaseUrl);
      const tempApi = new GitHubApi({ token, apiBaseUrl });
      const baseResult = await tempApi.verifyConnection();
      if (!baseResult.ok) {
        return baseResult;
      }

      const notifApi = notificationsToken
        ? new GitHubApi({ token: notificationsToken, apiBaseUrl })
        : tempApi;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REPO_LIST_TIMEOUT_MS);
      let notifProbe: { ok: boolean; status?: number; error?: string };
      try {
        notifProbe = await notifApi.probeNotificationsAccess(controller.signal);
      } catch (probeErr) {
        const message =
          probeErr instanceof Error && probeErr.name === 'AbortError'
            ? '探测 /notifications 权限超时'
            : probeErr instanceof Error
              ? probeErr.message
              : String(probeErr);
        notifProbe = { ok: false, error: message };
      } finally {
        clearTimeout(timer);
      }

      const totalLatency = Date.now() - startedAt;
      if (notificationsToken && !notifProbe.ok) {
        return {
          ok: false,
          botName: baseResult.botName,
          botOpenId: baseResult.botOpenId,
          latencyMs: totalLatency,
          error: `主 Token 验证通过（${baseResult.botName ?? 'GitHub'}），但通知专用 Classic PAT 无法访问 /notifications（${notifProbe.error ?? `HTTP ${notifProbe.status ?? '?'}`}）。请确认它是 Classic PAT 且勾选了 notifications 权限。`,
        };
      }

      return {
        ...baseResult,
        latencyMs: totalLatency,
        detail: notifProbe.ok
          ? notificationsToken
            ? '双 Token 校验通过：全局通知 (/notifications) 与仓库接口均可用。'
            : '全局通知 (/notifications) 与仓库接口均可用。'
          : '主 Token 校验通过，但无 /notifications 权限，将以「仅关注仓库模式」运行（如需全账号跨仓库通知，可在下方选填通知专用 Classic PAT）。',
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - startedAt,
      };
    }
  }

  refreshWatchRepos(): void {
    const allowed = new Set(this.store.getGitHubConfig().watchRepos);
    const now = Date.now();
    for (const key of this.repoCommentEtags.keys()) {
      if (!allowed.has(key)) this.repoCommentEtags.delete(key);
    }
    for (const key of this.repoIssueEtags.keys()) {
      if (!allowed.has(key)) this.repoIssueEtags.delete(key);
    }
    for (const key of this.repoPullEtags.keys()) {
      if (!allowed.has(key)) this.repoPullEtags.delete(key);
    }
    for (const key of this.repoWatchedSinceMs.keys()) {
      if (!allowed.has(key)) this.repoWatchedSinceMs.delete(key);
    }
    for (const key of allowed) {
      if (!this.knownWatchRepos.has(key)) {
        this.repoWatchedSinceMs.set(key, now);
      }
    }
    this.knownWatchRepos = allowed;

    if (this.waitTimer) {
      clearTimeout(this.waitTimer);
      this.waitTimer = null;
    }
    if (this.waitResolve) {
      const resolve = this.waitResolve;
      this.waitResolve = null;
      resolve();
    }
  }

  async listGitHubRepos(draft?: unknown): Promise<GitHubRepoListResult> {
    const stored = this.store.getGitHubConfig();
    const patch = (draft && typeof draft === 'object' ? draft : {}) as ChannelTestDraft;
    const token =
      typeof patch.token === 'string' && patch.token.trim() ? patch.token.trim() : stored.token;
    const apiBaseUrl =
      typeof patch.apiBaseUrl === 'string' ? patch.apiBaseUrl.trim() : stored.apiBaseUrl;

    if (!token) {
      return {
        ok: false,
        repos: [],
        error: '请先填写 GitHub Personal Access Token (PAT)',
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REPO_LIST_TIMEOUT_MS);
    try {
      normalizeGitHubApiBaseUrl(apiBaseUrl);
      const tempApi = new GitHubApi({ token, apiBaseUrl });
      const { repos, hasMore } = await tempApi.listViewerRepos({
        maxPages: 2,
        perPage: 100,
        signal: controller.signal,
      });
      return {
        ok: true,
        repos: repos.map((item) => {
          const desc = typeof item.description === 'string' ? item.description.trim() : '';
          return {
            fullName: item.full_name,
            private: Boolean(item.private),
            ...(desc ? { description: desc } : {}),
            ...(item.pushed_at ? { pushedAt: item.pushed_at } : {}),
            ...(item.archived ? { archived: true } : {}),
          };
        }),
        hasMore,
      };
    } catch (error) {
      const message =
        error instanceof Error && error.name === 'AbortError'
          ? '拉取 GitHub 仓库列表超时，请检查「设置 → 网络与代理」配置'
          : error instanceof Error
            ? error.message
            : String(error);
      return {
        ok: false,
        repos: [],
        error: message,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private waitMs(runId: number, delayMs: number): Promise<void> {
    if (this.activeRunId !== runId) return Promise.resolve();
    return new Promise((resolve) => {
      this.waitResolve = resolve;
      this.waitTimer = setTimeout(() => {
        this.waitTimer = null;
        this.waitResolve = null;
        resolve();
      }, delayMs);
      this.waitTimer.unref?.();
    });
  }

  private async pollLoop(
    runId: number,
    api: GitHubApi,
    notificationsApi: GitHubApi,
  ): Promise<void> {
    let failures = 0;

    while (this.activeRunId === runId) {
      const controller = new AbortController();
      this.pollAbort = controller;
      const cfg = this.store.getGitHubConfig();

      try {
        await this.pollOnce(runId, api, notificationsApi, controller.signal);
        if (this.activeRunId !== runId) return;
        failures = 0;
        const nextMode = this.notificationsDisabledForRun
          ? 'repos_only'
          : 'notifications_and_repos';
        if (
          this.status.state !== 'connected' ||
          this.status.lastError ||
          this.status.pollingMode !== nextMode
        ) {
          this.setStatus({
            state: 'connected',
            pollingMode: nextMode,
            connectedAt: this.status.connectedAt ?? Date.now(),
            lastError: undefined,
            lastErrorAt: undefined,
          });
        }
        const waitSec = Math.max(cfg.pollIntervalSec, this.serverPollIntervalSec, 30);
        await this.waitMs(runId, waitSec * 1000);
      } catch (error) {
        if (this.activeRunId !== runId) return;
        failures += 1;
        const retryAfterMs =
          error instanceof GitHubApiError && error.retryAfterSec
            ? error.retryAfterSec * 1000
            : Math.min(BASE_BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);
        this.setStatus({
          state: 'reconnecting',
          pollingMode: this.notificationsDisabledForRun ? 'repos_only' : undefined,
          lastError: error instanceof Error ? error.message : String(error),
          lastErrorAt: Date.now(),
        });
        await this.waitMs(runId, retryAfterMs);
      } finally {
        if (this.pollAbort === controller) {
          this.pollAbort = null;
        }
      }
    }
  }

  private async pollOnce(
    runId: number,
    api: GitHubApi,
    notificationsApi: GitHubApi,
    signal: AbortSignal,
  ): Promise<void> {
    const cfg = this.store.getGitHubConfig();

    // 1. Poll personal participating notifications (dedicated Classic PAT if provided, else primary PAT).
    if (!this.notificationsDisabledForRun) {
      try {
        const notifRes = await notificationsApi.listNotifications({
          ...(this.notificationsEtag ? { etag: this.notificationsEtag } : {}),
          ...(this.notificationsLastModified ? { lastModified: this.notificationsLastModified } : {}),
          participating: true,
          signal,
        });
        if (this.activeRunId !== runId) return;
        if (notifRes.etag) this.notificationsEtag = notifRes.etag;
        if (notifRes.lastModified) this.notificationsLastModified = notifRes.lastModified;
        if (notifRes.pollIntervalSec) this.serverPollIntervalSec = notifRes.pollIntervalSec;

        if (!notifRes.notModified) {
          for (const notif of notifRes.items) {
            if (this.activeRunId !== runId) return;
            await this.processNotification(api, notif, signal).catch((err) => {
              console.warn('[channels:github] 处理通知失败', err);
            });
          }
        }
      } catch (error) {
        if (error instanceof GitHubApiError && (error.status === 401 || error.status === 403)) {
          if (this.usingDedicatedNotificationsToken) {
            throw new GitHubApiError(
              `通知专用 Classic PAT 无权访问 /notifications（${error.message}）。请确认它是 Classic PAT 且勾选了 notifications 权限，或清除该字段以改用仅关注仓库模式。`,
              { status: error.status },
            );
          }
          if (error.status === 403) {
            // Fine-grained PATs (or Classic PATs missing `notifications`) return HTTP 403 on
            // /notifications. Fall back cleanly to polling explicitly configured `watchRepos`.
            this.notificationsDisabledForRun = true;
          } else {
            throw error;
          }
        } else {
          throw error;
        }
      }
    }

    if (this.notificationsDisabledForRun && cfg.watchRepos.length === 0) {
      throw new GitHubApiError(
        '当前主 PAT 无全局 /notifications 权限（GitHub Fine-grained PAT 默认不支持全局通知接口）。请在下方的「重点关注仓库」点击「拉取仓库」勾选至少 1 个仓库（仅关注仓库模式），或选填具备 notifications 权限的通知专用 Classic PAT。',
        { status: 403 },
      );
    }

    // 2. Poll explicitly watched repositories (catches self wake-word commands & repo activity).
    for (const rawRepo of cfg.watchRepos) {
      if (this.activeRunId !== runId) return;
      const repo = parseGitHubRepoName(rawRepo);
      if (!repo) continue;
      const repoSinceMs = this.repoWatchedSinceMs.get(repo.fullRepo) ?? this.startedAtMs;
      const sinceIso = new Date(repoSinceMs - COLD_BOOT_GRACE_MS).toISOString();

      try {
        const commentRes = await api.listRepoComments({
          owner: repo.owner,
          repo: repo.repo,
          sinceIso,
          ...(this.repoCommentEtags.get(repo.fullRepo)
            ? { etag: this.repoCommentEtags.get(repo.fullRepo) }
            : {}),
          signal,
        });
        if (commentRes.etag) this.repoCommentEtags.set(repo.fullRepo, commentRes.etag);
        if (!commentRes.notModified) {
          for (const comment of commentRes.items) {
            await this.processRepoComment(api, repo.fullRepo, comment, signal).catch((err) => {
              console.warn('[channels:github] 处理仓库评论失败', err);
            });
          }
        }

        const shouldPollIssues =
          cfg.events.repoActivity ||
          (this.notificationsDisabledForRun && (cfg.events.mention || cfg.events.assigned));
        if (shouldPollIssues) {
          const issueRes = await api.listRepoIssues({
            owner: repo.owner,
            repo: repo.repo,
            sinceIso,
            ...(this.repoIssueEtags.get(repo.fullRepo)
              ? { etag: this.repoIssueEtags.get(repo.fullRepo) }
              : {}),
            signal,
          });
          if (issueRes.etag) this.repoIssueEtags.set(repo.fullRepo, issueRes.etag);
          if (!issueRes.notModified) {
            for (const issue of issueRes.items) {
              await this.processRepoIssue(repo.fullRepo, issue).catch((err) => {
                console.warn('[channels:github] 处理仓库新 Issue/PR 失败', err);
              });
            }
          }
        }

        if (this.notificationsDisabledForRun && cfg.events.reviewRequested) {
          const pullRes = await api.listRepoPulls({
            owner: repo.owner,
            repo: repo.repo,
            state: 'open',
            ...(this.repoPullEtags.get(repo.fullRepo)
              ? { etag: this.repoPullEtags.get(repo.fullRepo) }
              : {}),
            signal,
          });
          if (pullRes.etag) this.repoPullEtags.set(repo.fullRepo, pullRes.etag);
          if (!pullRes.notModified) {
            for (const pr of pullRes.items) {
              await this.processRepoPullReview(repo.fullRepo, pr).catch((err) => {
                console.warn('[channels:github] 处理仓库 PR Review 请求失败', err);
              });
            }
          }
        }
      } catch (error) {
        if (error instanceof GitHubApiError && error.status === 403) {
          throw new GitHubApiError(
            `无权访问仓库 ${repo.fullRepo}（${error.message}）。请确认该 PAT 已授权此仓库并勾选 Issues / Pull requests 权限。`,
            { status: 403 },
          );
        }
        throw error;
      }
    }
  }

  private rememberFingerprint(key: string): boolean {
    if (this.seenFingerprints.has(key)) return false;
    if (this.seenFingerprints.size >= MAX_SEEN_FINGERPRINTS) {
      const oldest = this.seenFingerprints.values().next().value;
      if (oldest) this.seenFingerprints.delete(oldest);
    }
    this.seenFingerprints.add(key);
    return true;
  }

  private rememberReactionTarget(messageId: string, ref: ReactionTargetRef): void {
    if (this.reactionTargets.size >= MAX_REACTION_TARGETS && !this.reactionTargets.has(messageId)) {
      const oldest = this.reactionTargets.keys().next().value;
      if (oldest) this.reactionTargets.delete(oldest);
    }
    this.reactionTargets.set(messageId, ref);
  }

  private extractIssueNumberFromUrl(rawUrl?: string | null): number | null {
    if (!rawUrl) return null;
    const match = /\/(?:issues|pulls)\/(\d+)$/.exec(rawUrl);
    return match?.[1] ? Number(match[1]) : null;
  }

  private async processNotification(
    api: GitHubApi,
    notif: GitHubNotification,
    signal: AbortSignal,
  ): Promise<void> {
    const updatedMs = Date.parse(notif.updated_at);
    if (Number.isFinite(updatedMs) && updatedMs < this.startedAtMs - COLD_BOOT_GRACE_MS) {
      return;
    }

    if (notif.subject.type !== 'Issue' && notif.subject.type !== 'PullRequest') return;

    const cfg = this.store.getGitHubConfig();
    const fullRepo = notif.repository.full_name;
    if (!matchesGitHubRepoPattern(fullRepo, cfg.access.groupAllowlist)) return;

    const reason = notif.reason;
    if (reason === 'review_requested' && !cfg.events.reviewRequested) return;
    if (reason === 'assign' && !cfg.events.assigned) return;
    if ((reason === 'mention' || reason === 'team_mention') && !cfg.events.mention) return;

    const repoParts = parseGitHubRepoName(fullRepo);
    if (!repoParts) return;

    let number = this.extractIssueNumberFromUrl(notif.subject.url);
    let subjectData: GitHubIssueOrPr | undefined;
    if (notif.subject.url) {
      try {
        subjectData = await api.fetchByUrl<GitHubIssueOrPr>(notif.subject.url, signal);
        if (!number && subjectData.number) number = subjectData.number;
      } catch (error) {
        if (error instanceof GitHubApiError && (error.status === 403 || error.status === 404)) {
          console.warn(
            `[channels:github] 主 Token 无权读取通知仓库 ${fullRepo}#${number ?? '?'} 详情，已安全忽略`,
          );
          return;
        }
        throw error;
      }
    }
    if (!number) return;

    let commentData: GitHubIssueComment | undefined;
    if (
      notif.subject.latest_comment_url &&
      notif.subject.latest_comment_url !== notif.subject.url
    ) {
      try {
        commentData = await api.fetchByUrl<GitHubIssueComment>(
          notif.subject.latest_comment_url,
          signal,
        );
      } catch (error) {
        if (!(error instanceof GitHubApiError && (error.status === 403 || error.status === 404))) {
          throw error;
        }
      }
    }

    const author = commentData?.user ?? subjectData?.user;
    const rawBody = commentData?.body ?? subjectData?.body ?? '';
    const isComment = Boolean(commentData);

    // For generic `comment` / `author` notifications, only surface when mentioned or woken.
    if (reason !== 'review_requested' && reason !== 'assign' && reason !== 'mention' && reason !== 'team_mention') {
      const woken =
        hasWakeWord(rawBody, cfg.wakeWord) ||
        Boolean(this.selfLogin && rawBody.toLowerCase().includes(`@${this.selfLogin}`));
      if (!woken) return;
    }

    const fingerprint = commentData
      ? `gh:comment:${commentData.id}`
      : `gh:notif:${notif.id}:${notif.updated_at}`;

    await this.dispatchGitHubEvent({
      fingerprint,
      repo: repoParts,
      number,
      itemTitle: notif.subject.title || subjectData?.title || `#${number}`,
      isPr: notif.subject.type === 'PullRequest' || Boolean(subjectData?.pull_request),
      eventKind:
        reason === 'review_requested'
          ? 'github.pr_review'
          : isComment
            ? 'github.comment'
            : 'github.issue',
      reasonLabel: reason,
      authorLogin: author?.login ?? '',
      isBotAuthor:
        author?.type === 'Bot' || Boolean(author?.login?.toLowerCase().endsWith('[bot]')),
      rawBody,
      htmlUrl: commentData?.html_url ?? subjectData?.html_url ?? '',
      timestampMs: Number.isFinite(updatedMs) ? updatedMs : Date.now(),
      reactionTarget: commentData
        ? { owner: repoParts.owner, repo: repoParts.repo, target: { kind: 'comment', commentId: commentData.id } }
        : { owner: repoParts.owner, repo: repoParts.repo, target: { kind: 'issue', number } },
    });
  }

  private async processRepoComment(
    api: GitHubApi,
    fullRepo: string,
    comment: GitHubIssueComment,
    signal: AbortSignal,
  ): Promise<void> {
    const createdMs = Date.parse(comment.created_at);
    const repoSinceMs = this.repoWatchedSinceMs.get(fullRepo) ?? this.startedAtMs;
    if (Number.isFinite(createdMs) && createdMs < repoSinceMs - COLD_BOOT_GRACE_MS) {
      return;
    }

    const cfg = this.store.getGitHubConfig();
    if (!matchesGitHubRepoPattern(fullRepo, cfg.access.groupAllowlist)) return;

    const number = this.extractIssueNumberFromUrl(comment.issue_url);
    const repoParts = parseGitHubRepoName(fullRepo);
    if (!number || !repoParts) return;

    const rawBody = comment.body ?? '';
    const authorLogin = comment.user?.login ?? '';
    const isSelf = Boolean(this.selfLogin && authorLogin.toLowerCase() === this.selfLogin);
    const mentionsSelf = Boolean(
      this.selfLogin && rawBody.toLowerCase().includes(`@${this.selfLogin}`),
    );
    const woken = hasWakeWord(rawBody, cfg.wakeWord);

    if (isSelf && !woken) return;
    if (!isSelf && !cfg.events.repoActivity && !mentionsSelf && !woken) return;

    const issue = await api.getIssueOrPr(repoParts.owner, repoParts.repo, number, signal);

    await this.dispatchGitHubEvent({
      fingerprint: `gh:comment:${comment.id}`,
      repo: repoParts,
      number,
      itemTitle: issue.title || `#${number}`,
      isPr: Boolean(issue.pull_request),
      eventKind: 'github.comment',
      reasonLabel: woken ? 'wake_word' : 'comment',
      authorLogin,
      isBotAuthor:
        comment.user?.type === 'Bot' || authorLogin.toLowerCase().endsWith('[bot]'),
      rawBody,
      htmlUrl: comment.html_url,
      timestampMs: Number.isFinite(createdMs) ? createdMs : Date.now(),
      reactionTarget: {
        owner: repoParts.owner,
        repo: repoParts.repo,
        target: { kind: 'comment', commentId: comment.id },
      },
    });
  }

  private async processRepoIssue(fullRepo: string, issue: GitHubIssueOrPr): Promise<void> {
    const createdMs = Date.parse(issue.created_at);
    const repoSinceMs = this.repoWatchedSinceMs.get(fullRepo) ?? this.startedAtMs;
    if (Number.isFinite(createdMs) && createdMs < repoSinceMs - COLD_BOOT_GRACE_MS) {
      return;
    }

    const cfg = this.store.getGitHubConfig();
    if (!matchesGitHubRepoPattern(fullRepo, cfg.access.groupAllowlist)) return;
    const repoParts = parseGitHubRepoName(fullRepo);
    if (!repoParts) return;

    const authorLogin = issue.user?.login ?? '';
    const rawBody = issue.body ?? '';
    const isSelf = Boolean(this.selfLogin && authorLogin.toLowerCase() === this.selfLogin);
    const mentionsSelf = Boolean(
      this.selfLogin && rawBody.toLowerCase().includes(`@${this.selfLogin}`),
    );
    const woken = hasWakeWord(rawBody, cfg.wakeWord);
    const assignedToSelf = Boolean(
      this.selfLogin && issue.assignees?.some((u) => u.login.toLowerCase() === this.selfLogin),
    );

    if (isSelf && !woken) return;
    if (!isSelf && !cfg.events.repoActivity) {
      const triggered =
        (cfg.events.mention && (mentionsSelf || woken)) ||
        (cfg.events.assigned && assignedToSelf);
      if (!triggered) return;
    }

    const reasonLabel = woken
      ? 'wake_word'
      : mentionsSelf
        ? 'mention'
        : assignedToSelf
          ? 'assign'
          : 'opened';

    await this.dispatchGitHubEvent({
      fingerprint: `gh:issue:${repoParts.fullRepo}#${issue.number}`,
      repo: repoParts,
      number: issue.number,
      itemTitle: issue.title,
      isPr: Boolean(issue.pull_request),
      eventKind: issue.pull_request ? 'github.pull_request' : 'github.issue',
      reasonLabel,
      authorLogin,
      isBotAuthor:
        issue.user?.type === 'Bot' || authorLogin.toLowerCase().endsWith('[bot]'),
      rawBody,
      htmlUrl: issue.html_url,
      timestampMs: Number.isFinite(createdMs) ? createdMs : Date.now(),
      reactionTarget: {
        owner: repoParts.owner,
        repo: repoParts.repo,
        target: { kind: 'issue', number: issue.number },
      },
    });
  }

  private async processRepoPullReview(
    fullRepo: string,
    pr: GitHubPullSummary,
  ): Promise<void> {
    if (!this.selfLogin) return;
    const requested = pr.requested_reviewers?.some(
      (reviewer) => reviewer.login.toLowerCase() === this.selfLogin,
    );
    if (!requested) return;

    const updatedMs = Date.parse(pr.updated_at);
    const repoSinceMs = this.repoWatchedSinceMs.get(fullRepo) ?? this.startedAtMs;
    if (Number.isFinite(updatedMs) && updatedMs < repoSinceMs - COLD_BOOT_GRACE_MS) {
      return;
    }

    const cfg = this.store.getGitHubConfig();
    if (!matchesGitHubRepoPattern(fullRepo, cfg.access.groupAllowlist)) return;
    const repoParts = parseGitHubRepoName(fullRepo);
    if (!repoParts) return;

    const authorLogin = pr.user?.login ?? '';
    await this.dispatchGitHubEvent({
      fingerprint: `gh:pr_review:${repoParts.fullRepo}#${pr.number}:${this.selfLogin}`,
      repo: repoParts,
      number: pr.number,
      itemTitle: pr.title,
      isPr: true,
      eventKind: 'github.pr_review',
      reasonLabel: 'review_requested',
      authorLogin,
      isBotAuthor:
        pr.user?.type === 'Bot' || authorLogin.toLowerCase().endsWith('[bot]'),
      rawBody: pr.body ?? '',
      htmlUrl: pr.html_url,
      timestampMs: Number.isFinite(updatedMs) ? updatedMs : Date.now(),
      reactionTarget: {
        owner: repoParts.owner,
        repo: repoParts.repo,
        target: { kind: 'issue', number: pr.number },
      },
    });
  }

  private async dispatchGitHubEvent(input: {
    fingerprint: string;
    repo: { owner: string; repo: string; fullRepo: string };
    number: number;
    itemTitle: string;
    isPr: boolean;
    eventKind: string;
    reasonLabel: string;
    authorLogin: string;
    isBotAuthor: boolean;
    rawBody: string;
    htmlUrl: string;
    timestampMs: number;
    reactionTarget: ReactionTargetRef;
  }): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;

    if (isSelfBotReply(input.rawBody)) return;
    if (input.isBotAuthor || !input.authorLogin) return;

    const cfg = this.store.getGitHubConfig();
    const authorNorm = input.authorLogin.toLowerCase();
    const isSelf = Boolean(this.selfLogin && authorNorm === this.selfLogin);

    if (isSelf && !hasWakeWord(input.rawBody, cfg.wakeWord)) {
      return;
    }

    if (!this.rememberFingerprint(input.fingerprint)) return;

    this.setStatus({ lastEventAt: Date.now() });

    const address = formatGitHubAddress(input.repo.fullRepo, input.number);
    const cleanedBody = stripWakeWord(
      stripGitHubMention(input.rawBody, this.selfLogin),
      cfg.wakeWord,
    );
    const itemKindLabel = input.isPr ? 'Pull Request' : 'Issue';
    const contextHeader = `[GitHub ${itemKindLabel}] ${input.repo.fullRepo}#${input.number} · ${input.itemTitle} (${input.reasonLabel})`;
    const contextText = [
      contextHeader,
      input.htmlUrl ? `链接: ${input.htmlUrl}` : '',
      cleanedBody ? `\n${cleanedBody}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    this.rememberReactionTarget(input.fingerprint, input.reactionTarget);

    const inbound: ChannelInboundMessage = {
      channelId: this.id,
      channelName: this.name,
      transport: this.transport,
      source: 'github',
      eventKind: input.eventKind,
      threadKey: address,
      messageId: input.fingerprint,
      chatId: input.repo.fullRepo,
      chatKind: 'p2p',
      chatTitle: `${input.repo.fullRepo}#${input.number} ${input.itemTitle}`,
      senderId: authorNorm,
      senderName: `@${input.authorLogin}`,
      isBotSender: false,
      mentionsBot: true,
      text: contextText,
      attachments: [],
      timestamp: input.timestampMs,
      replyTarget: {
        adapterId: this.id,
        source: 'github',
        address,
        messageId: input.fingerprint,
      },
    };

    await ctx.onInboundMessage(inbound);
  }

  async markThinking(messageId: string): Promise<ChannelThinkingCleanup | undefined> {
    const cfg = this.store.getGitHubConfig();
    if (!cfg.thinkingReaction || !cfg.autoReplyToGitHub || !this.api || !messageId) {
      return undefined;
    }

    const ref = this.reactionTargets.get(messageId);
    if (!ref) return undefined;

    const api = this.api;
    try {
      const reactionId = await api.addReaction(ref.target, ref.owner, ref.repo, 'eyes');
      let cleared = false;
      return async () => {
        if (cleared || !reactionId) return;
        cleared = true;
        await api.deleteReaction(ref.target, ref.owner, ref.repo, reactionId).catch(() => undefined);
      };
    } catch {
      return undefined;
    }
  }

  async sendMessage(payload: ChannelSendPayload): Promise<ChannelSendResult> {
    const parsed = parseGitHubAddress(payload.address);
    if (!parsed) {
      return { ok: false, error: `无效的 GitHub 会话地址: ${payload.address}` };
    }

    const cfg = this.store.getGitHubConfig();
    if (!cfg.autoReplyToGitHub) {
      // Desktop mirror-only mode: succeed without posting comments back to GitHub.
      return { ok: true };
    }

    if (!this.api) {
      return { ok: false, error: 'GitHub 渠道当前未连接，请先在设置中启用并配置 PAT' };
    }

    try {
      const chunks = buildGitHubOutboundMessages(
        payload.blocks,
        payload.text,
        payload.attachments,
      );
      let lastId: string | undefined;
      for (const body of chunks) {
        const created = await this.api.createIssueComment(
          parsed.owner,
          parsed.repo,
          parsed.number,
          body,
        );
        lastId = String(created.id);
      }
      return {
        ok: true,
        ...(lastId ? { messageId: lastId } : {}),
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
