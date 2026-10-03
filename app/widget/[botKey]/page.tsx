import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { WidgetApp } from '@/components/widget/widget-app';
import { resolveBot } from '@/server/channels/website/widget-auth';
import { publicWidgetConfig } from '@/server/modules/widget/widget-service';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: { botKey: string } }): Promise<Metadata> {
  const resolved = await resolveBot(params.botKey);
  return {
    title: resolved ? `Chat with ${resolved.bot.companyName}` : 'Chat',
    robots: { index: false, follow: false },
  };
}

/**
 * The widget document, loaded in an iframe by /chat-widget.js (or opened directly as a
 * hosted chat page). Framing is allowed from any site; which sites may actually start a
 * session is enforced by the session API using the browser-verified embedding origin.
 */
export default async function WidgetPage({ params }: { params: { botKey: string } }) {
  const resolved = await resolveBot(params.botKey);
  if (!resolved) notFound();
  return <WidgetApp initialConfig={publicWidgetConfig(resolved)} />;
}
