import { threadIdentity } from '../router/threadKey';
import type { NormalizedTrigger, TriggerAdapter, TriggerRequest } from './types';
import { headerOf, matchesGitHubSignature } from './verify';

/**
 * GitHub 适配器。
 *
 * 选它做第一个"真·外部触发源"，因为它的形状能说明 Thread 的定义：**一个 PR 就是一个
 * Thread**。PR 下新来的评论、新的提交、CI 的结论，都是同一个上下文里的后续，不是
 * 三件互不相干的事。所以它们的并线键都是 `github:<owner/repo>#<number>`。
 *
 * 三件事是这个适配器必须做对的，否则接上去就是噪声源：
 *
 * 1. **`ping` 不是活**。接入 GitHub 的第一条投递永远是 `ping`，返回空数组比返回一条
 *    "空事件"干净——程序层本来能靠"没有正文"挡掉它，但那是在用下游的规则补救上游的
 *    偷懒。
 * 2. **投递会重发**。GitHub 在超时、非 2xx 时会重投同一条 `x-github-delivery`。重投
 *    必须落成同一条事件，否则同一个 PR 会被开两条线。
 * 3. **`closed` 是 end-of-thread**。PR 合并/关闭之后，这个身份上不该再有人干活；
 *    把它标成 `terminal` 让上层把线收掉，而不是等它自己烂在那里。
 */

interface GitHubRepo {
  full_name?: string;
}

interface GitHubPayload {
  action?: string;
  number?: number;
  repository?: GitHubRepo;
  sender?: { login?: string };
  pull_request?: {
    number?: number;
    title?: string;
    body?: string | null;
    html_url?: string;
    merged?: boolean;
    head?: { ref?: string };
    user?: { login?: string };
  };
  issue?: {
    number?: number;
    title?: string;
    body?: string | null;
    html_url?: string;
    pull_request?: unknown;
    user?: { login?: string };
  };
  comment?: { body?: string; html_url?: string; user?: { login?: string } };
  commits?: { message?: string; id?: string }[];
  ref?: string;
  check_run?: {
    name?: string;
    conclusion?: string | null;
    html_url?: string;
    pull_requests?: { number?: number }[];
    check_suite?: { head_branch?: string };
  };
}

const WORKFLOW_EVENTS: readonly string[] = [
  'pull_request',
  'issues',
  'issue_comment',
  'push',
  'check_run',
];

/** 正文只留能读的那一层：webhook 原文动辄几十 KB，全是协议细节。 */
function clip(text: string | null | undefined, limit = 2_000): string | undefined {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return undefined;
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`;
}

function repoOf(payload: GitHubPayload): string | null {
  const name = payload.repository?.full_name?.trim();
  return name ? name.toLowerCase() : null;
}

/** 一个 PR / issue 的身份。同一份 PR 的所有后续信号都落在这个键上。 */
function numberIdentity(repo: string, number: number | undefined) {
  if (typeof number !== 'number' || !Number.isFinite(number)) return null;
  return threadIdentity('github', `${repo}#${number}`);
}

function branchIdentity(repo: string, branch: string | undefined) {
  const name = branch?.trim();
  if (!name) return null;
  return threadIdentity('github', `${repo}@${name}`);
}

export function createGitHubAdapter(secret: () => string | null): TriggerAdapter {
  return {
    id: 'github',
    source: 'github',

    matches: (request) => headerOf(request.headers, 'x-github-event') !== undefined,

    verify: (request) => {
      const key = secret()?.trim();
      if (!key) {
        return { ok: false, reason: '没配 GitHub webhook 密钥（设置 → 触发源），无法校验来源' };
      }
      const signature = headerOf(request.headers, 'x-hub-signature-256');
      if (!signature) return { ok: false, reason: '缺少 x-hub-signature-256' };
      return matchesGitHubSignature(key, request.body, signature)
        ? { ok: true }
        : { ok: false, reason: '签名不匹配' };
    },

    normalize: (request) => normalizeGitHub(request),
  };
}

function normalizeGitHub(request: TriggerRequest): NormalizedTrigger[] {
  const event = headerOf(request.headers, 'x-github-event') ?? '';
  // 接入时的那一条：没有要做的事，也没有上下文可讲。
  if (event === 'ping' || !WORKFLOW_EVENTS.includes(event)) return [];

  let payload: GitHubPayload;
  try {
    payload = JSON.parse(request.body) as GitHubPayload;
  } catch {
    return [];
  }

  const repo = repoOf(payload);
  if (!repo) return [];
  const actor = payload.sender?.login ?? '';
  const deliveryId = headerOf(request.headers, 'x-github-delivery');
  const action = payload.action ?? '';
  const base = { ...(deliveryId ? { deliveryId } : {}), ...(actor ? { actor } : {}) };

  switch (event) {
    case 'pull_request': {
      const pr = payload.pull_request ?? {};
      const identity = numberIdentity(repo, pr.number ?? payload.number);
      if (!identity) return [];
      return [
        {
          kind: `pr.${action}`,
          identity,
          summary: `${repo} PR #${identity.externalId.split('#')[1]} ${action}：${pr.title ?? '（无标题）'}`,
          ...(clip(pr.body) ? { text: clip(pr.body)! } : {}),
          ...base,
          replyTarget: {
            adapterId: 'github',
            source: 'github',
            address: identity.key,
          },
          // 合并或关闭：这个身份上不该再有新活。
          ...(action === 'closed' ? { terminal: true } : {}),
        },
      ];
    }

    case 'issues': {
      // 带 `pull_request` 的 issue 其实是 PR：GitHub 把两套 webhook 都发一遍。
      // 不转成同一个键的话，一个 PR 会同时属于两条线。
      const issue = payload.issue ?? {};
      const identity = numberIdentity(repo, issue.number ?? payload.number);
      if (!identity) return [];
      const isPullRequest = Boolean(issue.pull_request);
      return [
        {
          kind: `${isPullRequest ? 'pr' : 'issue'}.${action}`,
          identity,
          summary: `${repo} ${isPullRequest ? 'PR' : 'issue'} #${issue.number} ${action}：${issue.title ?? ''}`,
          ...(clip(issue.body) ? { text: clip(issue.body)! } : {}),
          ...base,
          replyTarget: {
            adapterId: 'github',
            source: 'github',
            address: identity.key,
          },
          ...(action === 'closed' ? { terminal: true } : {}),
        },
      ];
    }

    case 'issue_comment': {
      const issue = payload.issue ?? {};
      const identity = numberIdentity(repo, issue.number ?? payload.number);
      if (!identity || action !== 'created') return [];
      const comment = payload.comment ?? {};
      return [
        {
          kind: 'comment.created',
          identity,
          summary: `${repo} #${issue.number} 有新评论（${comment.user?.login ?? '某人'}）`,
          ...(clip(comment.body) ? { text: clip(comment.body)! } : {}),
          ...base,
          replyTarget: {
            adapterId: 'github',
            source: 'github',
            address: identity.key,
          },
        },
      ];
    }

    case 'push': {
      const branch = payload.ref?.replace('refs/heads/', '');
      const identity = branchIdentity(repo, branch);
      if (!identity) return [];
      const commits = payload.commits ?? [];
      const subjects = commits.map((commit) => `- ${commit.message?.split('\n')[0] ?? ''}`).join('\n');
      return [
        {
          kind: 'push',
          identity,
          summary: `${repo} ${branch} 有 ${commits.length} 个新提交`,
          ...(subjects ? { text: subjects } : {}),
          ...base,
          replyTarget: {
            adapterId: 'github',
            source: 'github',
            address: identity.key,
          },
        },
      ];
    }

    case 'check_run': {
      // CI 是**结果**不是请求：它不新开线，只落在产生它的那个 PR / 分支上。
      const run = payload.check_run ?? {};
      const prNumber = run.pull_requests?.[0]?.number;
      const identity =
        numberIdentity(repo, prNumber) ?? branchIdentity(repo, run.check_suite?.head_branch);
      if (!identity) return [];
      const conclusion = run.conclusion ?? 'running';
      return [
        {
          kind: `check.${conclusion}`,
          identity,
          summary: `${repo} 的检查「${run.name ?? '未命名'}」${conclusion}`,
          ...base,
          replyTarget: {
            adapterId: 'github',
            source: 'github',
            address: identity.key,
          },
        },
      ];
    }

    default:
      return [];
  }
}
