'use client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { LEAD_TEMPERATURES, PREFERRED_CONTACTS } from '@/lib/leads';
import { humanize } from '@/lib/format';
import type { InboxMember } from '@/lib/inbox';

export interface LeadFormValues {
  name: string;
  email: string;
  phone: string;
  company: string;
  requestedService: string;
  message: string;
  preferredContact: string;
  temperature: string;
  estimatedValue: string;
  assignedToId: string;
}

export const EMPTY_LEAD: LeadFormValues = {
  name: '',
  email: '',
  phone: '',
  company: '',
  requestedService: '',
  message: '',
  preferredContact: '',
  temperature: 'WARM',
  estimatedValue: '',
  assignedToId: '',
};

/** Form values → API payload (empty strings clear a field). */
export function leadPayload(v: LeadFormValues) {
  const value = v.estimatedValue.replace(',', '.').trim();
  return {
    name: v.name,
    email: v.email,
    phone: v.phone,
    company: v.company,
    requestedService: v.requestedService,
    message: v.message,
    preferredContact: v.preferredContact || null,
    temperature: v.temperature,
    estimatedValue: value ? Number(value) : null,
    assignedToId: v.assignedToId || null,
  };
}

interface Props {
  values: LeadFormValues;
  onChange: (values: LeadFormValues) => void;
  errors: Record<string, string | undefined>;
  members: InboxMember[];
  currency: string;
  disabled?: boolean;
}

export function LeadForm({ values, onChange, errors, members, currency, disabled }: Props) {
  const set = (key: keyof LeadFormValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange({ ...values, [key]: e.target.value });
  const field = (key: keyof LeadFormValues, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div className="space-y-1.5">
      <Label htmlFor={`lead-${key}`}>{label}</Label>
      <Input id={`lead-${key}`} value={values[key]} onChange={set(key)} aria-invalid={Boolean(errors[key])} disabled={disabled} {...props} />
      {errors[key] && <p className="text-xs text-destructive">{errors[key]}</p>}
    </div>
  );
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {field('name', 'Name', { maxLength: 100 })}
      {field('company', 'Company', { maxLength: 120 })}
      {field('email', 'Email', { type: 'email', maxLength: 254 })}
      {field('phone', 'Phone', { type: 'tel', maxLength: 32 })}
      <div className="sm:col-span-2">{field('requestedService', 'Interested in', { maxLength: 200, placeholder: 'e.g. Growth plan, onboarding package' })}</div>
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor="lead-message">Notes from the customer</Label>
        <Textarea id="lead-message" value={values.message} onChange={set('message')} rows={3} maxLength={2000} disabled={disabled} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="lead-temperature">Temperature</Label>
        <Select value={values.temperature} onValueChange={(v) => onChange({ ...values, temperature: v })} disabled={disabled}>
          <SelectTrigger id="lead-temperature">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LEAD_TEMPERATURES.map((t) => (
              <SelectItem key={t} value={t}>
                {humanize(t)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {field('estimatedValue', `Estimated value (${currency})`, { inputMode: 'decimal', placeholder: '0' })}
      <div className="space-y-1.5">
        <Label htmlFor="lead-contact">Preferred contact</Label>
        <Select value={values.preferredContact || 'none'} onValueChange={(v) => onChange({ ...values, preferredContact: v === 'none' ? '' : v })} disabled={disabled}>
          <SelectTrigger id="lead-contact">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No preference</SelectItem>
            {PREFERRED_CONTACTS.map((c) => (
              <SelectItem key={c} value={c}>
                {c === 'whatsapp' ? 'WhatsApp' : humanize(c.toUpperCase())}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="lead-owner">Owner</Label>
        <Select value={values.assignedToId || 'none'} onValueChange={(v) => onChange({ ...values, assignedToId: v === 'none' ? '' : v })} disabled={disabled}>
          <SelectTrigger id="lead-owner">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Unassigned</SelectItem>
            {members.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.name ?? m.email}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {errors.assignedToId && <p className="text-xs text-destructive">{errors.assignedToId}</p>}
      </div>
    </div>
  );
}
