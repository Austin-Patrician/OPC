import { partitionTaskArtifacts, type TaskOutputSpec } from '@opc/shared/domain';
import { describe, expect, it } from 'vitest';

describe('partitionTaskArtifacts', () => {
  it('优先主展示 output/ 与契约产物，把 work/browser/tmp 与根目录探针脚本收进过程文件', () => {
    const artifacts = [
      { id: '1', relPath: 'output/张浮生_中文简历.pdf' },
      { id: '2', relPath: 'work/render_pdf.py' },
      { id: '3', relPath: 'browser/screenshot-1.png' },
      { id: '4', relPath: 'tiny.pdf' },
      { id: '5', relPath: 'helper.py' },
    ];
    const outputs: TaskOutputSpec[] = [
      { kind: 'file', path: 'output/张浮生_中文简历.pdf', description: '中文简历' },
    ];

    const result = partitionTaskArtifacts(artifacts, outputs);
    expect(result.deliverables.map((item) => item.relPath)).toEqual(['output/张浮生_中文简历.pdf']);
    expect(result.intermediate.map((item) => item.relPath)).toEqual([
      'work/render_pdf.py',
      'browser/screenshot-1.png',
      'tiny.pdf',
      'helper.py',
    ]);
  });

  it('兼容 outputs/ 复数目录与 Windows 反斜杠路径', () => {
    const artifacts = [
      { id: '1', relPath: 'outputs\\final-report.pdf' },
      { id: '2', relPath: '_work/draft.md' },
    ];

    const result = partitionTaskArtifacts(artifacts, [
      { kind: 'file', path: 'output/final-report.pdf', description: '报告' },
    ]);
    expect(result.deliverables.map((item) => item.relPath)).toEqual(['outputs\\final-report.pdf']);
    expect(result.intermediate.map((item) => item.relPath)).toEqual(['_work/draft.md']);
  });

  it('契约声明根目录交付文件时保留主交付物，过滤同行探针与过程目录', () => {
    const artifacts = [
      { id: '1', relPath: 'server.js' },
      { id: '2', relPath: 'test.js' },
      { id: '3', relPath: 'tmp/check.log' },
    ];

    const result = partitionTaskArtifacts(artifacts, [
      { kind: 'file', path: 'server.js', description: 'HTTP 服务' },
    ]);
    expect(result.deliverables.map((item) => item.relPath)).toEqual(['server.js']);
    expect(result.intermediate.map((item) => item.relPath)).toEqual(['test.js', 'tmp/check.log']);
  });

  it('无 output(s)/ 且无 file 契约时，保留根目录有效产出并排除过程目录与隐藏/探针文件', () => {
    const artifacts = [
      { id: '1', relPath: 'index.html' },
      { id: '2', relPath: 'report.md' },
      { id: '3', relPath: 'work/extract.py' },
      { id: '4', relPath: 'browser/page.png' },
      { id: '5', relPath: '.cache/state.json' },
      { id: '6', relPath: 'tiny.pdf' },
    ];

    const result = partitionTaskArtifacts(artifacts, [{ kind: 'text', description: '汇报结论' }]);
    expect(result.deliverables.map((item) => item.relPath)).toEqual(['index.html', 'report.md']);
    expect(result.intermediate.map((item) => item.relPath)).toEqual([
      'work/extract.py',
      'browser/page.png',
      '.cache/state.json',
      'tiny.pdf',
    ]);
  });

  it('仅有过程文件时 deliverables 为空且过程文件完整保留', () => {
    const artifacts = [
      { id: '1', relPath: 'work/step1.py' },
      { id: '2', relPath: 'browser/debug.png' },
    ];

    const result = partitionTaskArtifacts(artifacts, []);
    expect(result.deliverables).toEqual([]);
    expect(result.intermediate.map((item) => item.relPath)).toEqual([
      'work/step1.py',
      'browser/debug.png',
    ]);
  });
});
