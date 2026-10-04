'use client';

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipProps } from 'recharts';
import { format, parseISO } from 'date-fns';

interface Point {
  bucket: string;
  messages: number;
  costUsd: number;
}

const label = (bucket: string, long = false) => (bucket.includes(':') ? bucket : format(parseISO(bucket), long ? 'EEE, d MMM' : 'd MMM'));

function TooltipBox({ active, payload, label: l, unit }: TooltipProps<number, string> & { unit: 'messages' | 'cost' }) {
  if (!active || !payload?.length) return null;
  const v = Number(payload[0]!.value ?? 0);
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 font-medium">{label(String(l), true)}</p>
      <p className="tabular-nums text-muted-foreground">{unit === 'cost' ? `$${v.toFixed(4)}` : `${v} messages`}</p>
    </div>
  );
}

/** Single-series bar chart (messages or AI cost per bucket). */
export function ActivityChart({ data, metric }: { data: Point[]; metric: 'messages' | 'cost' }) {
  const key = metric === 'cost' ? 'costUsd' : 'messages';
  const hourly = data[0]?.bucket.includes(':');
  return (
    <div className="h-[200px]" role="img" aria-label={metric === 'cost' ? 'AI cost over time' : 'Messages over time'}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 4, left: -12, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
          <XAxis
            dataKey="bucket"
            tickFormatter={(v: string) => label(v)}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
            interval={hourly ? 3 : 'preserveStartEnd'}
            minTickGap={16}
          />
          <YAxis
            allowDecimals={metric === 'cost'}
            tickFormatter={(v: number) => (metric === 'cost' ? `$${v < 0.01 && v > 0 ? Number(v.toFixed(4)).toString() : v.toFixed(2)}` : String(v))}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
            width={64}
          />
          <Tooltip content={<TooltipBox unit={metric} />} cursor={{ fill: 'hsl(var(--muted))' }} />
          <Bar dataKey={key} fill={metric === 'cost' ? 'hsl(var(--chart-3))' : 'hsl(var(--chart-1))'} radius={[3, 3, 0, 0]} maxBarSize={28} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
