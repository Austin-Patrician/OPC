import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyDeclaredOutputs } from './deliverableCheck';
import { listWorkspaceFiles } from './workspace';

describe('verifyDeclaredOutputs 双层交付物校验', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const makeWorkspace = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-deliverable-'));
    dirs.push(dir);
    return dir;
  };

  it('精确命中嵌套路径（含 Windows 反斜杠风格声明规范化）', () => {
    const ws = makeWorkspace();
    fs.mkdirSync(path.join(ws, 'outputs'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'outputs', 'resume.pdf'), 'pdf-content');

    const files = listWorkspaceFiles(ws);
    const result = verifyDeclaredOutputs({
      outputs: [{ kind: 'file', path: 'outputs\\resume.pdf', description: '中文简历' }],
      workspaceDir: ws,
      files,
      answer: '已完成',
    });

    expect(result.ok).toBe(true);
    expect(result.mapped).toEqual([]);
  });

  it('工作区超过 50 个文件时通过 direct stat 精确命中并写入 discoveredFiles', () => {
    const ws = makeWorkspace();
    for (let i = 0; i < 60; i += 1) {
      fs.writeFileSync(path.join(ws, `00-temp-${String(i).padStart(2, '0')}.txt`), 'x');
    }
    fs.mkdirSync(path.join(ws, 'zzz'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'zzz', 'final-report.pdf'), 'real-pdf');

    const files = listWorkspaceFiles(ws, 50);
    expect(files.some((f) => f.relPath === 'zzz/final-report.pdf')).toBe(false);

    const result = verifyDeclaredOutputs({
      outputs: [{ kind: 'file', path: 'zzz/final-report.pdf', description: '最终报告' }],
      workspaceDir: ws,
      files,
      answer: '',
    });

    expect(result.ok).toBe(true);
    expect(result.discoveredFiles.map((f) => f.relPath)).toContain('zzz/final-report.pdf');
  });

  it('output/ 与 outputs/ 同名文件自动映射通过并记录 mapped', () => {
    const ws = makeWorkspace();
    fs.mkdirSync(path.join(ws, 'output'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'output', '张浮生_中文简历.pdf'), 'pdf-bytes');

    const files = listWorkspaceFiles(ws);
    const result = verifyDeclaredOutputs({
      outputs: [{ kind: 'file', path: 'outputs/张浮生_中文简历.pdf', description: '简历 PDF' }],
      workspaceDir: ws,
      files,
      answer: '',
    });

    expect(result.ok).toBe(true);
    expect(result.mapped).toEqual([
      {
        declared: 'outputs/张浮生_中文简历.pdf',
        actual: 'output/张浮生_中文简历.pdf',
        strategy: 'basename',
      },
    ]);
  });

  it('同工作区仅有唯一文档交付物（如 output/张浮生_中文版.pdf）时按扩展名自动匹配，且排除 inputs/work/browser/tiny/test', () => {
    const ws = makeWorkspace();
    fs.mkdirSync(path.join(ws, 'inputs'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'work'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'browser'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'output'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'inputs', 'resume.pdf'), 'input-pdf');
    fs.writeFileSync(path.join(ws, 'work', 'draft.pdf'), 'draft-pdf');
    fs.writeFileSync(path.join(ws, 'browser', 'shot.pdf'), 'browser-pdf');
    fs.writeFileSync(path.join(ws, 'tiny.pdf'), 'probe-pdf');
    fs.writeFileSync(path.join(ws, 'test-probe.pdf'), 'probe-pdf');
    fs.writeFileSync(path.join(ws, 'output', '张浮生_中文版.pdf'), 'real-translated-pdf');

    const files = listWorkspaceFiles(ws);
    const result = verifyDeclaredOutputs({
      outputs: [{ kind: 'file', path: 'outputs/张浮生_中文简历.pdf', description: '翻译后简历' }],
      workspaceDir: ws,
      files,
      answer: '',
    });

    expect(result.ok).toBe(true);
    expect(result.mapped).toEqual([
      {
        declared: 'outputs/张浮生_中文简历.pdf',
        actual: 'output/张浮生_中文版.pdf',
        strategy: 'unique-extension',
      },
    ]);
  });

  it('不会对代码文件做扩展名盲配，也不会把 1 个 PDF 匹配给 2 个声明的 PDF', () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, 'helper.js'), 'console.log(1);');
    fs.mkdirSync(path.join(ws, 'output'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'output', 'only.pdf'), 'pdf');

    const files = listWorkspaceFiles(ws);
    const codeCheck = verifyDeclaredOutputs({
      outputs: [{ kind: 'file', path: 'server.js', description: 'HTTP 服务' }],
      workspaceDir: ws,
      files,
      answer: '',
    });
    expect(codeCheck.ok).toBe(false);
    expect(codeCheck.reason).toContain('缺少文件交付物：server.js');
    expect(codeCheck.existingFiles).toContain('helper.js');

    const multiPdfCheck = verifyDeclaredOutputs({
      outputs: [
        { kind: 'file', path: 'output/a.pdf', description: 'A' },
        { kind: 'file', path: 'output/b.pdf', description: 'B' },
      ],
      workspaceDir: ws,
      files,
      answer: '',
    });
    expect(multiPdfCheck.ok).toBe(false);
    expect(multiPdfCheck.reason).toContain('缺少文件交付物');
  });

  it('拒绝 0 字节二进制交付物', () => {
    const ws = makeWorkspace();
    fs.mkdirSync(path.join(ws, 'output'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'output', 'empty.pdf'), '');

    const result = verifyDeclaredOutputs({
      outputs: [{ kind: 'file', path: 'output/empty.pdf', description: 'PDF' }],
      workspaceDir: ws,
      files: listWorkspaceFiles(ws),
      answer: '',
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('0 字节');
  });
});
