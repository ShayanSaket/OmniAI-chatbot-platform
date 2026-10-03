import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { WidgetTestHarness } from '@/components/agent/widget-test-harness';
import { requirePageAuth } from '@/server/auth/session';
import { getPrimaryBot } from '@/server/modules/bot/bot-service';

export const metadata: Metadata = { title: 'Widget test page' };

export default async function WidgetTestPage() {
  const ctx = await requirePageAuth('bot:manage');
  const bot = await getPrimaryBot(ctx);

  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/agent" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Back to AI Agent
      </Link>
      <div className="mt-6 rounded-xl border bg-card p-8 shadow-sm">
        <p className="text-xs font-medium uppercase tracking-wider text-primary">Test page</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">This page embeds your live widget</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          The chat in the corner is loaded with the same snippet your website uses, talks to the real assistant, and
          creates real conversations in your workspace. Use it to check appearance, streaming replies, uploads and the
          “Talk to a human” flow before going live.
        </p>
        {!bot.isActive && (
          <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            The widget is disabled — enable it on the AI Agent page to test.
          </p>
        )}
        <WidgetTestHarness botKey={bot.publicKey} />
      </div>
    </div>
  );
}
