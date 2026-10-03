const numberFormat = new Intl.NumberFormat('en-US');

export function formatNumber(value: number): string {
  return numberFormat.format(value);
}

export function formatPercent(value: number): string {
  return `${value.toFixed(value % 1 === 0 ? 0 : 1)}%`;
}

/** 0 → "—", 42 → "42s", 95 → "1m 35s", 3720 → "1h 2m" */
export function formatDuration(seconds: number): string {
  if (!seconds || seconds < 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return s ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Relative change in percent, or null when there is no meaningful baseline. */
export function percentChange(current: number, previous: number | null): number | null {
  if (previous === null || previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

const ACRONYMS = new Set(['FAQ', 'AI', 'API', 'SMS']);

export function humanize(enumValue: string): string {
  if (ACRONYMS.has(enumValue)) return enumValue;
  return enumValue
    .toLowerCase()
    .split('_')
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}
