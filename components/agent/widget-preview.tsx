'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { WidgetConfig, WidgetMessage } from '@/lib/widget-protocol';
import { stringsFor } from '@/components/widget/i18n';
import { Launcher, Panel, widgetThemeStyle } from '@/components/widget/widget-view';

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const base = { attachments: [], sources: [], quickReplies: [], actions: [], buttons: [] };

function sampleMessages(config: WidgetConfig): WidgetMessage[] {
  return [
    { ...base, id: 'p1', role: 'customer', content: 'What does implementation cost?', createdAt: minutesAgo(3), status: 'read' },
    {
      ...base,
      id: 'p2',
      role: 'ai',
      content: `Pricing depends mainly on the channels and integrations you need. I can give you a rough estimate — will you mainly use ${config.agentName} on your **website**, **WhatsApp**, or both?`,
      createdAt: minutesAgo(3),
      status: 'sent',
      quickReplies: ['Website', 'WhatsApp', 'Both'],
      sources: config.showSources ? [{ title: 'Pricing FAQ' }] : [],
    },
  ];
}

/** Static, interactive-looking preview of the real widget UI (no network). */
export function WidgetPreview({ config }: { config: WidgetConfig }) {
  const [open, setOpen] = useState(true);
  const [extra, setExtra] = useState<WidgetMessage[]>([]);
  const strings = stringsFor('en');
  const left = config.position === 'bottom-left';

  const send = (text: string) => {
    const now = new Date().toISOString();
    setExtra((m) => [
      ...m,
      { ...base, id: `c${m.length}`, role: 'customer', content: text, createdAt: now, status: 'read' },
      {
        ...base,
        id: `a${m.length}`,
        role: 'ai',
        content: 'This is a preview. Use **Open test page** to chat with the real assistant.',
        createdAt: now,
        status: 'sent',
      },
    ]);
  };

  return (
    <div
      className="relative h-[680px] overflow-hidden rounded-xl border bg-[radial-gradient(circle_at_1px_1px,hsl(var(--border))_1px,transparent_0)] [background-size:16px_16px]"
      style={widgetThemeStyle(config.primaryColor)}
      aria-label="Widget preview"
    >
      <div className="absolute inset-x-0 top-0 flex items-center gap-1.5 border-b bg-card/80 px-3 py-2 backdrop-blur">
        <span className="h-2.5 w-2.5 rounded-full bg-rose-400" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
        <span className="ms-3 truncate rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">your-website.com</span>
      </div>
      <div className={cn('absolute bottom-0 flex flex-col gap-3.5 p-4', left ? 'left-0 items-start' : 'right-0 items-end')}>
        {open && (
          <div className="animate-fade-in h-[540px] w-[360px] max-w-[calc(100vw-4rem)]">
            <Panel
              config={config}
              strings={strings}
              lang="en"
              conversation={null}
              messages={[...sampleMessages(config), ...extra]}
              streamingText={null}
              awaitingReply={false}
              connection="connected"
              expanded={false}
              canExpand={false}
              fullscreen={false}
              onClose={() => setOpen(false)}
              onSend={(text) => send(text)}
              onRestart={() => setExtra([])}
              onHandoff={() => undefined}
            />
          </div>
        )}
        <Launcher open={open} unread={open ? 0 : 1} onClick={() => setOpen((o) => !o)} strings={strings} />
      </div>
    </div>
  );
}
