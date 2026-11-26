import { useMemo } from 'react';
import {
  ChatEmailChip,
  ChatFilePathChip,
  ChatUrlChip,
} from '@/shared/ui/ChatEntityChips';
import { parseRichText } from '../lib/parseRichText';

interface RichTextProps {
  text: string;
}

/** Renders text with mention pills, email chips, URL chips, and file path actions. */
export function RichText({ text }: RichTextProps) {
  const segments = useMemo(() => parseRichText(text), [text]);

  return (
    <>
      {segments.map((segment, index) => {
        if (segment.type === 'link' && segment.href) {
          return (
            <ChatUrlChip key={index} href={segment.href} rawText={segment.value}>
              {segment.value}
            </ChatUrlChip>
          );
        }

        if (segment.type === 'email' && segment.email) {
          return (
            <ChatEmailChip key={index} email={segment.email} href={segment.href}>
              {segment.value}
            </ChatEmailChip>
          );
        }

        if (segment.type === 'file' && segment.file) {
          return (
            <ChatFilePathChip key={index} file={segment.file}>
              {segment.value}
            </ChatFilePathChip>
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
