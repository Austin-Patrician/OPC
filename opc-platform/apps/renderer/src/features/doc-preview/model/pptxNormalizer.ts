export interface ThemeFonts {
  majorEa?: string;
  majorLt?: string;
  majorCs?: string;
  minorEa?: string;
  minorLt?: string;
  minorCs?: string;
}

export interface PptxBoxOffset {
  x: number;
  y: number;
}

export interface PptxBoxExtend {
  w: number;
  h: number;
}

export interface XmlNodeLike {
  attrs?: Record<string, string | undefined>;
  [key: string]: unknown;
}

export interface PptxRunLike {
  isBr?: boolean;
  text?: string;
  props?: {
    size?: number;
    typeface?: string;
    [key: string]: unknown;
  };
}

export interface PptxParagraphLike {
  props?: {
    align?: string;
    lineHeight?: number;
    buAutoNum?: string;
    buChar?: string;
    [key: string]: unknown;
  };
  inheritProps?: {
    align?: string;
    buAutoNum?: string;
    buChar?: string;
    [key: string]: unknown;
  };
  inheritRProps?: {
    size?: number;
    typeface?: string;
    [key: string]: unknown;
  };
  rows?: PptxRunLike[];
}

export interface PptxTextBodyLike {
  props?: {
    wrap?: string;
    [key: string]: unknown;
  };
  paragraphs?: PptxParagraphLike[];
}

export interface PptxNodeLike {
  order?: number;
  userDrawn?: boolean;
  shape?: string;
  offset?: PptxBoxOffset;
  extend?: PptxBoxExtend;
  chOffset?: PptxBoxOffset;
  chExtend?: PptxBoxExtend;
  nodes?: PptxNodeLike[];
  textBody?: PptxTextBodyLike;
  source?: XmlNodeLike;
  tr?: Array<{
    tc?: Array<{
      textBody?: PptxTextBodyLike;
    }>;
  }>;
}

export interface PptxSlideContainerLike {
  nodes?: PptxNodeLike[];
}

export interface PptxSlideLike extends PptxSlideContainerLike {
  slideLayout?: PptxSlideContainerLike;
  slideMaster?: PptxSlideContainerLike;
}

export interface PptxThemeLike {
  source?: XmlNodeLike;
}

export interface PptxLike {
  wps?: boolean;
  themes?: PptxThemeLike[];
  slides?: PptxSlideLike[];
  slideLayouts?: PptxSlideContainerLike[];
  slideMaster?: PptxSlideContainerLike[];
}

const EMU_PER_POINT = 12700;
const EMU_THRESHOLD = 20000;

function asXml(value: unknown): XmlNodeLike | undefined {
  return value && typeof value === 'object' ? (value as XmlNodeLike) : undefined;
}

function toXmlArray(value: unknown): XmlNodeLike[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is XmlNodeLike => Boolean(item && typeof item === 'object'));
  }
  const single = asXml(value);
  return single ? [single] : [];
}

function readNumAttr(node: XmlNodeLike | undefined, attr: string): number | null {
  const raw = node?.attrs?.[attr];
  if (raw === undefined || raw === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function isGroupNode(node: PptxNodeLike): boolean {
  return (
    Array.isArray(node.nodes) &&
    (node.chOffset !== undefined || node.chExtend !== undefined || node.source?.['p:grpSpPr'] !== undefined)
  );
}

/** Extracts major/minor EA, Latin, and CS typefaces from parsed presentation themes. */
export function extractThemeFonts(pptx: PptxLike): ThemeFonts {
  const theme0 = pptx.themes?.[0];
  const themeEl = asXml(asXml(theme0?.source?.['a:theme'])?.['a:themeElements']);
  const fontScheme = asXml(themeEl?.['a:fontScheme']);
  const majorFont = asXml(fontScheme?.['a:majorFont']);
  const minorFont = asXml(fontScheme?.['a:minorFont']);

  const pickTypeface = (bucket: XmlNodeLike | undefined, tag: string): string | undefined => {
    const tf = asXml(bucket?.[tag])?.attrs?.typeface?.trim();
    return tf || undefined;
  };

  const majorLt = pickTypeface(majorFont, 'a:latin');
  const minorLt = pickTypeface(minorFont, 'a:latin');
  const majorEa = pickTypeface(majorFont, 'a:ea') ?? majorLt;
  const minorEa = pickTypeface(minorFont, 'a:ea') ?? minorLt;
  const majorCs = pickTypeface(majorFont, 'a:cs') ?? majorLt;
  const minorCs = pickTypeface(minorFont, 'a:cs') ?? minorLt;

  return {
    ...(majorEa ? { majorEa } : {}),
    ...(majorLt ? { majorLt } : {}),
    ...(majorCs ? { majorCs } : {}),
    ...(minorEa ? { minorEa } : {}),
    ...(minorLt ? { minorLt } : {}),
    ...(minorCs ? { minorCs } : {}),
  };
}

/** Resolves OOXML theme font placeholders such as `+mn-ea` or `+mj-lt`. */
export function resolveThemeTypeface(
  typeface: string | undefined,
  fonts: ThemeFonts,
): string | undefined {
  if (!typeface) return undefined;
  const trimmed = typeface.trim();
  if (!trimmed) return undefined;
  switch (trimmed) {
    case '+mj-ea':
      return fonts.majorEa ?? fonts.majorLt;
    case '+mn-ea':
      return fonts.minorEa ?? fonts.minorLt;
    case '+mj-lt':
      return fonts.majorLt ?? fonts.majorEa;
    case '+mn-lt':
      return fonts.minorLt ?? fonts.minorEa;
    case '+mj-cs':
      return fonts.majorCs ?? fonts.majorLt;
    case '+mn-cs':
      return fonts.minorCs ?? fonts.minorLt;
    default:
      return trimmed.startsWith('+') ? undefined : trimmed;
  }
}

interface RawXfrmValues {
  x: number;
  y: number;
  cx: number;
  cy: number;
  chX?: number;
  chY?: number;
  chCx?: number;
  chCy?: number;
}

function readRawXfrm(node: PptxNodeLike, isGroup: boolean): RawXfrmValues | null {
  const xfrm = isGroup
    ? asXml(asXml(node.source?.['p:grpSpPr'])?.['a:xfrm'])
    : asXml(asXml(node.source?.['p:spPr'])?.['a:xfrm']) ?? asXml(node.source?.['a:xfrm']) ?? asXml(node.source?.['p:xfrm']);
  if (!xfrm) return null;

  const off = asXml(xfrm['a:off']);
  const ext = asXml(xfrm['a:ext']);
  const x = readNumAttr(off, 'x');
  const y = readNumAttr(off, 'y');
  const cx = readNumAttr(ext, 'cx');
  const cy = readNumAttr(ext, 'cy');
  if (x === null || y === null || cx === null) return null;

  const chOff = asXml(xfrm['a:chOff']);
  const chExt = asXml(xfrm['a:chExt']);
  const chX = readNumAttr(chOff, 'x');
  const chY = readNumAttr(chOff, 'y');
  const chCx = readNumAttr(chExt, 'cx');
  const chCy = readNumAttr(chExt, 'cy');

  return {
    x,
    y,
    cx,
    cy: cy ?? 0,
    ...(chX !== null ? { chX } : {}),
    ...(chY !== null ? { chY } : {}),
    ...(chCx !== null ? { chCx } : {}),
    ...(chCy !== null ? { chCy } : {}),
  };
}

function hasAnyLargeEmu(raw: RawXfrmValues): boolean {
  return (
    Math.abs(raw.x) > EMU_THRESHOLD ||
    Math.abs(raw.y) > EMU_THRESHOLD ||
    Math.abs(raw.cx) > EMU_THRESHOLD ||
    Math.abs(raw.cy) > EMU_THRESHOLD ||
    (raw.chX !== undefined && Math.abs(raw.chX) > EMU_THRESHOLD) ||
    (raw.chY !== undefined && Math.abs(raw.chY) > EMU_THRESHOLD) ||
    (raw.chCx !== undefined && Math.abs(raw.chCx) > EMU_THRESHOLD) ||
    (raw.chCy !== undefined && Math.abs(raw.chCy) > EMU_THRESHOLD)
  );
}

/**
 * Repairs `pptx-preview`'s 635x point/EMU misclassification when a non-WPS group
 * or grouped child has `|x| <= 20000` EMU (such as `x="0"`).
 */
function repairEmuNodeGeometry(
  node: PptxNodeLike,
  isGroup: boolean,
  parentGroup: PptxNodeLike | undefined,
  parentHasEmu: boolean,
): boolean {
  const raw = readRawXfrm(node, isGroup);
  if (!raw) return parentHasEmu;

  const nodeHasEmu = parentHasEmu || hasAnyLargeEmu(raw);
  if (!nodeHasEmu) return false;

  const unitFactor = EMU_PER_POINT;
  let nextX = Math.round(raw.x / unitFactor);
  let nextY = Math.round(raw.y / unitFactor);
  let nextW = Math.round(raw.cx / unitFactor);
  let nextH = Math.round(raw.cy / unitFactor);

  if (isGroup && raw.chX !== undefined && raw.chY !== undefined && raw.chCx !== undefined && raw.chCy !== undefined) {
    node.chOffset = {
      x: Math.round(raw.chX / unitFactor),
      y: Math.round(raw.chY / unitFactor),
    };
    node.chExtend = {
      w: Math.round(raw.chCx / unitFactor),
      h: Math.round(raw.chCy / unitFactor),
    };
  }

  if (parentGroup?.extend && parentGroup.chExtend && parentGroup.chOffset) {
    const scaleX = parentGroup.chExtend.w === 0 ? 0 : parentGroup.extend.w / parentGroup.chExtend.w;
    const scaleY = parentGroup.chExtend.h === 0 ? 0 : parentGroup.extend.h / parentGroup.chExtend.h;
    nextW = nextW * scaleX;
    nextH = nextH * scaleY;
    nextX = (nextX - parentGroup.chOffset.x) * scaleX;
    nextY = (nextY - parentGroup.chOffset.y) * scaleY;
  }

  node.offset = { x: nextX, y: nextY };
  node.extend = { w: nextW, h: nextH };
  return true;
}

function extractOrderedRawRuns(rawParagraph: XmlNodeLike | undefined): XmlNodeLike[] {
  if (!rawParagraph) return [];
  const runs = [...toXmlArray(rawParagraph['a:r']), ...toXmlArray(rawParagraph['a:fld'])];
  runs.sort((a, b) => (readNumAttr(a, 'order') ?? 0) - (readNumAttr(b, 'order') ?? 0));
  return runs;
}

function normalizeTextBody(
  textBody: PptxTextBodyLike | undefined,
  rawTxBody: XmlNodeLike | undefined,
  fonts: ThemeFonts,
): void {
  const paragraphs = textBody?.paragraphs;
  if (!paragraphs || paragraphs.length === 0) return;

  const rawParagraphs = toXmlArray(rawTxBody?.['a:p']);

  for (let pIdx = 0; pIdx < paragraphs.length; pIdx += 1) {
    const para = paragraphs[pIdx];
    if (!para) continue;
    const rawPara = rawParagraphs[pIdx];

    if (para.inheritRProps?.typeface) {
      const resolved = resolveThemeTypeface(para.inheritRProps.typeface, fonts);
      if (resolved) para.inheritRProps.typeface = resolved;
      else delete para.inheritRProps.typeface;
    } else if (para.inheritRProps) {
      const fallbackLatin = asXml(asXml(rawPara?.['a:pPr'])?.['a:defRPr'])?.['a:latin'];
      const latinTf = resolveThemeTypeface(asXml(fallbackLatin)?.attrs?.typeface, fonts);
      if (latinTf) para.inheritRProps.typeface = latinTf;
    }

    const rawRuns = extractOrderedRawRuns(rawPara);
    let rawRunCursor = 0;
    let maxRunSize = 0;

    for (const run of para.rows ?? []) {
      if (run.isBr) continue;
      const rawRun = rawRuns[rawRunCursor++];
      const rawRPr = asXml(rawRun?.['a:rPr']);

      if (run.props?.size && run.props.size > maxRunSize) {
        maxRunSize = run.props.size;
      }

      if (run.props?.typeface) {
        const resolved = resolveThemeTypeface(run.props.typeface, fonts);
        if (resolved) run.props.typeface = resolved;
        else delete run.props.typeface;
      } else if (run.props) {
        const latinTf = resolveThemeTypeface(asXml(rawRPr?.['a:latin'])?.attrs?.typeface, fonts);
        if (latinTf) run.props.typeface = latinTf;
      }
    }

    // Apply fixed point line spacing (<a:lnSpc><a:spcPts val="..."/>) when spcPct is absent.
    const spcPts = readNumAttr(asXml(asXml(asXml(rawPara?.['a:pPr'])?.['a:lnSpc'])?.['a:spcPts']), 'val');
    if (spcPts !== null && spcPts > 0 && para.props?.lineHeight === undefined) {
      const baseSize = maxRunSize || para.inheritRProps?.size || 18;
      para.props = {
        ...para.props,
        lineHeight: Number((spcPts / 100 / baseSize).toFixed(4)),
      };
    }
  }
}

function normalizeNodeList(
  nodes: PptxNodeLike[] | undefined,
  fonts: ThemeFonts,
  isWps: boolean,
  parentGroup: PptxNodeLike | undefined,
  parentHasEmu: boolean,
): void {
  if (!Array.isArray(nodes) || nodes.length === 0) return;

  nodes.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  for (const node of nodes) {
    const group = isGroupNode(node);
    const nodeHasEmu = !isWps
      ? repairEmuNodeGeometry(node, group, parentGroup, parentHasEmu)
      : false;

    if (node.textBody) {
      normalizeTextBody(node.textBody, asXml(node.source?.['p:txBody']), fonts);
    }

    if (Array.isArray(node.tr)) {
      const rawRows = toXmlArray(asXml(asXml(asXml(node.source?.['a:graphic'])?.['a:graphicData'])?.['a:tbl'])?.['a:tr']);
      for (let rIdx = 0; rIdx < node.tr.length; rIdx += 1) {
        const row = node.tr[rIdx];
        const rawCells = toXmlArray(rawRows[rIdx]?.['a:tc']);
        for (let cIdx = 0; cIdx < (row?.tc?.length ?? 0); cIdx += 1) {
          const cell = row?.tc?.[cIdx];
          if (cell?.textBody) {
            normalizeTextBody(cell.textBody, asXml(rawCells[cIdx]?.['a:txBody']), fonts);
          }
        }
      }
    }

    if (Array.isArray(node.nodes)) {
      normalizeNodeList(node.nodes, fonts, isWps, group ? node : parentGroup, nodeHasEmu);
    }
  }
}

/**
 * Normalizes a parsed `pptx-preview` model in-place:
 * - Recursively sorts groups and diagrams by XML document `order`
 * - Repairs EMU group geometry when `|x| <= 20000`
 * - Resolves OOXML theme font placeholders (`+mn-ea`, `+mj-ea`, ...)
 * - Applies fixed `<a:spcPts>` paragraph line heights
 */
export function normalizeParsedPptx(pptx: PptxLike | undefined): void {
  if (!pptx) return;
  const fonts = extractThemeFonts(pptx);
  const isWps = Boolean(pptx.wps);

  for (const master of pptx.slideMaster ?? []) {
    normalizeNodeList(master.nodes, fonts, isWps, undefined, false);
  }
  for (const layout of pptx.slideLayouts ?? []) {
    normalizeNodeList(layout.nodes, fonts, isWps, undefined, false);
  }
  for (const slide of pptx.slides ?? []) {
    normalizeNodeList(slide.nodes, fonts, isWps, undefined, false);
  }
}

function isHtmlElement(value: unknown): value is HTMLElement {
  return Boolean(value && typeof value === 'object' && 'style' in value && 'classList' in value);
}

function patchShapeDom(node: PptxNodeLike, shapeEl: HTMLElement): void {
  const textWrapper = Array.from(shapeEl.children).find(
    (el): el is HTMLElement => isHtmlElement(el) && el.classList.contains('text-wrapper'),
  );
  if (!textWrapper) return;

  const noWrap = node.textBody?.props?.wrap === 'none';
  if (noWrap) {
    textWrapper.style.whiteSpace = 'nowrap';
    textWrapper.style.overflow = 'visible';
  }

  const paragraphs = node.textBody?.paragraphs ?? [];
  const rawParagraphs = toXmlArray(asXml(node.source?.['p:txBody'])?.['a:p']);
  const pWrappers = Array.from(textWrapper.children).filter(isHtmlElement);

  for (let pIdx = 0; pIdx < paragraphs.length; pIdx += 1) {
    const para = paragraphs[pIdx];
    const pWrapper = pWrappers[pIdx];
    if (!para || !pWrapper) continue;

    // `TextParagraph` wraps its line block inside one outer div.
    const lineDiv = isHtmlElement(pWrapper.firstElementChild)
      ? pWrapper.firstElementChild
      : pWrapper;

    if (noWrap) {
      const align = para.props?.align ?? para.inheritProps?.align;
      if (align === 'ctr' || align === 'r') {
        pWrapper.style.display = 'flex';
        pWrapper.style.flexDirection = 'column';
        pWrapper.style.alignItems = align === 'ctr' ? 'center' : 'flex-end';
      }
      for (const span of Array.from(lineDiv.querySelectorAll('span'))) {
        if (!isHtmlElement(span)) continue;
        span.style.wordBreak = 'normal';
        span.style.whiteSpace = 'nowrap';
      }
    }

    const rawRuns = extractOrderedRawRuns(rawParagraphs[pIdx]);
    const hasBulletSpan = Boolean(
      para.props?.buAutoNum || para.inheritProps?.buAutoNum || para.props?.buChar || para.inheritProps?.buChar,
    );
    const childElements = Array.from(lineDiv.children);
    let domCursor = hasBulletSpan ? 1 : 0;
    let rawRunCursor = 0;

    for (const run of para.rows ?? []) {
      if (run.isBr) {
        while (domCursor < childElements.length && childElements[domCursor]?.tagName !== 'BR') {
          domCursor += 1;
        }
        domCursor += 1;
        continue;
      }

      const rawRun = rawRuns[rawRunCursor++];
      const spanEl = childElements[domCursor];
      domCursor += 1;
      if (!isHtmlElement(spanEl)) continue;

      const spc = readNumAttr(asXml(rawRun?.['a:rPr']), 'spc');
      if (spc !== null) {
        spanEl.style.letterSpacing = `${spc / 100}px`;
      }
    }
  }
}

function patchLayerDom(
  nodes: readonly PptxNodeLike[] | undefined,
  layerEl: Element | null,
  insideGroup: boolean,
): void {
  if (!nodes || !layerEl) return;
  const domChildren = Array.from(layerEl.children).filter(isHtmlElement);
  let domCursor = 0;

  for (const node of nodes) {
    if (isGroupNode(node)) {
      let matchIdx = -1;
      for (let i = domCursor; i < domChildren.length; i += 1) {
        if (domChildren[i]?.classList.contains('group')) {
          matchIdx = i;
          break;
        }
      }
      if (matchIdx !== -1) {
        patchLayerDom(node.nodes, domChildren[matchIdx] ?? null, true);
        domCursor = matchIdx + 1;
      }
      continue;
    }

    if (node.shape !== undefined) {
      let matchIdx = -1;
      for (let i = domCursor; i < domChildren.length; i += 1) {
        if (domChildren[i]?.classList.contains('shape-wrapper')) {
          matchIdx = i;
          break;
        }
      }
      if (matchIdx !== -1) {
        const el = domChildren[matchIdx];
        if (el) patchShapeDom(node, el);
        domCursor = matchIdx + 1;
      }
      continue;
    }

    // Inside groups (`ft()`), only Pic (`T`), Shape (`B`), and nested Group (`O`) produce DOM elements.
    const rendersInGroup = node.source?.['p:blipFill'] !== undefined;
    if (!insideGroup || rendersInGroup) {
      domCursor += 1;
    }
  }
}

/**
 * Applies post-render DOM fixes onto a single rendered `.pptx-preview-slide-wrapper`:
 * honors `<a:bodyPr wrap="none">` (preserving alignment) and explicit `spc` tracking.
 */
export function applySlideDomFixes(
  slide: PptxSlideLike | undefined,
  slideRootEl: HTMLElement | null | undefined,
): void {
  if (!slide || !slideRootEl) return;

  const masterEl = slideRootEl.querySelector('.slide-master-wrapper');
  if (masterEl && slide.slideMaster?.nodes) {
    patchLayerDom(
      slide.slideMaster.nodes.filter((n) => Boolean(n.userDrawn)),
      masterEl,
      false,
    );
  }

  const layoutEl = slideRootEl.querySelector('.slide-layout-wrapper');
  if (layoutEl && slide.slideLayout?.nodes) {
    patchLayerDom(
      slide.slideLayout.nodes.filter((n) => Boolean(n.userDrawn)),
      layoutEl,
      false,
    );
  }

  const slideEl = slideRootEl.querySelector('.slide-wrapper');
  if (slideEl && slide.nodes) {
    patchLayerDom(slide.nodes, slideEl, false);
  }
}
