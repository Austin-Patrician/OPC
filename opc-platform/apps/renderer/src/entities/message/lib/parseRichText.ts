export interface RichSegment {
  type: 'text' | 'mention' | 'link';
  value: string;
  href?: string;
}

const TOKEN_PATTERN = /(https?:\/\/[^\s]+)|(@[^\s@]+)/g;

/** Trailing punctuation that belongs to the sentence, not to a mention. */
const TRAILING_PUNCTUATION = /[.,;:!?，。；：！？、）)】」』]+$/;

/**
 * Pure tokenizer for message bodies: splits plain text into text / mention /
 * link segments so the renderer never needs `dangerouslySetInnerHTML`.
 * Link detection is protocol-whitelisted (`http`/`https` only).
 */
export function parseRichText(input: string): RichSegment[] {
  if (!input) return [];

  const segments: RichSegment[] = [];
  let lastIndex = 0;

  for (const match of input.matchAll(TOKEN_PATTERN)) {
    const [raw, url, mention] = match;
    const index = match.index ?? 0;

    if (index > lastIndex) {
      segments.push({ type: 'text', value: input.slice(lastIndex, index) });
    }

    if (url) {
      segments.push({ type: 'link', value: url, href: url });
    } else if (mention) {
      const trailing = mention.match(TRAILING_PUNCTUATION)?.[0] ?? '';
      const value = trailing ? mention.slice(0, -trailing.length) : mention;
      segments.push({ type: 'mention', value });
      if (trailing) segments.push({ type: 'text', value: trailing });
    }

    lastIndex = index + raw.length;
  }

  if (lastIndex < input.length) {
    segments.push({ type: 'text', value: input.slice(lastIndex) });
  }

  return segments;
}
