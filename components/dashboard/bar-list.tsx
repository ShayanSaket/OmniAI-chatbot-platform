import { formatNumber } from '@/lib/format';

/** Single-series horizontal magnitude bars with direct labels (HTML, no chart lib). */
export function BarList({ items, emptyLabel }: { items: { label: string; value: number }[]; emptyLabel: string }) {
  const max = Math.max(...items.map((i) => i.value), 1);
  const total = items.reduce((s, i) => s + i.value, 0);
  if (items.length === 0 || total === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">{emptyLabel}</p>;
  }
  return (
    <ul className="space-y-2.5">
      {items.map((item) => (
        <li key={item.label} title={`${item.label}: ${item.value} (${Math.round((item.value / total) * 100)}%)`}>
          <div className="mb-1 flex items-center justify-between gap-3 text-[13px]">
            <span className="truncate">{item.label}</span>
            <span className="tabular-nums text-muted-foreground">
              <span className="font-medium text-foreground">{formatNumber(item.value)}</span>
              <span className="ml-1.5 text-xs">{Math.round((item.value / total) * 100)}%</span>
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary/80 transition-[width] duration-500"
              style={{ width: `${Math.max((item.value / max) * 100, 2)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
