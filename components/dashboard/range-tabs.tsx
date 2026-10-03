import Link from 'next/link';
import type { AnalyticsRange } from '@/lib/validation';
import { cn } from '@/lib/utils';

const RANGES: { value: AnalyticsRange; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
];

export function RangeTabs({ value }: { value: AnalyticsRange }) {
  return (
    <nav aria-label="Date range" className="inline-flex rounded-lg border bg-card p-0.5 shadow-sm">
      {RANGES.map((r) => (
        <Link
          key={r.value}
          href={`?range=${r.value}`}
          scroll={false}
          aria-current={value === r.value ? 'page' : undefined}
          className={cn(
            'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
            value === r.value ? 'bg-foreground text-background shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {r.label}
        </Link>
      ))}
    </nav>
  );
}
