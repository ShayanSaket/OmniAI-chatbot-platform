import { Bot, Globe, MessageCircle, ShieldCheck, Sparkles, UserRound } from 'lucide-react';
import { Logo } from '@/components/brand/logo';
import { Providers } from '@/components/providers';

function PreviewBubble({
  from,
  children,
  channel,
}: {
  from: 'customer' | 'ai';
  channel?: 'web' | 'wa';
  children: React.ReactNode;
}) {
  const isAi = from === 'ai';
  return (
    <div className={`flex items-end gap-2 ${isAi ? '' : 'flex-row-reverse'}`}>
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
          isAi ? 'bg-white/15 text-white' : 'bg-white text-indigo-700'
        }`}
      >
        {isAi ? <Bot className="h-3.5 w-3.5" /> : <UserRound className="h-3.5 w-3.5" />}
      </span>
      <div
        className={`max-w-[78%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed ${
          isAi ? 'rounded-bl-md bg-white/10 text-white backdrop-blur' : 'rounded-br-md bg-white text-slate-800'
        }`}
      >
        {channel && (
          <span className="mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-indigo-500">
            {channel === 'wa' ? <MessageCircle className="h-3 w-3" /> : <Globe className="h-3 w-3" />}
            {channel === 'wa' ? 'WhatsApp' : 'Website'}
          </span>
        )}
        {children}
      </div>
    </div>
  );
}

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <Providers>
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <div className="flex flex-col px-6 py-8 sm:px-12">
        <Logo />
        <main className="flex flex-1 items-center justify-center py-12">
          <div className="w-full max-w-[380px] animate-fade-in">{children}</div>
        </main>
        <p className="text-xs text-muted-foreground">© {new Date().getFullYear()} OmniAI</p>
      </div>

      <aside aria-hidden className="relative hidden overflow-hidden bg-[#0f0d2e] lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div className="pointer-events-none absolute -right-32 -top-32 h-[480px] w-[480px] rounded-full bg-indigo-600/40 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-40 -left-24 h-[420px] w-[420px] rounded-full bg-fuchsia-600/25 blur-3xl" />
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              'linear-gradient(to right, white 1px, transparent 1px), linear-gradient(to bottom, white 1px, transparent 1px)',
            backgroundSize: '44px 44px',
          }}
        />

        <div className="relative">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-medium text-indigo-200">
            <Sparkles className="h-3.5 w-3.5" /> One AI agent · every channel
          </span>
          <h2 className="mt-6 max-w-md text-3xl font-semibold leading-tight tracking-tight text-white">
            Answer every customer, on every channel, with answers you can trust.
          </h2>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-indigo-200/80">
            Website chat and WhatsApp share one knowledge base, one customer record and one inbox — with a human a click
            away.
          </p>
        </div>

        <div className="relative mx-auto w-full max-w-md space-y-3 rounded-2xl border border-white/10 bg-white/[0.04] p-5 shadow-2xl backdrop-blur-sm">
          <PreviewBubble from="customer" channel="wa">
            Was kostet die Einrichtung für Website und WhatsApp?
          </PreviewBubble>
          <PreviewBubble from="ai">
            Das hängt vor allem von den Kanälen und Integrationen ab. Planen Sie beide Kanäle von Anfang an oder starten
            Sie mit einem?
          </PreviewBubble>
          <PreviewBubble from="customer">Beide — etwa 200 Anfragen im Monat.</PreviewBubble>
          <div className="flex items-center gap-2 pl-9 text-[11px] text-indigo-200/70">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Lead qualified · summary shared with sales
          </div>
        </div>

        <div className="relative flex items-center gap-2 text-xs text-indigo-200/70">
          <ShieldCheck className="h-4 w-4" /> Role-based access · tenant isolation · audit trail
        </div>
      </aside>
    </div>
    </Providers>
  );
}
