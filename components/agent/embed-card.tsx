'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Check, Copy, ExternalLink, FlaskConical } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

export function EmbedCard({ appUrl, botKey, active }: { appUrl: string; botKey: string; active: boolean }) {
  const [copied, setCopied] = useState(false);
  const snippet = `<script src="${appUrl}/chat-widget.js" data-bot-id="${botKey}" async></script>`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      toast.success('Embed code copied');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not copy — select the code and copy it manually.');
    }
  };

  return (
    <section className="rounded-xl border bg-card p-5 shadow-sm shadow-black/[0.02] sm:p-6">
      <h2 className="text-base font-semibold">Install on your website</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">
        Paste this snippet just before the closing <code className="rounded bg-muted px-1 text-xs">&lt;/body&gt;</code> tag on every page
        where the chat should appear.
      </p>
      {!active && (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
          The widget is currently disabled and will not appear on your website.
        </p>
      )}
      <div className="group relative mt-4">
        <pre className="overflow-x-auto rounded-lg bg-slate-950 p-4 pe-14 font-mono text-[12.5px] leading-relaxed text-slate-100">
          <code>{snippet}</code>
        </pre>
        <Button size="icon" variant="secondary" className="absolute end-2 top-2 h-8 w-8" onClick={copy} aria-label="Copy embed code">
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </Button>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button asChild variant="outline" size="sm">
          <Link href="/agent/test">
            <FlaskConical className="me-2 h-4 w-4" /> Open test page
          </Link>
        </Button>
        <Button asChild variant="ghost" size="sm">
          <a href={`/widget/${botKey}`} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="me-2 h-4 w-4" /> Hosted chat page
          </a>
        </Button>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Open the chat from your own buttons with <code className="rounded bg-muted px-1">window.OmniAI.open()</code>.
      </p>
    </section>
  );
}
