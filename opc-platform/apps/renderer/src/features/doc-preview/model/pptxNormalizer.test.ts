import { describe, expect, it } from 'vitest';
import {
  applySlideDomFixes,
  extractThemeFonts,
  normalizeParsedPptx,
  resolveThemeTypeface,
  type PptxLike,
  type PptxNodeLike,
  type PptxSlideLike,
} from './pptxNormalizer';

describe('pptxNormalizer', () => {
  it('sorts groups, nested groups, masters, and layouts recursively by XML order', () => {
    const childPic: PptxNodeLike = { order: 8 };
    const childShape: PptxNodeLike = { order: 11, shape: 'rect' };
    const nestedGroup: PptxNodeLike = {
      order: 12,
      chOffset: { x: 0, y: 0 },
      chExtend: { w: 100, h: 100 },
      nodes: [childShape, childPic],
    };
    const topGroup: PptxNodeLike = {
      order: 10,
      chOffset: { x: 0, y: 0 },
      chExtend: { w: 200, h: 200 },
      nodes: [
        { order: 20, shape: 'rect' },
        nestedGroup,
        { order: 5 },
      ],
    };
    const masterNodeA: PptxNodeLike = { order: 30, shape: 'rect', userDrawn: true };
    const masterNodeB: PptxNodeLike = { order: 2, shape: 'rect', userDrawn: true };

    const pptx: PptxLike = {
      slideMaster: [{ nodes: [masterNodeA, masterNodeB] }],
      slideLayouts: [{ nodes: [{ order: 19 }, { order: 4 }] }],
      slides: [{ nodes: [{ order: 99, shape: 'rect' }, topGroup, { order: 1 }] }],
    };

    normalizeParsedPptx(pptx);

    expect(pptx.slideMaster?.[0]?.nodes?.map((n) => n.order)).toEqual([2, 30]);
    expect(pptx.slideLayouts?.[0]?.nodes?.map((n) => n.order)).toEqual([4, 19]);
    expect(pptx.slides?.[0]?.nodes?.map((n) => n.order)).toEqual([1, 10, 99]);
    expect(topGroup.nodes?.map((n) => n.order)).toEqual([5, 12, 20]);
    expect(nestedGroup.nodes?.map((n) => n.order)).toEqual([8, 11]);
  });

  it('repairs 635x EMU-vs-point coordinate explosions inside non-WPS groups when x <= 20000', () => {
    const groupedRect: PptxNodeLike = {
      order: 2,
      shape: 'rect',
      // Miscomputed by pptx-preview (/ 20 instead of / 12700)
      offset: { x: 0, y: 63500 },
      extend: { w: 317500, h: 31750 },
      source: {
        'p:spPr': {
          'a:xfrm': {
            'a:off': { attrs: { x: '0', y: '1270000' } },
            'a:ext': { attrs: { cx: '6350000', cy: '635000' } },
          },
        },
      },
    };
    const groupNode: PptxNodeLike = {
      order: 1,
      offset: { x: 100, y: 50 },
      extend: { w: 600, h: 400 },
      chOffset: { x: 0, y: 0 },
      chExtend: { w: 600, h: 400 },
      source: {
        'p:grpSpPr': {
          'a:xfrm': {
            'a:off': { attrs: { x: '1270000', y: '635000' } },
            'a:ext': { attrs: { cx: '7620000', cy: '5080000' } },
            'a:chOff': { attrs: { x: '0', y: '0' } },
            'a:chExt': { attrs: { cx: '7620000', cy: '5080000' } },
          },
        },
      },
      nodes: [groupedRect],
    };

    const nonWpsDeck: PptxLike = { wps: false, slides: [{ nodes: [groupNode] }] };
    normalizeParsedPptx(nonWpsDeck);

    expect(groupedRect.offset).toEqual({ x: 0, y: 100 });
    expect(groupedRect.extend).toEqual({ w: 500, h: 50 });

    // WPS decks legitimately use point units and must not be overwritten.
    const wpsRect: PptxNodeLike = {
      order: 2,
      shape: 'rect',
      offset: { x: 0, y: 50 },
      extend: { w: 120, h: 40 },
      source: groupedRect.source,
    };
    const wpsGroup: PptxNodeLike = {
      ...groupNode,
      nodes: [wpsRect],
    };
    normalizeParsedPptx({ wps: true, slides: [{ nodes: [wpsGroup] }] });
    expect(wpsRect.offset).toEqual({ x: 0, y: 50 });
    expect(wpsRect.extend).toEqual({ w: 120, h: 40 });
  });

  it('resolves OOXML theme font tokens and computes lineHeight for spcPts paragraphs', () => {
    const textNode: PptxNodeLike = {
      order: 1,
      shape: 'rect',
      source: {
        'p:txBody': {
          'a:p': [
            {
              'a:pPr': {
                'a:lnSpc': { 'a:spcPts': { attrs: { val: '5700' } } },
              },
              'a:r': {
                attrs: { order: '1' },
                'a:rPr': { 'a:latin': { attrs: { typeface: '+mj-lt' } } },
              },
            },
            {
              'a:pPr': {
                'a:lnSpc': { 'a:spcPct': { attrs: { val: '130000' } } },
              },
              'a:r': { attrs: { order: '2' } },
            },
          ],
        },
      },
      textBody: {
        props: { wrap: 'none' },
        paragraphs: [
          {
            props: {},
            inheritRProps: { size: 48, typeface: '+mn-ea' },
            rows: [{ props: { size: 48, typeface: '+mj-ea' }, text: '推荐订阅' }],
          },
          {
            props: { lineHeight: 1.3 },
            inheritRProps: { size: 16 },
            rows: [{ props: { size: 16, typeface: '+mn-lt' }, text: '说明' }],
          },
        ],
      },
    };

    const pptx: PptxLike = {
      themes: [
        {
          source: {
            'a:theme': {
              'a:themeElements': {
                'a:fontScheme': {
                  'a:majorFont': {
                    'a:ea': { attrs: { typeface: 'Microsoft YaHei' } },
                    'a:latin': { attrs: { typeface: 'Microsoft YaHei' } },
                  },
                  'a:minorFont': {
                    'a:ea': { attrs: { typeface: 'Microsoft YaHei' } },
                    'a:latin': { attrs: { typeface: 'Segoe UI' } },
                  },
                },
              },
            },
          },
        },
      ],
      slides: [{ nodes: [textNode] }],
    };

    const fonts = extractThemeFonts(pptx);
    expect(fonts.majorEa).toBe('Microsoft YaHei');
    expect(fonts.minorLt).toBe('Segoe UI');
    expect(resolveThemeTypeface('+mn-ea', {})).toBeUndefined();

    normalizeParsedPptx(pptx);

    const p0 = textNode.textBody?.paragraphs?.[0];
    const p1 = textNode.textBody?.paragraphs?.[1];
    expect(p0?.inheritRProps?.typeface).toBe('Microsoft YaHei');
    expect(p0?.rows?.[0]?.props?.typeface).toBe('Microsoft YaHei');
    expect(p0?.props?.lineHeight).toBe(1.1875);
    expect(p1?.rows?.[0]?.props?.typeface).toBe('Segoe UI');
    expect(p1?.props?.lineHeight).toBe(1.3);
  });

  it('applies post-render DOM fixes for wrap="none" and spc inside groups while preserving wrapped boxes', () => {
    interface FakeDomEl {
      tagName: string;
      className: string;
      classList: { contains: (name: string) => boolean };
      style: Record<string, string>;
      children: FakeDomEl[];
      readonly firstElementChild: FakeDomEl | null;
      append: (child: FakeDomEl) => void;
      querySelectorAll: (selector: string) => FakeDomEl[];
      querySelector: (selector: string) => FakeDomEl | null;
    }

    const createEl = (tag: string, className = ''): FakeDomEl => {
      const children: FakeDomEl[] = [];
      const el: FakeDomEl = {
        tagName: tag.toUpperCase(),
        className,
        classList: {
          contains: (name: string) => className.split(/\s+/).includes(name),
        },
        style: {},
        children,
        get firstElementChild() {
          return children[0] ?? null;
        },
        append(child: FakeDomEl) {
          children.push(child);
        },
        querySelectorAll(selector: string): FakeDomEl[] {
          const matched: FakeDomEl[] = [];
          const targetTag = selector.toUpperCase();
          const visit = (cur: FakeDomEl) => {
            for (const ch of cur.children) {
              if (ch.tagName === targetTag) matched.push(ch);
              visit(ch);
            }
          };
          visit(el);
          return matched;
        },
        querySelector(selector: string): FakeDomEl | null {
          const wantedClass = selector.startsWith('.') ? selector.slice(1) : null;
          if (!wantedClass) return null;
          for (const ch of children) {
            if (ch.classList.contains(wantedClass)) return ch;
          }
          return null;
        },
      };
      return el;
    };

    const slideRoot = createEl('div', 'pptx-preview-slide-wrapper');
    const slideLayer = createEl('div', 'slide-wrapper');
    slideRoot.append(slideLayer);

    const groupEl = createEl('div', 'group');
    slideLayer.append(groupEl);

    // 1. wrap="none" + centered + spc="150"
    const noWrapShapeEl = createEl('div', 'shape-wrapper');
    const tw1 = createEl('div', 'text-wrapper');
    const pWrap1 = createEl('div');
    const lineDiv1 = createEl('div');
    const span1 = createEl('span');
    span1.style.wordBreak = 'break-word';
    lineDiv1.append(span1);
    pWrap1.append(lineDiv1);
    tw1.append(pWrap1);
    noWrapShapeEl.append(tw1);
    groupEl.append(noWrapShapeEl);

    // 2. wrap="square" normal box
    const wrapShapeEl = createEl('div', 'shape-wrapper');
    const tw2 = createEl('div', 'text-wrapper');
    const pWrap2 = createEl('div');
    const lineDiv2 = createEl('div');
    const span2 = createEl('span');
    span2.style.wordBreak = 'break-word';
    lineDiv2.append(span2);
    pWrap2.append(lineDiv2);
    tw2.append(pWrap2);
    wrapShapeEl.append(tw2);
    slideLayer.append(wrapShapeEl);

    const slideModel: PptxSlideLike = {
      nodes: [
        {
          order: 1,
          chOffset: { x: 0, y: 0 },
          chExtend: { w: 100, h: 100 },
          nodes: [
            {
              order: 2,
              shape: 'rect',
              source: {
                'p:txBody': {
                  'a:p': {
                    'a:r': { attrs: { order: '1' }, 'a:rPr': { attrs: { spc: '150' } } },
                  },
                },
              },
              textBody: {
                props: { wrap: 'none' },
                paragraphs: [{ props: { align: 'ctr' }, rows: [{ text: 'Title' }] }],
              },
            },
          ],
        },
        {
          order: 3,
          shape: 'rect',
          textBody: {
            props: { wrap: 'square' },
            paragraphs: [{ props: { align: 'l' }, rows: [{ text: 'Paragraph' }] }],
          },
        },
      ],
    };

    // Pass minimal DOM facade matching HTMLElement structural properties read by applySlideDomFixes.
    applySlideDomFixes(slideModel, slideRoot as unknown as HTMLElement);

    expect(tw1.style.whiteSpace).toBe('nowrap');
    expect(tw1.style.overflow).toBe('visible');
    expect(pWrap1.style.display).toBe('flex');
    expect(pWrap1.style.alignItems).toBe('center');
    expect(span1.style.wordBreak).toBe('normal');
    expect(span1.style.whiteSpace).toBe('nowrap');
    expect(span1.style.letterSpacing).toBe('1.5px');

    expect(tw2.style.whiteSpace).toBeUndefined();
    expect(span2.style.wordBreak).toBe('break-word');
  });
});
