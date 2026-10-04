'use client';

import { Fragment, useLayoutEffect, useMemo, useRef } from 'react';
import { AlertCircle, Bot, Check, CheckCheck, Clock, FileText, Loader2, RotateCw } from 'lucide-react';
import { Markdown } from '@/components/widget/markdown';
import type { InboxMessage } from '@/lib/inbox';
import { cn } from '@/lib/utils';
import { clockTime, dayLabel, formatBytes, useNow } from './shared';

interface Props {
  messages: InboxMessage[];
  customerName: string;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onRetry: (message: InboxMessage) => void;
  retrying: string | null;
}

function DeliveryStatus({ m }: { m: InboxMessage }) {
  if (m.status === 'PENDING') return <Clock className="h-3 w-3" aria-label="Sending" />;
  if (m.status === 'FAILED') return <AlertCircle className="h-3 w-3 text-destructive" aria-label="Failed" />;
  if (m.status === 'READ') return <CheckCheck className="h-3 w-3 text-sky-500" aria-label="Read" />;
  if (m.status === 'DELIVERED') return <CheckCheck className="h-3 w-3" aria-label="Delivered" />;
  return <Check className="h-3 w-3" aria-label="Sent" />;
}

function Attachments({ m, onDark }: { m: InboxMessage; onDark: boolean }) {
  if (!m.attachments.length) return null;
  return (
    <div className="mt-1.5 space-y-1.5">
      {m.attachments.map((a, i) =>
        a.mimeType.startsWith('image/') ? (
          <a key={i} href={a.url} target="_blank" rel="noopener noreferrer" className="block">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={a.url} alt={a.fileName} className="max-h-56 max-w-full rounded-md object-contain" loading="lazy" />
          </a>
        ) : a.mimeType.startsWith('audio/') ? (
          <audio key={i} controls src={a.url} className="w-56 max-w-full" preload="none" />
        ) : (
          <a
            key={i}
            href={a.url}
            target="_blank"
            rel="noopener noreferrer"
            className={cn('flex items-center gap-2 rounded-md px-2 py-1.5 text-xs', onDark ? 'bg-white/15 hover:bg-white/25' : 'bg-background/70 ring-1 ring-border hover:bg-background')}
          >
            <FileText className="h-4 w-4 shrink-0" />
            <span className="min-w-0 truncate">{a.fileName}</span>
            <span className="shrink-0 opacity-70">{formatBytes(a.size)}</span>
          </a>
        ),
      )}
    </div>
  );
}

export function MessageThread({ messages, customerName, hasOlder, loadingOlder, onLoadOlder, onRetry, retrying }: Props) {
  const now = useNow(60_000);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const firstId = messages[0]?.id;
  const prevFirst = useRef(firstId);
  const prevHeight = useRef(0);

  const days = useMemo(() => {
    const groups: { key: string; first: string; items: InboxMessage[] }[] = [];
    for (const m of messages) {
      const key = new Date(m.createdAt).toDateString();
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.items.push(m);
      else groups.push({ key, first: m.createdAt, items: [m] });
    }
    return groups;
  }, [messages]);

  // Keep the view pinned to the bottom for new messages; keep position when older ones load.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (prevFirst.current !== firstId && prevHeight.current && !stick.current) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevFirst.current = firstId;
    prevHeight.current = el.scrollHeight;
  }, [messages, firstId]);

  return (
    <div
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        prevHeight.current = el.scrollHeight;
      }}
      className="min-h-0 flex-1 overflow-y-auto bg-muted/30 px-3 py-4 scrollbar-thin sm:px-6"
      role="log"
      aria-label="Messages"
      aria-live="polite"
    >
      {hasOlder && (
        <div className="mb-4 flex justify-center">
          <button type="button" onClick={onLoadOlder} disabled={loadingOlder} className="inline-flex items-center gap-1.5 rounded-full border bg-background px-3 py-1 text-xs text-muted-foreground hover:text-foreground">
            {loadingOlder && <Loader2 className="h-3 w-3 animate-spin" />}
            Load earlier messages
          </button>
        </div>
      )}
      {messages.length === 0 && <p className="py-10 text-center text-sm text-muted-foreground">No messages yet.</p>}
      {days.map((day) => (
        <Fragment key={day.key}>
          <div className="my-4 flex items-center gap-3 text-[11px] font-medium text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            <span suppressHydrationWarning>{dayLabel(day.first, now)}</span>
            <span className="h-px flex-1 bg-border" />
          </div>
          {day.items.map((m) => {
            if (m.senderType === 'SYSTEM') {
              return (
                <div key={m.id} className="my-3 flex justify-center">
                  <p className="max-w-[85%] rounded-full bg-muted px-3 py-1 text-center text-[12px] text-muted-foreground" dir="auto">
                    {m.content}
                    <span className="ms-2 opacity-70" suppressHydrationWarning>
                      {clockTime(m.createdAt)}
                    </span>
                  </p>
                </div>
              );
            }
            const customer = m.senderType === 'CUSTOMER';
            const ai = m.senderType === 'AI';
            const author = customer ? customerName : ai ? (m.label ?? 'AI assistant') : (m.authorName ?? 'Team member');
            return (
              <div key={m.id} className={cn('mb-3 flex flex-col', customer ? 'items-start' : 'items-end')}>
                <div className={cn('mb-1 flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground', !customer && 'flex-row-reverse')}>
                  {ai && <Bot className="h-3 w-3" />}
                  <span className="font-medium">{author}</span>
                  {!ai && m.label && <span>· {m.label}</span>}
                  <span suppressHydrationWarning>{clockTime(m.createdAt)}</span>
                </div>
                <div
                  className={cn(
                    'max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed shadow-sm sm:max-w-[75%]',
                    customer && 'rounded-ss-md bg-background ring-1 ring-border',
                    ai && 'rounded-se-md bg-violet-500/10 ring-1 ring-violet-500/20',
                    m.senderType === 'AGENT' && 'rounded-se-md bg-primary text-primary-foreground',
                    m.status === 'FAILED' && 'ring-2 ring-destructive/60',
                  )}
                >
                  {m.content &&
                    (ai ? (
                      <Markdown source={m.content} />
                    ) : (
                      <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]" dir="auto">
                        {m.content}
                      </p>
                    ))}
                  <Attachments m={m} onDark={m.senderType === 'AGENT'} />
                  {m.sources.length > 0 && <p className="mt-1.5 text-[11px] text-muted-foreground">Sources: {m.sources.map((s) => s.title).join(' · ')}</p>}
                </div>
                {!customer && (
                  <div className="mt-1 flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
                    <DeliveryStatus m={m} />
                    {m.status === 'FAILED' && (
                      <>
                        <span className="text-destructive">{m.error ?? 'Not delivered'}</span>
                        {!m.id.startsWith('tmp-') && (
                          <button type="button" onClick={() => onRetry(m)} disabled={retrying === m.id} className="inline-flex items-center gap-1 font-medium text-foreground hover:underline">
                            {retrying === m.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCw className="h-3 w-3" />}
                            Retry
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}
