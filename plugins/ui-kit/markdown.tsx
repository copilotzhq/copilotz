import type React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
/** Raw HTML is discarded; code remains text. No raw-HTML or arbitrary plugins. */
export function Markdown(
  { children }: { children: string },
): React.ReactElement | null {
  return (
    <div className="prose prose-sm max-w-none break-words dark:prose-invert">
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => (
            <a href={href} rel="noopener noreferrer">{children}</a>
          ),
          code: ({ children, className }) => (
            <code className={className}>{children}</code>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
