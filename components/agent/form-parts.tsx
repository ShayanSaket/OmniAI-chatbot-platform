'use client';

import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';

// Building blocks shared by the AI Agent settings screens.

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: React.ReactNode;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? <p className="text-[13px] font-medium text-destructive">{error}</p> : hint ? <p className="text-[13px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function ToggleRow({
  id,
  label,
  description,
  checked,
  onChange,
  disabled,
  children,
}: {
  id: string;
  label: string;
  description: React.ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-4 rounded-lg border p-3.5', disabled && 'opacity-60')}>
      <div className="min-w-0">
        <Label htmlFor={id}>{label}</Label>
        <div className="mt-0.5 text-[13px] text-muted-foreground">{description}</div>
        {children}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

export function SettingsSection({
  title,
  description,
  action,
  children,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('space-y-5 rounded-xl border bg-card p-5 shadow-sm shadow-black/[0.02] sm:p-6', className)}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
        </div>
        {action && <div className="shrink-0 whitespace-nowrap">{action}</div>}
      </div>
      {children}
    </section>
  );
}

export function SaveBar({ dirty, saving, onSave, onDiscard }: { dirty: boolean; saving: boolean; onSave: () => void; onDiscard: () => void }) {
  return (
    <div className="sticky bottom-4 z-10 flex items-center justify-end gap-3 rounded-xl border bg-card/90 p-3 shadow-lg backdrop-blur">
      <span className="me-auto ps-2 text-sm text-muted-foreground">{dirty ? 'You have unsaved changes' : 'All changes saved'}</span>
      <Button variant="ghost" disabled={!dirty || saving} onClick={onDiscard}>
        Discard
      </Button>
      <Button onClick={onSave} disabled={!dirty || saving}>
        {saving && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
        Save changes
      </Button>
    </div>
  );
}

/** First error message per top-level field, from a Zod issue list or an API error. */
export function fieldErrorsFrom(source: { issues: { path: (string | number)[]; message: string }[] } | unknown): Record<string, string> {
  if (source instanceof ApiError) {
    return Object.fromEntries(Object.entries(source.fieldErrors ?? {}).map(([k, v]) => [k, v?.[0] ?? 'Invalid']));
  }
  const issues = (source as { issues?: { path: (string | number)[]; message: string }[] })?.issues ?? [];
  const out: Record<string, string> = {};
  for (const issue of issues) out[String(issue.path[0])] ??= issue.message;
  return out;
}
