'use client';

import { useEffect, useState } from 'react';
import { Loader2, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ApiError, api } from '@/lib/api-client';
import { MAX_CUSTOM_FIELDS, type CustomerProfile } from '@/lib/customers';
import { SUPPORTED_LANGUAGES } from '@/lib/validation';

interface Props {
  customer: CustomerProfile;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (customer: CustomerProfile) => void;
}

type Field = { key: string; value: string };

export function CustomerEditDialog({ customer, open, onOpenChange, onSaved }: Props) {
  const [form, setForm] = useState({ name: '', email: '', phone: '', company: '', language: '' });
  const [fields, setFields] = useState<Field[]>([]);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm({ name: customer.name ?? '', email: customer.email ?? '', phone: customer.phone ?? '', company: customer.company ?? '', language: customer.language ?? '' });
    setFields(Object.entries(customer.customFields).map(([key, value]) => ({ key, value })));
    setErrors({});
  }, [open, customer]);

  async function save() {
    const keys = fields.map((f) => f.key.trim()).filter(Boolean);
    if (new Set(keys.map((k) => k.toLowerCase())).size !== keys.length) {
      setErrors({ customFields: 'Field names must be unique' });
      return;
    }
    setSaving(true);
    setErrors({});
    try {
      const res = await api<{ data: CustomerProfile }>(`/api/v1/customers/${customer.id}`, {
        method: 'PATCH',
        json: {
          name: form.name,
          email: form.email,
          phone: form.phone,
          company: form.company,
          language: form.language || null,
          customFields: Object.fromEntries(fields.filter((f) => f.key.trim()).map((f) => [f.key.trim(), f.value])),
        },
      });
      onSaved(res.data);
      onOpenChange(false);
      toast.success('Customer updated.');
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors) setErrors(Object.fromEntries(Object.entries(err.fieldErrors).map(([k, v]) => [k, v?.[0]])));
      else toast.error(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  const input = (key: keyof typeof form, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div className="space-y-1.5">
      <Label htmlFor={`cust-${key}`}>{label}</Label>
      <Input id={`cust-${key}`} value={form[key]} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} aria-invalid={Boolean(errors[key])} {...props} />
      {errors[key] && <p className="text-xs text-destructive">{errors[key]}</p>}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit customer</DialogTitle>
          <DialogDescription>Contact details are used by the AI and the team. Only store what you need.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          {input('name', 'Name', { maxLength: 100, autoComplete: 'off' })}
          {input('company', 'Company', { maxLength: 120 })}
          {input('email', 'Email', { type: 'email', maxLength: 254 })}
          {input('phone', 'Phone', { type: 'tel', maxLength: 32 })}
          <div className="space-y-1.5">
            <Label htmlFor="cust-language">Language</Label>
            <Select value={form.language || 'none'} onValueChange={(v) => setForm((f) => ({ ...f, language: v === 'none' ? '' : v }))}>
              <SelectTrigger id="cust-language">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Not set</SelectItem>
                {SUPPORTED_LANGUAGES.map((l) => (
                  <SelectItem key={l.code} value={l.code}>
                    {l.label}
                  </SelectItem>
                ))}
                {form.language && !SUPPORTED_LANGUAGES.some((l) => l.code === form.language) && <SelectItem value={form.language}>{form.language.toUpperCase()}</SelectItem>}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Custom fields</Label>
            <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" disabled={fields.length >= MAX_CUSTOM_FIELDS} onClick={() => setFields((f) => [...f, { key: '', value: '' }])}>
              <Plus className="me-1 h-3.5 w-3.5" /> Add field
            </Button>
          </div>
          {fields.length === 0 && <p className="text-xs text-muted-foreground">For example: customer number, plan, contract end.</p>}
          {fields.map((f, i) => (
            <div key={i} className="flex gap-2">
              <Input aria-label="Field name" placeholder="Name" value={f.key} maxLength={40} onChange={(e) => setFields((list) => list.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} className="w-2/5" />
              <Input aria-label="Field value" placeholder="Value" value={f.value} maxLength={500} onChange={(e) => setFields((list) => list.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
              <Button type="button" variant="ghost" size="icon" aria-label="Remove field" onClick={() => setFields((list) => list.filter((_, j) => j !== i))}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
          {errors.customFields && <p className="text-xs text-destructive">{errors.customFields}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving && <Loader2 className="me-1.5 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
