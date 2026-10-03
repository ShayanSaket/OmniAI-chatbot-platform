import { Fragment, useMemo } from 'react';
import { parseMarkdown, type Inline } from '@/lib/markdown';

function InlineNodes({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.type) {
          case 'text':
            return <Fragment key={i}>{n.text}</Fragment>;
          case 'strong':
            return (
              <strong key={i} className="font-semibold">
                <InlineNodes nodes={n.children} />
              </strong>
            );
          case 'em':
            return (
              <em key={i}>
                <InlineNodes nodes={n.children} />
              </em>
            );
          case 'code':
            return (
              <code key={i} className="rounded bg-black/[0.06] px-1 py-px font-mono text-[0.85em]">
                {n.text}
              </code>
            );
          case 'link':
            return (
              <a
                key={i}
                href={n.href}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="font-medium underline decoration-current/40 underline-offset-2 hover:decoration-current"
              >
                <InlineNodes nodes={n.children} />
              </a>
            );
        }
      })}
    </>
  );
}

/** Renders chat Markdown as React elements (no HTML injection possible). */
export function Markdown({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <div dir="auto" className="space-y-2 break-words [overflow-wrap:anywhere]">
      {blocks.map((b, i) => {
        if (b.type === 'paragraph') {
          return (
            <p key={i} className="whitespace-pre-line">
              <InlineNodes nodes={b.children} />
            </p>
          );
        }
        if (b.type === 'codeblock') {
          return (
            <pre key={i} className="overflow-x-auto rounded-md bg-black/[0.06] p-2 font-mono text-[12px]">
              {b.text}
            </pre>
          );
        }
        const List = b.ordered ? 'ol' : 'ul';
        return (
          <List key={i} className={`space-y-1 ps-5 ${b.ordered ? 'list-decimal' : 'list-disc'}`}>
            {b.items.map((item, j) => (
              <li key={j}>
                <InlineNodes nodes={item} />
              </li>
            ))}
          </List>
        );
      })}
    </div>
  );
}
