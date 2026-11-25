import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatAttachmentRef } from '@opc/shared/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { listWorkspaceFiles, stageAttachmentsToWorkspace } from './workspace';

describe('stageAttachmentsToWorkspace and listWorkspaceFiles', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('copies attachments into inputs/ without hardlinks, deduplicates collisions, and omits inputs/ from outputs', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-stage-inputs-'));
    dirs.push(base);
    const workspace = path.join(base, 'workspace');
    const srcA = path.join(base, 'srcA', '个人简历.pdf');
    const srcB = path.join(base, 'srcB', '个人简历.pdf');
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(path.dirname(srcA), { recursive: true });
    fs.mkdirSync(path.dirname(srcB), { recursive: true });
    fs.writeFileSync(srcA, 'pdf-version-a');
    fs.writeFileSync(srcB, 'pdf-version-b-longer');
    fs.writeFileSync(path.join(workspace, 'translated.docx'), 'docx-bytes');

    const refs: ChatAttachmentRef[] = [
      { id: '1', name: '个人简历.pdf', path: srcA, size: 13, source: 'file' },
      { id: '2', name: '个人简历.pdf', path: srcB, size: 20, source: 'file' },
      { id: '3', name: 'missing.pdf', path: path.join(base, 'does-not-exist.pdf'), size: 10, source: 'file' },
    ];

    const result = stageAttachmentsToWorkspace(workspace, refs);
    expect(result.staged).toHaveLength(2);
    expect(result.missing).toHaveLength(1);

    const copyA = result.staged[0]!.path;
    const copyB = result.staged[1]!.path;
    expect(copyA).toBe(path.join(workspace, 'inputs', '个人简历.pdf'));
    expect(copyB).toBe(path.join(workspace, 'inputs', '个人简历-2.pdf'));
    expect(fs.readFileSync(copyA, 'utf8')).toBe('pdf-version-a');
    expect(fs.readFileSync(copyB, 'utf8')).toBe('pdf-version-b-longer');

    // Mutating the workspace copy never mutates the user's original source file (copy, not hardlink).
    fs.writeFileSync(copyA, 'mutated-copy');
    expect(fs.readFileSync(srcA, 'utf8')).toBe('pdf-version-a');
    expect(fs.statSync(copyA).nlink).toBe(1);

    // Retrying with already-staged workspace inputs reuses cleanly without duplicating.
    const secondPass = stageAttachmentsToWorkspace(workspace, [result.staged[1]!]);
    expect(secondPass.staged[0]!.path).toBe(copyB);

    // `listWorkspaceFiles` excludes top-level `inputs/` so input attachments are not treated as deliverables.
    expect(listWorkspaceFiles(workspace).map((file) => file.relPath)).toEqual(['translated.docx']);
  });
});
