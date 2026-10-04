'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarRange } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { periodQueryString, type AnalyticsPeriod, type PeriodQuery } from '@/lib/analytics';
import { cn } from '@/lib/utils';

const PRESETS: { value: Exclude<AnalyticsPeriod, 'custom'>; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
];

interface Props {
  value: PeriodQuery;
  /** Current analytics tab, kept when the period changes. */
  view: string;
  /** Today in the organization's time zone (YYYY-MM-DD), the latest selectable date. */
  today: string;
  label: string;
}

export function PeriodPicker({ value, view, today, label }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(value.from ?? '');
  const [to, setTo] = useState(value.to ?? today);
  const go = (q: PeriodQuery) => router.push(`/analytics?view=${view}&${periodQueryString(q)}`, { scroll: false });
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to && to <= today;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <nav aria-label="Date range" className="inline-flex rounded-lg border bg-card p-0.5 shadow-sm">
        {PRESETS.map((r) => (
          <button
            key={r.value}
            type="button"
            onClick={() => go({ range: r.value })}
            aria-current={value.range === r.value ? 'page' : undefined}
            className={cn(
              'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
              value.range === r.value ? 'bg-foreground text-background shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {r.label}
          </button>
        ))}
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-current={value.range === 'custom' ? 'page' : undefined}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                value.range === 'custom' ? 'bg-foreground text-background shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <CalendarRange className="h-3.5 w-3.5" />
              {value.range === 'custom' ? label : 'Custom'}
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72">
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (!valid) return;
                setOpen(false);
                go({ range: 'custom', from, to });
              }}
            >
              <p className="text-sm font-medium">Custom range</p>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label htmlFor="range-from" className="text-xs">
                    From
                  </Label>
                  <Input id="range-from" type="date" value={from} max={to || today} onChange={(e) => setFrom(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="range-to" className="text-xs">
                    To
                  </Label>
                  <Input id="range-to" type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">Up to one year. Compared with the period of the same length before it.</p>
              <Button type="submit" size="sm" className="w-full" disabled={!valid}>
                Apply
              </Button>
            </form>
          </PopoverContent>
        </Popover>
      </nav>
    </div>
  );
}
