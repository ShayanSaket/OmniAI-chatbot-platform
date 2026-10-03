// Time-zone helpers built on Intl (no extra dependencies). Pure and client-safe.

function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

/** Offset of `timeZone` from UTC at `date`, in milliseconds. */
export function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant at which the local calendar day containing `date` starts in `timeZone`. */
export function startOfDayInZone(date: Date, timeZone: string): Date {
  const p = zonedParts(date, timeZone);
  const localMidnightAsUtc = Date.UTC(p.year, p.month - 1, p.day);
  let guess = localMidnightAsUtc - timeZoneOffsetMs(new Date(localMidnightAsUtc), timeZone);
  // Re-check once in case midnight falls on the other side of a DST transition.
  guess = localMidnightAsUtc - timeZoneOffsetMs(new Date(guess), timeZone);
  return new Date(guess);
}

/** "YYYY-MM-DD" of `date` in `timeZone`. */
export function localDateKey(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/** Day of week (0 = Sunday) and minutes since local midnight of `date` in `timeZone`. */
export function zonedWeekdayMinutes(date: Date, timeZone: string): { weekday: number; minutes: number } {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date);
  const p = zonedParts(date, timeZone);
  return {
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday),
    minutes: p.hour * 60 + p.minute,
  };
}

/** The UTC instant of a local wall-clock time (`minutes` after midnight) on the local day containing `day`. */
export function zonedTimeOnDay(day: Date, minutes: number, timeZone: string): Date {
  const midnight = startOfDayInZone(day, timeZone);
  const guess = new Date(midnight.getTime() + minutes * 60_000);
  // Correct for a DST change between midnight and the target time.
  const drift = timeZoneOffsetMs(guess, timeZone) - timeZoneOffsetMs(midnight, timeZone);
  return new Date(guess.getTime() - drift);
}
