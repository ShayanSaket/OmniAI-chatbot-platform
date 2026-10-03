import { MessagesSquare } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Logo({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5 font-semibold tracking-tight', className)}>
      <span className="relative flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 via-violet-500 to-fuchsia-500 text-white shadow-sm shadow-indigo-500/30">
        <MessagesSquare className="h-4 w-4" strokeWidth={2.25} />
      </span>
      {!compact && <span className="text-[15px]">OmniAI</span>}
    </span>
  );
}
