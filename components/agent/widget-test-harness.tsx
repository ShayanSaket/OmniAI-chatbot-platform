'use client';

import { useEffect } from 'react';
import { MessageCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

declare global {
  interface Window {
    OmniAI?: { open(): void; close(): void; toggle(): void; destroy(): void; state: string; __loaded?: boolean };
  }
}

/** Loads the real embed script (exactly as a customer's website would) and removes it on leave. */
export function WidgetTestHarness({ botKey }: { botKey: string }) {
  useEffect(() => {
    const script = document.createElement('script');
    script.src = `/chat-widget.js?v=${Date.now()}`;
    script.async = true;
    script.dataset.botId = botKey;
    document.body.appendChild(script);
    return () => {
      window.OmniAI?.destroy();
      script.remove();
    };
  }, [botKey]);

  return (
    <Button onClick={() => window.OmniAI?.open()} className="mt-6">
      <MessageCircle className="me-2 h-4 w-4" /> Open chat from a page button
    </Button>
  );
}
