import 'server-only';
import { MAX_CUSTOM_DAYS, type PeriodQuery, type ResolvedPeriod } from '@/lib/analytics';
import { addDays, localDateKey, startOfDayInZone } from '@/lib/time';

export interface Period {
  query: PeriodQuery;
  start: Date;
  /** Exclusive. */
  end: Date;
  previousStart: Date;
  days: number;
  bucket: 'hour' | 'day';
}

const DAY_MS = 86_400_000;
/** Noon UTC of a calendar date: on that same date in every common time zone. */
const noonOf = (date: string) => new Date(`${date}T12:00:00Z`);

/** Turns a period query into concrete instants in the organization's time zone. */
export function resolvePeriod(query: PeriodQuery, timeZone: string, now = new Date()): Period {
  const today = startOfDayInZone(now, timeZone);
  const tomorrow = startOfDayInZone(addDays(today, 1.5), timeZone);
  let start: Date;
  let end = tomorrow;
  if (query.range === 'custom' && query.from && query.to) {
    const todayKey = localDateKey(now, timeZone);
    const to = query.to > todayKey ? todayKey : query.to;
    let from = query.from > to ? to : query.from;
    const span = Math.round((noonOf(to).getTime() - noonOf(from).getTime()) / DAY_MS) + 1;
    if (span > MAX_CUSTOM_DAYS) from = localDateKey(addDays(noonOf(to), -(MAX_CUSTOM_DAYS - 1)), 'UTC');
    start = startOfDayInZone(noonOf(from), timeZone);
    end = startOfDayInZone(addDays(noonOf(to), 1), timeZone);
    query = { range: 'custom', from, to };
  } else {
    const days = query.range === 'today' ? 1 : query.range === '7d' ? 7 : query.range === '90d' ? 90 : 30;
    start = days === 1 ? today : startOfDayInZone(addDays(today, -(days - 1) + 0.5), timeZone);
    query = { range: query.range === 'custom' ? '30d' : query.range };
  }
  const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / DAY_MS));
  const previousStart = startOfDayInZone(addDays(start, -days + 0.5), timeZone);
  return { query, start, end, previousStart, days, bucket: days === 1 ? 'hour' : 'day' };
}

const LABEL: Record<string, string> = { today: 'Today', '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days' };

export function describePeriod(p: Period, timeZone: string): ResolvedPeriod {
  const fmt = (d: Date, year: boolean) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}), timeZone }).format(d);
  const last = new Date(p.end.getTime() - 1);
  const label =
    p.query.range === 'custom'
      ? p.days === 1
        ? fmt(p.start, true)
        : `${fmt(p.start, p.start.getUTCFullYear() !== last.getUTCFullYear())} – ${fmt(last, true)}`
      : LABEL[p.query.range]!;
  return {
    query: p.query,
    start: p.start.toISOString(),
    end: p.end.toISOString(),
    previousStart: p.previousStart.toISOString(),
    days: p.days,
    bucket: p.bucket,
    label,
  };
}

/** Every bucket key of the period, so charts get a continuous axis. */
export function bucketKeys(p: Period, timeZone: string): string[] {
  if (p.bucket === 'hour') return Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);
  return Array.from({ length: p.days }, (_, i) => localDateKey(addDays(p.start, i + 0.5), timeZone));
}
