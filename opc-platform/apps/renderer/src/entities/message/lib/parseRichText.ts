import {
  tokenizeProseEntities,
  type FilePathEntityMeta,
} from '@/shared/lib/chatEntities';

export interface RichSegment {
  type: 'text' | 'mention' | 'link' | 'email' | 'file';
  value: string;
  href?: string;
  email?: string;
  file?: FilePathEntityMeta;
}

/**
 * Pure tokenizer for message bodies: splits plain text into text / mention /
 * link / email / file segments so the renderer never needs `dangerouslySetInnerHTML`.
 */
export function parseRichText(input: string): RichSegment[] {
  if (!input) return [];

  return tokenizeProseEntities(input, { enableMentions: true }).map((segment) => {
    switch (segment.type) {
      case 'link':
        return { type: 'link', value: segment.value, href: segment.href };
      case 'email':
        return {
          type: 'email',
          value: segment.value,
          email: segment.email,
          href: segment.href,
        };
      case 'file':
        return { type: 'file', value: segment.value, file: segment.file };
      case 'mention':
        return { type: 'mention', value: segment.value };
      case 'text':
        return { type: 'text', value: segment.value };
    }
  });
}
