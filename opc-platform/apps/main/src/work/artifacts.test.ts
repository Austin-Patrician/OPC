import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isThumbnailable, readImageArtifact } from './artifacts';

const roots: string[] = [];

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-art-'));
  roots.push(root);
  const taskDir = path.join(root, 'tasks', 'task-1');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, 'icon.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  fs.writeFileSync(path.join(taskDir, 'notes.txt'), 'hello');
  return { root, taskDir };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('isThumbnailable', () => {
  it('accepts raster images only', () => {
    expect(isThumbnailable('icon.png')).toBe(true);
    expect(isThumbnailable('a/b/photo.JPG')).toBe(true);
    expect(isThumbnailable('report.pdf')).toBe(false);
    expect(isThumbnailable('server.js')).toBe(false);
  });
});

describe('readImageArtifact', () => {
  it('returns a data URL for an image inside the task workspace', () => {
    const { root } = workspace();
    const result = readImageArtifact(root, path.join('tasks', 'task-1'), 'icon.png');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
      expect(result.bytes).toBe(70);
    }
  });

  it('refuses non-images and paths outside the workspace', () => {
    const { root } = workspace();
    expect(readImageArtifact(root, path.join('tasks', 'task-1'), 'notes.txt')).toMatchObject({ ok: false });
    expect(readImageArtifact(root, path.join('tasks', 'task-1'), '../../etc/passwd.png')).toMatchObject({
      ok: false,
      error: '路径越界',
    });
  });
});
