import { describe, expect, it } from 'vitest';
import {
  classifyInlineEntity,
  extractEmailFromMailto,
  isValidEmail,
  normalizeExternalUrl,
  parseFilePathEntity,
  tokenizeProseEntities,
} from './chatEntities';

describe('chatEntities', () => {
  it('validates emails and extracts mailto addresses', () => {
    expect(isValidEmail('alice.smith@company.co.uk')).toBe(true);
    expect(isValidEmail('@team')).toBe(false);
    expect(isValidEmail('alice@localhost')).toBe(false);
    expect(extractEmailFromMailto('mailto:bob@example.com?subject=Report')).toBe('bob@example.com');
    expect(extractEmailFromMailto('https://example.com')).toBeNull();
  });

  it('normalizes HTTP(S) URLs and extracts concise domain + display path', () => {
    expect(normalizeExternalUrl('https://www.github.com/org/repo/issues/12')).toEqual({
      type: 'url',
      raw: 'https://www.github.com/org/repo/issues/12',
      href: 'https://www.github.com/org/repo/issues/12',
      domain: 'github.com',
      displayPath: '/org/repo/issues/12',
    });
    expect(normalizeExternalUrl('javascript:alert(1)')).toBeNull();
  });

  it('recognizes Windows/POSIX/file:// and project subpaths without false positives', () => {
    expect(parseFilePathEntity('E:\\code\\austin\\OPC\\App.tsx:42:5')).toMatchObject({
      path: 'E:\\code\\austin\\OPC\\App.tsx',
      fileName: 'App.tsx',
      ext: 'tsx',
      line: 42,
      col: 5,
      isAbsolute: true,
      isDirectory: false,
    });

    expect(parseFilePathEntity('file:///C:/Users/admin/report.pdf')).toMatchObject({
      path: 'C:/Users/admin/report.pdf',
      fileName: 'report.pdf',
      ext: 'pdf',
      isAbsolute: true,
      fromFileUrl: true,
    });

    expect(parseFilePathEntity('~/outputs/summary.docx')).toMatchObject({
      path: '~/outputs/summary.docx',
      fileName: 'summary.docx',
      ext: 'docx',
      isAbsolute: true,
    });

    expect(parseFilePathEntity('apps/renderer/src/shared/lib/')).toMatchObject({
      fileName: 'lib',
      isAbsolute: false,
      isDirectory: true,
    });

    // Reject MIME types, scoped npm names, UNC paths, math ratios, dotted JS identifiers
    expect(parseFilePathEntity('application/json')).toBeNull();
    expect(parseFilePathEntity('@opc/shared')).toBeNull();
    expect(parseFilePathEntity('\\\\server\\share\\file.txt')).toBeNull();
    expect(parseFilePathEntity('3/4')).toBeNull();
    expect(parseFilePathEntity('window.opc')).toBeNull();
  });

  it('classifies inline backtick content as email, URL, or file path', () => {
    expect(classifyInlineEntity('dev@example.com')?.type).toBe('email');
    expect(classifyInlineEntity('https://example.com/api')?.type).toBe('url');
    expect(classifyInlineEntity('apps/main/src/index.ts:10')?.type).toBe('file');
    expect(classifyInlineEntity('git status')).toBeNull();
  });

  it('tokenizes mixed prose accurately without misreading emails as @mentions or swallowing punctuation', () => {
    const segments = tokenizeProseEntities(
      '联系 alice@example.com，查看 https://en.wikipedia.org/wiki/Foo_(bar)。文件在 E:\\outputs\\季报.xlsx，请 @林工 确认。',
    );
    expect(segments.map((s) => [s.type, s.value])).toEqual([
      ['text', '联系 '],
      ['email', 'alice@example.com'],
      ['text', '，查看 '],
      ['link', 'https://en.wikipedia.org/wiki/Foo_(bar)'],
      ['text', '。文件在 '],
      ['file', 'E:\\outputs\\季报.xlsx'],
      ['text', '，请 '],
      ['mention', '@林工'],
      ['text', ' 确认。'],
    ]);

    const cjkSegments = tokenizeProseEntities('参考 https://zh.wikipedia.org/wiki/上海，以及 file:///C:/outputs/季报.xlsx。');
    expect(cjkSegments.map((s) => [s.type, s.value])).toEqual([
      ['text', '参考 '],
      ['link', 'https://zh.wikipedia.org/wiki/上海'],
      ['text', '，以及 '],
      ['file', 'file:///C:/outputs/季报.xlsx'],
      ['text', '。'],
    ]);
  });
});
