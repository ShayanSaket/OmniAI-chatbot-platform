import { describe, expect, it } from 'vitest';
import { formatDuration, percentChange } from '@/lib/format';
import { localDateKey, startOfDayInZone } from '@/lib/time';
import { organizationUpdateSchema, registerSchema } from '@/lib/validation';
import { rangeWindow } from '@/server/modules/analytics/overview-service';
import { slugify } from '@/server/modules/organizations/provisioning';

describe('registration validation', () => {
  const valid = { name: 'Jane', email: '  Jane@Example.COM ', password: 'Password12345', organizationName: 'ACME' };

  it('normalizes email', () => {
    expect(registerSchema.parse(valid).email).toBe('jane@example.com');
  });

  it('enforces password strength', () => {
    expect(registerSchema.safeParse({ ...valid, password: 'short1' }).success).toBe(false);
    expect(registerSchema.safeParse({ ...valid, password: 'onlyletterspassword' }).success).toBe(false);
    expect(registerSchema.safeParse({ ...valid, password: '12345678901' }).success).toBe(false);
  });
});

describe('organization update validation', () => {
  it('accepts valid partial updates', () => {
    expect(organizationUpdateSchema.parse({ timezone: 'Europe/Berlin', defaultLanguage: 'fa' })).toEqual({
      timezone: 'Europe/Berlin',
      defaultLanguage: 'fa',
    });
  });

  it('rejects unknown time zones, languages and non-http URLs', () => {
    expect(organizationUpdateSchema.safeParse({ timezone: 'Mars/Base' }).success).toBe(false);
    expect(organizationUpdateSchema.safeParse({ defaultLanguage: 'xx' }).success).toBe(false);
    expect(organizationUpdateSchema.safeParse({ website: 'javascript:alert(1)' }).success).toBe(false);
    expect(organizationUpdateSchema.safeParse({ messageRetentionDays: 5 }).success).toBe(false);
  });
});

describe('time zones', () => {
  it('finds local midnight in Berlin (summer and winter time)', () => {
    expect(startOfDayInZone(new Date('2026-07-15T10:00:00Z'), 'Europe/Berlin').toISOString()).toBe('2026-07-14T22:00:00.000Z');
    expect(startOfDayInZone(new Date('2026-01-15T10:00:00Z'), 'Europe/Berlin').toISOString()).toBe('2026-01-14T23:00:00.000Z');
  });

  it('handles the DST switch day', () => {
    // 29 Mar 2026: clocks jump 02:00 → 03:00 in Berlin; midnight is still UTC+1.
    expect(startOfDayInZone(new Date('2026-03-29T12:00:00Z'), 'Europe/Berlin').toISOString()).toBe('2026-03-28T23:00:00.000Z');
  });

  it('uses the local calendar date near midnight', () => {
    expect(localDateKey(new Date('2026-07-14T22:30:00Z'), 'Europe/Berlin')).toBe('2026-07-15');
    expect(localDateKey(new Date('2026-07-14T22:30:00Z'), 'America/New_York')).toBe('2026-07-14');
  });

  it('builds analytics windows of equal length', () => {
    const now = new Date('2026-10-03T12:00:00Z');
    const w = rangeWindow('7d', 'Europe/Berlin', now);
    expect(w.today.toISOString()).toBe('2026-10-02T22:00:00.000Z');
    expect(w.start.toISOString()).toBe('2026-09-26T22:00:00.000Z');
    expect(w.previousStart.toISOString()).toBe('2026-09-19T22:00:00.000Z');
    expect(rangeWindow('today', 'Europe/Berlin', now).start).toEqual(w.today);
  });
});

describe('formatting', () => {
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('—');
    expect(formatDuration(42)).toBe('42s');
    expect(formatDuration(95)).toBe('1m 35s');
    expect(formatDuration(3720)).toBe('1h 2m');
  });

  it('computes percent change only with a baseline', () => {
    expect(percentChange(12, 10)).toBe(20);
    expect(percentChange(5, 0)).toBeNull();
    expect(percentChange(5, null)).toBeNull();
  });

  it('slugifies organization names', () => {
    expect(slugify('Müller & Söhne GmbH')).toBe('muller-sohne-gmbh');
    expect(slugify('!!!')).toBe('org');
  });
});
