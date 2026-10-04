import { describe, expect, it } from 'vitest';
import { customerQueryString, customerUpdateSchema, DEFAULT_CUSTOMER_FILTERS, parseCustomerQuery } from '@/lib/customers';
import { DEFAULT_LEAD_FILTERS, leadCreateSchema, leadQueryString, leadUpdateSchema, parseLeadQuery } from '@/lib/leads';

describe('customer filters and inputs', () => {
  it('parses and round-trips filters', () => {
    expect(parseCustomerQuery(new URLSearchParams('type=robot&sort=random'))).toMatchObject(DEFAULT_CUSTOMER_FILTERS);
    const f = { ...DEFAULT_CUSTOMER_FILTERS, type: 'identified' as const, channel: 'WHATSAPP' as const, q: 'anna', sort: 'name' as const };
    expect(parseCustomerQuery(new URLSearchParams(customerQueryString(f, '50')))).toEqual({ ...f, cursor: '50' });
  });

  it('normalizes edits: empty strings clear, emails lower-case, phones checked', () => {
    expect(customerUpdateSchema.parse({ name: '  ', email: ' Anna@Example.COM ' })).toEqual({ name: null, email: 'anna@example.com' });
    expect(customerUpdateSchema.safeParse({ email: 'not-an-email' }).success).toBe(false);
    expect(customerUpdateSchema.safeParse({ phone: 'call me' }).success).toBe(false);
    expect(customerUpdateSchema.safeParse({ phone: '+49 (151) 234-5678' }).success).toBe(true);
    expect(customerUpdateSchema.safeParse({}).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`f${i}`, 'x']));
    expect(customerUpdateSchema.safeParse({ customFields: many }).success).toBe(false);
  });
});

describe('lead filters and inputs', () => {
  it('parses and round-trips filters', () => {
    expect(parseLeadQuery(new URLSearchParams('status=BOGUS&source=FAX'))).toMatchObject(DEFAULT_LEAD_FILTERS);
    const f = { ...DEFAULT_LEAD_FILTERS, status: 'open' as const, source: 'MANUAL' as const, temperature: 'HOT' as const };
    expect(parseLeadQuery(new URLSearchParams(leadQueryString(f)))).toEqual({ ...f, cursor: undefined });
  });

  it('requires a way to reach the lead and a name or company', () => {
    expect(leadCreateSchema.safeParse({ name: 'Anna' }).success).toBe(false);
    expect(leadCreateSchema.safeParse({ email: 'a@b.de' }).success).toBe(false);
    expect(leadCreateSchema.safeParse({ company: 'Nordwind', phone: '+49 40 123456' }).success).toBe(true);
    expect(leadCreateSchema.safeParse({ name: 'A', email: 'a@b.de', estimatedValue: -5 }).success).toBe(false);
    expect(leadUpdateSchema.safeParse({ status: 'WON' }).success).toBe(true);
    expect(leadUpdateSchema.safeParse({ status: 'ARCHIVED' }).success).toBe(false);
    expect(leadUpdateSchema.safeParse({}).success).toBe(false);
  });
});
