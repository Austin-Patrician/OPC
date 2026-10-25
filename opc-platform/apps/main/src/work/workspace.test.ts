import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWithin } from './workspace';

const root = path.resolve('/tmp/opc-workspace');

describe('resolveWithin', () => {
  it('resolves a normal relative path inside the workspace', () => {
    expect(resolveWithin(root, 'src/server.js')).toBe(path.join(root, 'src/server.js'));
  });

  it('rejects traversal that escapes the workspace', () => {
    expect(() => resolveWithin(root, '../../etc/passwd')).toThrow(/路径越界/);
    expect(() => resolveWithin(root, 'a/../../outside.txt')).toThrow(/路径越界/);
  });

  it('rejects absolute paths outright', () => {
    expect(() => resolveWithin(root, '/etc/passwd')).toThrow(/绝对路径/);
  });

  it('allows the root itself but not a sibling with the same prefix', () => {
    expect(resolveWithin(root, '.')).toBe(root);
    expect(() => resolveWithin(root, '../opc-workspace-evil/x')).toThrow(/路径越界/);
  });
});
