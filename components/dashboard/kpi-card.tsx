import { ArrowDownRight, ArrowUpRight, Minus, type LucideIcon } from 'lucide-react';
import { percentChange } from '@/lib/format';
import { cn } from '@/lib/utils';

interface KpiCardProps {
  label: string;
  value: string;
  current: number;
  previous: number | null;
  icon: LucideIcon;
  /** True when a decrease is the good direction (e.g. response time, escalations). */
  lowerIsBetter?: boolean;
  hint?: string;
  comparisonLabel: string;
}

export function KpiCard({ label, value, current, previous, icon: Icon, lowerIsBetter, hint, comparisonLabel }: KpiCardProps) {
  const change = percentChange(current, previous);
  const direction = change === null || change === 0 ? 'flat' : change > 0 ? 'up' : 'down';
  const good = direction === 'flat' ? null : (direction === 'up') !== Boolean(lowerIsBetter);
  const DeltaIcon = direction === 'up' ? ArrowUpRight : direction === 'down' ? ArrowDownRight : Minus;

  return (
    <div className="group rounded-xl border bg-card p-4 shadow-sm shadow-black/[0.02] transition-shadow hover:shadow-md sm:p-5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-medium text-muted-foreground">{label}</p>
        <Icon className="h-4 w-4 text-muted-foreground/70" aria-hidden />
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
      <div className="mt-2 flex min-h-[20px] flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
        {change !== null ? (
          <>
            <span
              className={cn(
                'inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 font-medium tabular-nums',
                good === null && 'bg-muted text-muted-foreground',
                good === true && 'bg-success/10 text-success',
                good === false && 'bg-destructive/10 text-destructive',
              )}
            >
              <DeltaIcon className="h-3 w-3" aria-hidden />
              <span className="sr-only">{direction === 'up' ? 'Up' : direction === 'down' ? 'Down' : 'No change'}</span>
              {Math.abs(change)}%
            </span>
            <span className="text-muted-foreground">{comparisonLabel}</span>
          </>
        ) : (
          <span className="text-muted-foreground">{hint ?? 'No prior data yet'}</span>
        )}
      </div>
    </div>
  );
}
