import { addDays, zonedTimeOnDay, zonedWeekdayMinutes } from './time';

export interface BusinessHoursRule {
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
  /** "HH:mm" local time */
  opensAt: string;
  /** "HH:mm" local time; earlier than or equal to opensAt means the shift runs past midnight. */
  closesAt: string;
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** True when `now` falls inside any rule (in the organization's time zone). */
export function isWithinBusinessHours(rules: BusinessHoursRule[], timeZone: string, now = new Date()): boolean {
  const { weekday, minutes } = zonedWeekdayMinutes(now, timeZone);
  const yesterday = (weekday + 6) % 7;
  return rules.some((r) => {
    const open = toMinutes(r.opensAt);
    const close = toMinutes(r.closesAt);
    if (close > open) return r.weekday === weekday && minutes >= open && minutes < close;
    // Overnight shift: from `open` on its weekday until `close` on the next day.
    return (r.weekday === weekday && minutes >= open) || (r.weekday === yesterday && minutes < close);
  });
}

/** Next opening time after `now` within the coming 8 days, or null if there is none. */
export function nextOpening(rules: BusinessHoursRule[], timeZone: string, now = new Date()): Date | null {
  if (rules.length === 0) return null;
  let best: Date | null = null;
  for (let offset = 0; offset <= 8; offset++) {
    const day = addDays(now, offset);
    const { weekday } = zonedWeekdayMinutes(day, timeZone);
    for (const r of rules) {
      if (r.weekday !== weekday) continue;
      const at = zonedTimeOnDay(day, toMinutes(r.opensAt), timeZone);
      if (at.getTime() > now.getTime() && (!best || at < best)) best = at;
    }
    if (best) return best;
  }
  return best;
}
