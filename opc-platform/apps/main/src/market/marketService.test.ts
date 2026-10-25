import { describe, expect, it } from 'vitest';
import { PACKAGE_FORMAT, parseAgentPackage } from './marketService';

describe('agent package parsing', () => {
  it('accepts the documented envelope', () => {
    const { agents } = parseAgentPackage(
      JSON.stringify({
        format: PACKAGE_FORMAT,
        name: 'team-pack',
        agents: [{ name: '林工', role: '前端工程师', skills: ['React'], level: 'P6' }],
      }),
    );
    expect(agents).toHaveLength(1);
    expect(agents[0]?.name).toBe('林工');
  });

  it('treats a bare agent object as a one-agent package', () => {
    const { agents } = parseAgentPackage(JSON.stringify({ name: '单兵', role: '研究员' }));
    expect(agents).toHaveLength(1);
  });

  it('drops agents without a name or role', () => {
    const { agents } = parseAgentPackage(
      JSON.stringify({ format: PACKAGE_FORMAT, agents: [{ name: 'A' }, { name: 'B', role: 'QA' }] }),
    );
    expect(agents.map((agent) => agent.name)).toEqual(['B']);
  });

  it('rejects an unknown format', () => {
    expect(() => parseAgentPackage(JSON.stringify({ format: 'other@9', agents: [] }))).toThrow(/不支持的包格式/);
  });

  it('rejects an empty package and invalid JSON', () => {
    expect(() => parseAgentPackage(JSON.stringify({ agents: [] }))).toThrow(/没有可用的 Agent/);
    expect(() => parseAgentPackage('{nope')).toThrow(/不是合法的 JSON/);
  });
});
