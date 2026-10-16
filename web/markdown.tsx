import React, { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Agent output is untrusted: render Markdown without HTML or automatic remote images. */
export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  return <div className="message-text markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ node, href, children, ...props }) => href
      ? <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>
      : <span>{children}</span>,
    img: ({ src, alt }) => <span className="markdown-image">{typeof src === 'string' && src
      ? <a href={src} target="_blank" rel="noopener noreferrer">{alt || '图片'}</a>
      : alt || '图片'}</span>,
    table: ({ node, ...props }) => <div className="markdown-table"><table {...props} /></div>,
  }}>{text}</ReactMarkdown></div>;
});
