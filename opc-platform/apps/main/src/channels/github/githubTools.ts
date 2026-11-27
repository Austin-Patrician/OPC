import { defineExtension, defineTool, section } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import type { ChannelStore } from '../store';
import { GitHubApi } from './githubApi';
import { parseGitHubAddress, parseGitHubRepoName } from './githubFormat';

const MAX_DIFF_CHARS = 24_000;

function resolveApi(store: ChannelStore): GitHubApi {
  const cfg = store.getGitHubConfig();
  if (!cfg.token) {
    throw new Error('GitHub PAT 尚未配置：请先前往「设置 → 应用渠道 → GitHub」填写 Personal Access Token。');
  }
  return new GitHubApi({
    token: cfg.token,
    apiBaseUrl: cfg.apiBaseUrl,
  });
}

async function resolveRepo(
  raw: string,
  store: ChannelStore,
  api: GitHubApi,
): Promise<{ owner: string; repo: string; fullRepo: string }> {
  const fromAddr = parseGitHubAddress(raw);
  if (fromAddr) {
    return { owner: fromAddr.owner, repo: fromAddr.repo, fullRepo: fromAddr.fullRepo };
  }
  const fromRepo = parseGitHubRepoName(raw);
  if (fromRepo) {
    return fromRepo;
  }

  const short = raw.trim().replace(/\.git$/i, '').toLowerCase();
  if (short && /^[a-z0-9_.-]+$/.test(short)) {
    const cfg = store.getGitHubConfig();
    const watchedMatches = cfg.watchRepos
      .filter((entry) => entry.toLowerCase().split('/')[1] === short)
      .map((entry) => parseGitHubRepoName(entry))
      .filter((item): item is { owner: string; repo: string; fullRepo: string } => item !== null);
    if (watchedMatches.length === 1) {
      return watchedMatches[0]!;
    }
    if (watchedMatches.length > 1) {
      throw new Error(
        `发现多个同名的重点关注仓库：${watchedMatches.map((m) => m.fullRepo).join('、')}，请明确指定 owner/repo。`,
      );
    }

    const { repos } = await api.listViewerRepos({ maxPages: 1, perPage: 100 });
    const viewerMatches = repos
      .filter((item) => item.full_name.toLowerCase().split('/')[1] === short)
      .map((item) => parseGitHubRepoName(item.full_name))
      .filter((item): item is { owner: string; repo: string; fullRepo: string } => item !== null);
    if (viewerMatches.length === 1) {
      return viewerMatches[0]!;
    }
    if (viewerMatches.length > 1) {
      throw new Error(
        `发现多个同名的可访问仓库：${viewerMatches.map((m) => m.fullRepo).join('、')}，请明确指定 owner/repo。`,
      );
    }
  }

  throw new Error(
    `无法定位 GitHub 仓库 "${raw}"，请提供 owner/repo 格式或先调用 github_list_repos 查询已关注/本人可访问仓库。`,
  );
}

const ok = (text: string) => ({ output: [{ type: 'text' as const, text }] });

/**
 * Built-in GitHub research & collaboration tools shared by Router and Workers,
 * reusing the OS-keychain-encrypted PAT from ChannelStore.
 */
export function createGitHubToolsExtension(store: ChannelStore) {
  return defineExtension({
    name: 'opc.github',
    sections: [
      section('github-context', () => {
        const cfg = store.getGitHubConfig();
        if (!cfg.hasToken) return undefined;
        const watchedLine =
          cfg.watchRepos.length > 0
            ? `已配置的重点关注仓库：${cfg.watchRepos.join('、')}`
            : '当前暂未勾选重点关注仓库。';
        return [
          '## GitHub 渠道上下文',
          `用户已配置 GitHub 访问凭证。${watchedLine}`,
          '- 当用户询问「我的 GitHub 项目情况 / 仓库动态 / 项目状态」时：直接对上述重点关注仓库调用 github_list_items、github_list_workflow_runs（若未配置关注仓库或用户想看全部仓库，则先调用 github_list_repos），禁止让用户手动输入 owner/repo。',
          '- 当用户只提到仓库简称（如 wordless）而未带 owner 时：优先匹配上述重点关注仓库，或先调用 github_list_repos(query) 定位用户真实仓库；严禁跳过本人仓库去 web_search 陌生公开同名项目。',
        ].join('\n');
      }),
    ],
    tools: [
      defineTool({
        name: 'github_list_repos',
        description:
          '列出用户已配置的 GitHub「重点关注仓库」以及当前 PAT 可访问的本人/协作仓库（按最近活跃排序）。当用户问「我的 GitHub 项目情况」或只提仓库简称（如 wordless）时优先调用此工具定位真实 owner/repo。',
        parameters: Type.Object({
          query: Type.Optional(
            Type.String({ description: '可选关键词过滤（匹配仓库名或描述，如 wordless）。' }),
          ),
          watched_only: Type.Optional(
            Type.Boolean({ description: '仅返回用户在设置中勾选的重点关注仓库（不发网络请求）。' }),
          ),
          limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
        }),
        async execute(args) {
          const cfg = store.getGitHubConfig();
          const queryLower = (args.query ?? '').trim().toLowerCase();
          const limit = Math.max(1, Math.min(50, Math.round(args.limit ?? 20)));

          if (args.watched_only) {
            const matched = cfg.watchRepos.filter(
              (repo) => !queryLower || repo.toLowerCase().includes(queryLower),
            );
            if (matched.length === 0) {
              return ok(
                cfg.watchRepos.length === 0
                  ? '暂未配置重点关注仓库（可在「设置 → 应用渠道 → GitHub」勾选，或省略 watched_only 拉取 PAT 可访问仓库）。'
                  : `重点关注仓库中没有匹配 "${args.query}" 的项目。`,
              );
            }
            return ok(
              [
                `# 已勾选的重点关注仓库（${matched.length} 个）`,
                ...matched.slice(0, limit).map((repo) => `- ${repo} [重点关注]`),
              ].join('\n'),
            );
          }

          const api = resolveApi(store);
          const [viewer, repoPage] = await Promise.all([
            api.getViewer().catch(() => null),
            api.listViewerRepos({ maxPages: 2, perPage: 100 }),
          ]);

          const watchedSet = new Set(cfg.watchRepos.map((item) => item.toLowerCase()));
          type RepoEntry = {
            fullName: string;
            watched: boolean;
            isPrivate?: boolean;
            archived?: boolean;
            pushedAt?: string;
            description?: string;
          };

          const byLower = new Map<string, RepoEntry>();
          for (const repo of repoPage.repos) {
            const key = repo.full_name.toLowerCase();
            byLower.set(key, {
              fullName: repo.full_name,
              watched: watchedSet.has(key),
              isPrivate: Boolean(repo.private),
              archived: Boolean(repo.archived),
              ...(repo.pushed_at ? { pushedAt: repo.pushed_at } : {}),
              ...(repo.description?.trim() ? { description: repo.description.trim() } : {}),
            });
          }

          const entries: RepoEntry[] = [];
          const emitted = new Set<string>();
          for (const watchedRepo of cfg.watchRepos) {
            const key = watchedRepo.toLowerCase();
            if (emitted.has(key)) continue;
            emitted.add(key);
            entries.push(
              byLower.get(key) ?? {
                fullName: watchedRepo,
                watched: true,
              },
            );
          }
          for (const entry of byLower.values()) {
            const key = entry.fullName.toLowerCase();
            if (emitted.has(key)) continue;
            emitted.add(key);
            entries.push(entry);
          }

          const filtered = entries.filter((entry) => {
            if (!queryLower) return true;
            return (
              entry.fullName.toLowerCase().includes(queryLower) ||
              (entry.description ?? '').toLowerCase().includes(queryLower)
            );
          });

          if (filtered.length === 0) {
            return ok(
              queryLower
                ? `未在已关注或可访问的 GitHub 仓库中找到匹配 "${args.query}" 的项目。`
                : '当前 PAT 暂无可访问的 GitHub 仓库。',
            );
          }

          const header = viewer?.login
            ? `# GitHub 可访问仓库（当前账号 @${viewer.login} · 重点关注 ${cfg.watchRepos.length} 个 · 共 ${filtered.length} 条）`
            : `# GitHub 可访问仓库（重点关注 ${cfg.watchRepos.length} 个 · 共 ${filtered.length} 条）`;
          const lines = filtered.slice(0, limit).map((entry) => {
            const tags: string[] = [];
            if (entry.watched) tags.push('重点关注');
            if (entry.isPrivate !== undefined) tags.push(entry.isPrivate ? '私有' : '公开');
            if (entry.archived) tags.push('已归档');
            if (entry.pushedAt) tags.push(`最近推送 ${entry.pushedAt.slice(0, 10)}`);
            const tagText = tags.length > 0 ? ` [${tags.join(' · ')}]` : '';
            const desc = entry.description ? ` — ${entry.description}` : '';
            return `- ${entry.fullName}${tagText}${desc}`;
          });
          return ok([header, ...lines].join('\n'));
        },
      }),
      defineTool({
        name: 'github_get_item',
        description:
          '读取 GitHub Issue 或 Pull Request 的标题、状态、作者、正文及最近评论列表。适合排查问题详情或了解 PR 上下文。',
        parameters: Type.Object({
          repo: Type.String({
            description: '仓库名称（owner/repo）、github:owner/repo#12 地址，或已关注/本人仓库简称（如 wordless）。',
          }),
          number: Type.Number({ description: 'Issue 或 PR 编号。' }),
          include_comments: Type.Optional(
            Type.Boolean({ description: '是否一并拉取最近 10 条评论（默认 true）。' }),
          ),
        }),
        async execute(args) {
          const api = resolveApi(store);
          const { owner, repo, fullRepo } = await resolveRepo(args.repo, store, api);
          const item = await api.getIssueOrPr(owner, repo, args.number);
          const kind = item.pull_request ? 'Pull Request' : 'Issue';
          const lines = [
            `# [${kind}] ${fullRepo}#${item.number}: ${item.title}`,
            `状态: ${item.state} | 作者: @${item.user?.login ?? 'unknown'} | 链接: ${item.html_url}`,
            '',
            item.body?.trim() || '（无正文描述）',
          ];

          if (args.include_comments !== false) {
            const comments = await api.listIssueComments(owner, repo, args.number, 10);
            if (comments.length > 0) {
              lines.push('', `## 最近评论（${comments.length} 条）`);
              for (const comment of comments) {
                const body = (comment.body ?? '').trim().slice(0, 1200);
                lines.push(`- **@${comment.user?.login ?? 'unknown'}** (${comment.created_at}):\n  ${body}`);
              }
            }
          }
          return ok(lines.join('\n'));
        },
      }),
      defineTool({
        name: 'github_get_pr_diff',
        description: '读取指定 GitHub Pull Request 的变更文件列表与代码 diff patch，用于代码审查或分析修改影响。',
        parameters: Type.Object({
          repo: Type.String({
            description: '仓库名称（owner/repo）或已关注/本人仓库简称（如 wordless）。',
          }),
          number: Type.Number({ description: 'PR 编号。' }),
        }),
        async execute(args) {
          const api = resolveApi(store);
          const { owner, repo, fullRepo } = await resolveRepo(args.repo, store, api);
          const files = await api.getPullFiles(owner, repo, args.number, 30);
          if (files.length === 0) {
            return ok(`${fullRepo}#${args.number} 暂无文件改动。`);
          }
          const sections: string[] = [`# ${fullRepo}#${args.number} 改动文件（${files.length} 个）`];
          let budget = MAX_DIFF_CHARS;
          for (const file of files) {
            const header = `\n## ${file.filename} (${file.status}: +${file.additions} / -${file.deletions})`;
            const patch = file.patch ?? '(二进制或过长已省略 patch)';
            if (budget <= 0) {
              sections.push(`${header}\n(总 Diff 已达长度上限，仅保留文件路径摘要)`);
              continue;
            }
            const clipped = patch.length > budget ? `${patch.slice(0, budget)}\n...（已截断）` : patch;
            budget -= clipped.length;
            sections.push(`${header}\n\`\`\`diff\n${clipped}\n\`\`\``);
          }
          return ok(sections.join('\n'));
        },
      }),
      defineTool({
        name: 'github_list_items',
        description: '列出指定 GitHub 仓库近期的 Issue 或 Pull Request 列表。',
        parameters: Type.Object({
          repo: Type.String({
            description: '仓库名称（owner/repo）或已关注/本人仓库简称（如 wordless）。',
          }),
          state: Type.Optional(
            Type.Union([Type.Literal('open'), Type.Literal('closed'), Type.Literal('all')]),
          ),
          kind: Type.Optional(
            Type.Union([Type.Literal('all'), Type.Literal('issue'), Type.Literal('pr')]),
          ),
          limit: Type.Optional(Type.Number({ minimum: 1, maximum: 30 })),
        }),
        async execute(args) {
          const api = resolveApi(store);
          const { owner, repo, fullRepo } = await resolveRepo(args.repo, store, api);
          const state = args.state ?? 'open';
          const limit = args.limit ?? 15;
          const kindFilter = args.kind ?? 'all';

          if (kindFilter === 'pr') {
            const pullRes = await api.listRepoPulls({
              owner,
              repo,
              state,
              perPage: limit,
            });
            if (pullRes.items.length === 0) {
              return ok(`${fullRepo} 没有符合条件（state=${state}）的 Pull Request。`);
            }
            const lines = pullRes.items.map((pr) => {
              const reviewers = pr.requested_reviewers?.length
                ? ` · 待审: ${pr.requested_reviewers.map((r) => `@${r.login}`).join(', ')}`
                : '';
              return `- #${pr.number} [PR · ${pr.state}] ${pr.title} (@${pr.user?.login ?? 'unknown'}${reviewers} · 更新 ${pr.updated_at.slice(0, 10)}) · ${pr.html_url}`;
            });
            return ok(lines.join('\n'));
          }

          const res = await api.listRepoIssues({
            owner,
            repo,
            state,
            perPage: limit,
          });
          const items = res.items.filter((item) =>
            kindFilter === 'issue' ? !item.pull_request : true,
          );
          if (items.length === 0) {
            return ok(`${fullRepo} 没有符合条件的条目。`);
          }
          const lines = items.map(
            (item) =>
              `- #${item.number} [${item.pull_request ? 'PR' : 'Issue'} · ${item.state}] ${item.title} (@${item.user?.login ?? 'unknown'}) · ${item.html_url}`,
          );
          return ok(lines.join('\n'));
        },
      }),
      defineTool({
        name: 'github_list_workflow_runs',
        description: '查询指定 GitHub 仓库最近的 Actions CI 工作流运行状态与结论。',
        parameters: Type.Object({
          repo: Type.String({
            description: '仓库名称（owner/repo）或已关注/本人仓库简称（如 wordless）。',
          }),
          limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
        }),
        async execute(args) {
          const api = resolveApi(store);
          const { owner, repo, fullRepo } = await resolveRepo(args.repo, store, api);
          const runs = await api.listWorkflowRuns(owner, repo, args.limit ?? 10);
          if (runs.length === 0) {
            return ok(`${fullRepo} 暂无 Actions 运行记录。`);
          }
          const lines = runs.map((run) => {
            const msg = run.head_commit?.message?.split('\n')[0]?.slice(0, 60) ?? '';
            return `- ${run.name ?? 'Workflow'} | ${run.status ?? '?'}/${run.conclusion ?? 'running'} | 分支: ${run.head_branch ?? '-'} | ${msg} · ${run.html_url}`;
          });
          return ok(lines.join('\n'));
        },
      }),
      defineTool({
        name: 'github_create_issue',
        description: '在指定 GitHub 仓库创建一条新 Issue，并返回编号与链接。',
        parameters: Type.Object({
          repo: Type.String({
            description: '仓库名称（owner/repo）或已关注/本人仓库简称（如 wordless）。',
          }),
          title: Type.String({ description: 'Issue 标题。' }),
          body: Type.Optional(Type.String({ description: 'Issue Markdown 正文（可选）。' })),
          labels: Type.Optional(Type.Array(Type.String())),
        }),
        async execute(args) {
          const api = resolveApi(store);
          const { owner, repo, fullRepo } = await resolveRepo(args.repo, store, api);
          const created = await api.createIssue(owner, repo, {
            title: args.title,
            ...(args.body ? { body: args.body } : {}),
            ...(args.labels?.length ? { labels: args.labels } : {}),
          });
          return ok(`已在 ${fullRepo} 创建 Issue #${created.number}：${created.html_url}`);
        },
      }),
      defineTool({
        name: 'github_submit_review',
        description: '向指定 GitHub Pull Request 提交一次 Review 评审意见（COMMENT / APPROVE / REQUEST_CHANGES）。',
        parameters: Type.Object({
          repo: Type.String({
            description: '仓库名称（owner/repo）或已关注/本人仓库简称（如 wordless）。',
          }),
          number: Type.Number({ description: 'PR 编号。' }),
          event: Type.Union([
            Type.Literal('COMMENT'),
            Type.Literal('APPROVE'),
            Type.Literal('REQUEST_CHANGES'),
          ]),
          body: Type.String({ description: 'Review 汇总评论正文（Markdown）。' }),
        }),
        async execute(args) {
          const api = resolveApi(store);
          const { owner, repo, fullRepo } = await resolveRepo(args.repo, store, api);
          const review = await api.submitPullReview(owner, repo, args.number, {
            event: args.event,
            body: args.body,
          });
          return ok(
            `已向 ${fullRepo}#${args.number} 提交 Review（${review.state}）：${review.html_url ?? `#${review.id}`}`,
          );
        },
      }),
    ],
  });
}
