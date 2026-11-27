import { describe, expect, it } from 'vitest';
import {
  buildGitHubOutboundMessages,
  formatGitHubAddress,
  GITHUB_BOT_REPLY_MARKER,
  hasWakeWord,
  isSelfBotReply,
  matchesGitHubRepoPattern,
  parseGitHubAddress,
  parseGitHubRepoName,
  stripGitHubMention,
  stripWakeWord,
} from './githubFormat';

describe('githubFormat', () => {
  it('formats and parses github:owner/repo#number addresses cleanly', () => {
    const addr = formatGitHubAddress('acme/api-server', 128);
    expect(addr).toBe('github:acme/api-server#128');
    expect(parseGitHubAddress(addr)).toEqual({
      owner: 'acme',
      repo: 'api-server',
      fullRepo: 'acme/api-server',
      number: 128,
    });
    expect(parseGitHubAddress('github:acme/api')).toBeNull();
    expect(parseGitHubAddress('telegram:chat:123')).toBeNull();
  });

  it('normalizes repo names and evaluates repo allowlist patterns including org wildcards', () => {
    expect(parseGitHubRepoName('https://github.com/Acme/Core.git/')).toEqual({
      owner: 'Acme',
      repo: 'Core',
      fullRepo: 'Acme/Core',
    });
    expect(matchesGitHubRepoPattern('acme/api', [])).toBe(true);
    expect(matchesGitHubRepoPattern('Acme/API', ['acme/api'])).toBe(true);
    expect(matchesGitHubRepoPattern('Acme/Web', ['acme/*'])).toBe(true);
    expect(matchesGitHubRepoPattern('other/repo', ['acme/*'])).toBe(false);
  });

  it('handles wake words, @mentions, and self-loop marker detection', () => {
    expect(hasWakeWord('/buddy 帮我看一下这个报错', '/buddy')).toBe(true);
    expect(hasWakeWord('看起来不错\n/BUDDY: 检查边界条件', '/buddy')).toBe(true);
    expect(hasWakeWord('普通评论内容', '/buddy')).toBe(false);

    expect(stripWakeWord('/buddy 帮我看一下\n第二行', '/buddy')).toBe('帮我看一下\n第二行');
    expect(stripGitHubMention('@OctoCat 请审查这个 PR\n详细日志', 'octocat')).toBe(
      '请审查这个 PR\n详细日志',
    );
    expect(isSelfBotReply(`已完成\n\n${GITHUB_BOT_REPLY_MARKER}`)).toBe(true);
  });

  it('builds outbound GFM comments with anti-loop marker, attachment notice, and strips opc-media URLs', () => {
    const msgs = buildGitHubOutboundMessages(
      [{ type: 'markdown', text: '分析完成 ![图](opc-media://local/1.png)' }],
      'fallback',
      [{ path: '/tmp/report.pdf', name: 'report.pdf' }],
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('分析完成');
    expect(msgs[0]).not.toContain('opc-media://');
    expect(msgs[0]).toContain('`report.pdf`');
    expect(msgs[0]).toContain(GITHUB_BOT_REPLY_MARKER);
  });
});
