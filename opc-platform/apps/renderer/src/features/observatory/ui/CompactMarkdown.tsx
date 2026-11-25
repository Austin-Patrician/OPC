import { memo, type ComponentProps } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type MarkdownComponents = ComponentProps<typeof ReactMarkdown>['components'];

const COMPACT_COMPONENTS: MarkdownComponents = {
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-accent-ink underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
    >
      {children}
    </a>
  ),
};

/**
 * Compact 11.5-12px Markdown renderer tuned specifically for drawer prose
 * (questions, contract objectives/deliverables, worker final response, reply_to_user previews).
 */
export const CompactMarkdown = memo(function CompactMarkdown({
  text,
  className = '',
}: {
  text: string;
  className?: string;
}) {
  return (
    <div className={`observatory-md break-words ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPACT_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
