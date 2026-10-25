import { useMemo } from 'react';
import { parseRichText } from '../lib/parseRichText';

interface RichTextProps {
  text: string;
}

/** Renders text with mention pills and safe links. No HTML injection. */
export function RichText({ text }: RichTextProps) {
  const segments = useMemo(() => parseRichText(text), [text]);

  return (
    <>
      {segments.map((segment, index) => {
        if (segment.type === 'link') {
          return (
            <a
              key={index}
              href={segment.href}
              target="_blank"
              rel="noreferrer noopener"
              className="break-all text-accent-ink underline underline-offset-2 hover:text-accent"
            >
              {segment.value}
            </a>
          );
        }

        if (segment.type === 'mention') {
          return (
            <span key={index} className="font-medium text-accent-ink">
              {segment.value}
            </span>
          );
        }

        return <span key={index}>{segment.value}</span>;
      })}
    </>
  );
}
