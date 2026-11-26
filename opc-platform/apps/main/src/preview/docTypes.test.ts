import { describe, expect, it } from 'vitest';
import { classifyDocPreview, DOC_PREVIEW_LIMITS, parseByteRange } from './docTypes';

describe('classifyDocPreview', () => {
  it('routes Office ecosystem and common formats accurately', () => {
    expect(classifyDocPreview('report.docx', 1024).kind).toBe('docx');
    expect(classifyDocPreview('budget.xlsx', 1024).kind).toBe('spreadsheet');
    expect(classifyDocPreview('macro.xlsm', 1024).kind).toBe('spreadsheet');
    expect(classifyDocPreview('data.csv', 1024).kind).toBe('spreadsheet');
    expect(classifyDocPreview('slides.pptx', 1024).kind).toBe('pptx');
    expect(classifyDocPreview('paper.pdf', 1024).kind).toBe('pdf');
    expect(classifyDocPreview('README.md', 1024).kind).toBe('text');
    expect(classifyDocPreview('diagram.PNG', 1024).kind).toBe('image');
  });

  it('marks legacy binary formats as unsupported', () => {
    expect(classifyDocPreview('legacy.doc', 2048).kind).toBe('unsupported');
    expect(classifyDocPreview('legacy.xls', 2048).kind).toBe('unsupported');
    expect(classifyDocPreview('legacy.ppt', 2048).kind).toBe('unsupported');
  });

  it('flags oversized files for external fallback without rejecting them', () => {
    const oversizedDocx = classifyDocPreview('huge.docx', DOC_PREVIEW_LIMITS.docx + 1);
    expect(oversizedDocx.kind).toBe('docx');
    expect(oversizedDocx.tooLargeForInApp).toBe(true);

    const allowedPdf = classifyDocPreview('big.pdf', DOC_PREVIEW_LIMITS.pdf);
    expect(allowedPdf.kind).toBe('pdf');
    expect(allowedPdf.tooLargeForInApp).toBe(false);
  });
});

describe('parseByteRange', () => {
  it('parses open-ended, closed, and suffix byte ranges', () => {
    expect(parseByteRange(null, 1000)).toEqual({ kind: 'full' });
    expect(parseByteRange('bytes=0-99', 1000)).toEqual({ kind: 'partial', start: 0, end: 99 });
    expect(parseByteRange('bytes=500-', 1000)).toEqual({ kind: 'partial', start: 500, end: 999 });
    expect(parseByteRange('bytes=500-5000', 1000)).toEqual({ kind: 'partial', start: 500, end: 999 });
    expect(parseByteRange('bytes=-100', 1000)).toEqual({ kind: 'partial', start: 900, end: 999 });
  });

  it('rejects malformed or out-of-bounds ranges', () => {
    expect(parseByteRange('bytes=1000-1050', 1000)).toEqual({ kind: 'invalid' });
    expect(parseByteRange('bytes=50-10', 1000)).toEqual({ kind: 'invalid' });
    expect(parseByteRange('bytes=-', 1000)).toEqual({ kind: 'invalid' });
    expect(parseByteRange('items=0-10', 1000)).toEqual({ kind: 'invalid' });
  });
});
