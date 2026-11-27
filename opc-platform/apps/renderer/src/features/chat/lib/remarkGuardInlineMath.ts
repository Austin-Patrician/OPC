interface MdastPositionOffset {
  offset?: number;
}

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  position?: {
    start?: MdastPositionOffset;
    end?: MdastPositionOffset;
  };
}

interface RemarkFileLike {
  value?: string | Uint8Array;
}

const SKIP_PARENTS = new Set(['code', 'inlineCode', 'html', 'math', 'inlineMath']);

const CJK_OR_FULLWIDTH_RE = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;
const BARE_CURRENCY_RANGE_RE = /^\d+(?:[.,]\d+)?\s*[-–—~→/]$/;
const TEXT_MACRO_RE =
  /\\(?:text|mathrm|mathbf|mathit|mathsf|mathtt|operatorname)\s*\{[^{}]*\}/g;

function stripStyledTextMacros(value: string): string {
  let current = value;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = current.replace(TEXT_MACRO_RE, '');
    if (next === current) break;
    current = next;
  }
  return current;
}

/**
 * Determines whether a single-dollar `inlineMath` span is a false positive
 * coming from natural currency/CJK prose (e.g. `$19.99/月、年付 $199.99`).
 */
export function shouldRevertSingleDollarMath(inner: string): boolean {
  if (!inner) return true;
  // Pandoc-style boundary check: inline math must not open or close with whitespace.
  if (/^\s|\s$/.test(inner)) return true;
  // Unescaped `%` triggers KaTeX commentAtEnd when closing `$` sits on the same line.
  if (/(?<!\\)%/.test(inner)) return true;
  // Bare currency connectors like `$10-$20`.
  if (BARE_CURRENCY_RANGE_RE.test(inner)) return true;
  // CJK text or fullwidth punctuation outside explicit text macros triggers unicodeTextInMathMode.
  const withoutTextMacros = stripStyledTextMacros(inner);
  if (CJK_OR_FULLWIDTH_RE.test(withoutTextMacros)) return true;
  return false;
}

function sliceRawSource(node: MdastNode, rawDoc: string | null): string | null {
  if (!rawDoc) return null;
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (typeof start !== 'number' || typeof end !== 'number' || start < 0 || end > rawDoc.length || end <= start) {
    return null;
  }
  return rawDoc.slice(start, end);
}

function walkTree(node: MdastNode, rawDoc: string | null): void {
  if (!node.children || SKIP_PARENTS.has(node.type)) return;

  for (let i = 0; i < node.children.length; i += 1) {
    const child = node.children[i];
    if (!child) continue;

    if (child.type === 'inlineMath') {
      const inner = child.value ?? '';
      const rawSlice = sliceRawSource(child, rawDoc);
      const isDoubleDollar = Boolean(rawSlice && rawSlice.startsWith('$$') && rawSlice.endsWith('$$'));
      if (!isDoubleDollar && shouldRevertSingleDollarMath(inner)) {
        node.children[i] = {
          type: 'text',
          value: rawSlice ?? `$${inner}$`,
          ...(child.position ? { position: child.position } : {}),
        };
      }
      continue;
    }

    walkTree(child, rawDoc);
  }
}

/**
 * Reverts false-positive single-dollar `$...$` inline math spans created from
 * ordinary currency prose back into plain text before `rehype-katex` runs.
 */
export function remarkGuardInlineMath() {
  return (tree: MdastNode, file?: RemarkFileLike) => {
    const rawDoc = typeof file?.value === 'string' ? file.value : null;
    walkTree(tree, rawDoc);
  };
}
