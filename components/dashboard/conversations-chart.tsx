'use client';

import { useMemo, useState } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipProps } from 'recharts';
import { format, parseISO } from 'date-fns';
import { Table2, LineChart as LineChartIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Point {
  bucket: string;
  website: number;
  whatsapp: number;
  other: number;
}

const SERIES = [
  { key: 'website', label: 'Website', color: 'hsl(var(--chart-1))' },
  { key: 'whatsapp', label: 'WhatsApp', color: 'hsl(var(--chart-2))' },
] as const;

function bucketLabel(bucket: string, long = false) {
  if (bucket.includes(':')) return bucket; // hourly
  const date = parseISO(bucket);
  return format(date, long ? 'EEE, d MMM' : 'd MMM');
}

function ChartTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null;
  const total = payload.reduce((sum, p) => sum + Number(p.value ?? 0), 0);
  return (
    <div className="min-w-[160px] rounded-lg border bg-popover px-3 py-2.5 text-xs shadow-lg">
      <p className="mb-1.5 font-medium text-foreground">{bucketLabel(String(label), true)}</p>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center justify-between gap-4 py-0.5">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
            {SERIES.find((s) => s.key === p.dataKey)?.label}
          </span>
          <span className="font-medium tabular-nums text-foreground">{p.value}</span>
        </div>
      ))}
      <div className="mt-1.5 flex justify-between border-t pt-1.5">
        <span className="text-muted-foreground">Total</span>
        <span className="font-semibold tabular-nums text-foreground">{total}</span>
      </div>
    </div>
  );
}

export function ConversationsChart({ data }: { data: Point[] }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const totals = useMemo(
    () => ({
      website: data.reduce((s, d) => s + d.website, 0),
      whatsapp: data.reduce((s, d) => s + d.whatsapp, 0),
    }),
    [data],
  );
  const hourly = data[0]?.bucket.includes(':');

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <ul className="flex items-center gap-4 text-xs" aria-label="Legend">
          {SERIES.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5 text-muted-foreground">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
              {s.label}
              <span className="font-medium tabular-nums text-foreground">{totals[s.key]}</span>
            </li>
          ))}
        </ul>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground"
          onClick={() => setView(view === 'chart' ? 'table' : 'chart')}
          aria-pressed={view === 'table'}
        >
          {view === 'chart' ? <Table2 className="mr-1.5 h-3.5 w-3.5" /> : <LineChartIcon className="mr-1.5 h-3.5 w-3.5" />}
          {view === 'chart' ? 'Table view' : 'Chart view'}
        </Button>
      </div>

      {view === 'chart' ? (
        <div className="h-[260px]" role="img" aria-label="Conversations over time by channel">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
              <defs>
                {SERIES.map((s) => (
                  <linearGradient key={s.key} id={`fill-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={s.color} stopOpacity={0.18} />
                    <stop offset="100%" stopColor={s.color} stopOpacity={0} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeDasharray="0" />
              <XAxis
                dataKey="bucket"
                tickFormatter={(v: string) => bucketLabel(v)}
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                interval={hourly ? 3 : 'preserveStartEnd'}
                minTickGap={16}
              />
              <YAxis
                allowDecimals={false}
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                width={44}
              />
              <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'hsl(var(--muted-foreground))', strokeWidth: 1, strokeDasharray: '3 3' }} />
              {SERIES.map((s) => (
                <Area
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  stroke={s.color}
                  strokeWidth={2}
                  fill={`url(#fill-${s.key})`}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: 'hsl(var(--card))' }}
                  dot={false}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="max-h-[260px] overflow-auto rounded-md border scrollbar-thin">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted/80 text-xs text-muted-foreground backdrop-blur">
              <tr>
                <th className="px-3 py-2 text-left font-medium">{hourly ? 'Hour' : 'Day'}</th>
                <th className="px-3 py-2 text-right font-medium">Website</th>
                <th className="px-3 py-2 text-right font-medium">WhatsApp</th>
                <th className="px-3 py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {data.map((d) => (
                <tr key={d.bucket} className="border-t">
                  <td className="px-3 py-1.5">{bucketLabel(d.bucket, true)}</td>
                  <td className="px-3 py-1.5 text-right">{d.website}</td>
                  <td className="px-3 py-1.5 text-right">{d.whatsapp}</td>
                  <td className="px-3 py-1.5 text-right font-medium">{d.website + d.whatsapp + d.other}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
