'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError } from '@/lib/api-client';
import { contrastRatio } from '@/lib/color';
import { cn } from '@/lib/utils';
import { botWidgetUpdateSchema, type BotWidgetUpdateInput } from '@/lib/validation';
import type { WidgetConfig } from '@/lib/widget-protocol';
import { Field, SaveBar, ToggleRow } from './form-parts';
import { WidgetPreview } from './widget-preview';

export interface WidgetFormValues {
  isActive: boolean;
  agentName: string;
  welcomeMessage: string;
  primaryColor: string;
  widgetPosition: 'bottom-right' | 'bottom-left';
  avatarUrl: string;
  quickReplies: string[];
  allowAttachments: boolean;
  showSourcesWebsite: boolean;
  allowedOrigins: string;
}

const PRESETS = ['#4f46e5', '#2563eb', '#0891b2', '#059669', '#d97706', '#e11d48', '#7c3aed', '#0f172a'];

function toPayload(v: WidgetFormValues): BotWidgetUpdateInput {
  return {
    isActive: v.isActive,
    agentName: v.agentName,
    welcomeMessage: v.welcomeMessage,
    primaryColor: v.primaryColor,
    widgetPosition: v.widgetPosition,
    avatarUrl: v.avatarUrl.trim() || null,
    quickReplies: v.quickReplies,
    allowAttachments: v.allowAttachments,
    showSourcesWebsite: v.showSourcesWebsite,
    allowedOrigins: v.allowedOrigins
      .split(/[\n,]+/)
      .map((o) => o.trim())
      .filter(Boolean),
  };
}

export function WidgetSettings({ initial, base, appOrigin }: { initial: WidgetFormValues; base: WidgetConfig; appOrigin: string }) {
  const router = useRouter();
  const [values, setValues] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [newReply, setNewReply] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const dirty = JSON.stringify(values) !== JSON.stringify(saved);

  const set = <K extends keyof WidgetFormValues>(key: K, value: WidgetFormValues[K]) => setValues((v) => ({ ...v, [key]: value }));

  const previewConfig: WidgetConfig = useMemo(
    () => ({
      ...base,
      agentName: values.agentName || 'Assistant',
      welcomeMessage: values.welcomeMessage || '…',
      primaryColor: /^#[0-9a-f]{6}$/i.test(values.primaryColor) ? values.primaryColor : base.primaryColor,
      position: values.widgetPosition,
      avatarUrl: values.avatarUrl.startsWith('https://') ? values.avatarUrl : null,
      quickReplies: values.quickReplies,
      allowAttachments: values.allowAttachments,
      showSources: values.showSourcesWebsite,
    }),
    [base, values],
  );

  const lowContrast = /^#[0-9a-f]{6}$/i.test(values.primaryColor) && contrastRatio(values.primaryColor, '#f8fafc') < 2;

  const addReply = () => {
    const text = newReply.trim();
    if (!text || values.quickReplies.includes(text) || values.quickReplies.length >= 6) return;
    set('quickReplies', [...values.quickReplies, text.slice(0, 40)]);
    setNewReply('');
  };

  async function save() {
    const payload = toPayload(values);
    const parsed = botWidgetUpdateSchema.safeParse(payload);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) next[String(issue.path[0])] ??= issue.message;
      setErrors(next);
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      await api('/api/v1/bot', { method: 'PATCH', json: parsed.data });
      setSaved(values);
      toast.success('Widget settings saved', { description: 'Live on your website within a minute.' });
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors) {
        setErrors(Object.fromEntries(Object.entries(err.fieldErrors).map(([k, v]) => [k, v?.[0] ?? 'Invalid'])));
      }
      toast.error(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
      <div className="space-y-6">
        <section className="space-y-5 rounded-xl border bg-card p-5 shadow-sm shadow-black/[0.02] sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold">Appearance</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">How the chat looks on your website.</p>
            </div>
            <div className="flex items-center gap-2">
              <Label htmlFor="active" className="text-sm text-muted-foreground">
                {values.isActive ? 'Enabled' : 'Disabled'}
              </Label>
              <Switch id="active" checked={values.isActive} onCheckedChange={(v) => set('isActive', v)} />
            </div>
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Assistant name" htmlFor="agentName" error={errors.agentName}>
              <Input id="agentName" value={values.agentName} maxLength={60} onChange={(e) => set('agentName', e.target.value)} />
            </Field>
            <Field label="Avatar image URL" htmlFor="avatarUrl" hint="Optional, https only. Square images work best." error={errors.avatarUrl}>
              <Input id="avatarUrl" placeholder="https://…" value={values.avatarUrl} onChange={(e) => set('avatarUrl', e.target.value)} />
            </Field>
          </div>

          <Field label="Welcome message" htmlFor="welcome" hint="Shown when the chat opens and as a short teaser next to the launcher." error={errors.welcomeMessage}>
            <Textarea id="welcome" rows={3} maxLength={500} value={values.welcomeMessage} onChange={(e) => set('welcomeMessage', e.target.value)} />
          </Field>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              label="Brand color"
              htmlFor="color"
              error={errors.primaryColor}
              hint={lowContrast ? 'Very light colors make the launcher hard to see on white pages.' : 'Text color adjusts automatically for contrast.'}
            >
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label="Pick brand color"
                  value={/^#[0-9a-f]{6}$/i.test(values.primaryColor) ? values.primaryColor : '#4f46e5'}
                  onChange={(e) => set('primaryColor', e.target.value)}
                  className="h-10 w-12 cursor-pointer rounded-md border bg-transparent p-1"
                />
                <Input id="color" value={values.primaryColor} maxLength={7} onChange={(e) => set('primaryColor', e.target.value)} className="font-mono" />
              </div>
              <div className="flex flex-wrap gap-1.5 pt-1">
                {PRESETS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={`Use ${c}`}
                    onClick={() => set('primaryColor', c)}
                    className={cn('h-6 w-6 rounded-full ring-offset-2 ring-offset-background transition', values.primaryColor.toLowerCase() === c && 'ring-2 ring-ring')}
                    style={{ background: c }}
                  />
                ))}
              </div>
            </Field>
            <Field label="Position">
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Widget position">
                {(['bottom-left', 'bottom-right'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    role="radio"
                    aria-checked={values.widgetPosition === p}
                    onClick={() => set('widgetPosition', p)}
                    className={cn(
                      'relative h-20 rounded-lg border bg-muted/40 transition',
                      values.widgetPosition === p ? 'border-primary ring-2 ring-primary/20' : 'hover:border-foreground/20',
                    )}
                  >
                    <span className={cn('absolute bottom-2 h-4 w-4 rounded-full', p === 'bottom-left' ? 'left-2' : 'right-2')} style={{ background: values.primaryColor }} />
                    <span className="absolute inset-x-0 top-2 text-xs text-muted-foreground">{p === 'bottom-left' ? 'Bottom left' : 'Bottom right'}</span>
                  </button>
                ))}
              </div>
            </Field>
          </div>

          <Field label="Quick replies" hint="Suggested first questions shown under the welcome message (up to 6)." error={errors.quickReplies}>
            <div className="flex flex-wrap gap-1.5">
              {values.quickReplies.map((q) => (
                <span key={q} className="inline-flex items-center gap-1 rounded-full border bg-muted/50 py-1 pe-1 ps-3 text-sm">
                  {q}
                  <button
                    type="button"
                    aria-label={`Remove ${q}`}
                    onClick={() => set('quickReplies', values.quickReplies.filter((x) => x !== q))}
                    className="rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </span>
              ))}
            </div>
            {values.quickReplies.length < 6 && (
              <div className="flex gap-2">
                <Input
                  value={newReply}
                  maxLength={40}
                  placeholder="e.g. Pricing"
                  onChange={(e) => setNewReply(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addReply();
                    }
                  }}
                />
                <Button type="button" variant="outline" onClick={addReply} disabled={!newReply.trim()}>
                  <Plus className="me-1 h-4 w-4" /> Add
                </Button>
              </div>
            )}
          </Field>
        </section>

        <section className="space-y-4 rounded-xl border bg-card p-5 shadow-sm shadow-black/[0.02] sm:p-6">
          <div>
            <h2 className="text-base font-semibold">Behavior & security</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">What visitors can do and where the chat may run.</p>
          </div>
          <ToggleRow
            id="attachments"
            label="File & image uploads"
            description="Visitors can attach images, PDFs, DOCX and text files (max 10 MB, content-verified)."
            checked={values.allowAttachments}
            onChange={(v) => set('allowAttachments', v)}
          />
          <ToggleRow
            id="sources"
            label="Show sources"
            description="List the knowledge-base documents an answer was based on."
            checked={values.showSourcesWebsite}
            onChange={(v) => set('showSourcesWebsite', v)}
          />
          <Field
            label="Allowed websites"
            htmlFor="origins"
            error={errors.allowedOrigins}
            hint={
              <>
                One origin per line, e.g. <code className="text-xs">https://example.com</code> or <code className="text-xs">https://*.example.com</code>. Leave
                empty to allow any website. {appOrigin} is always allowed.
              </>
            }
          >
            <Textarea
              id="origins"
              rows={3}
              className="font-mono text-[13px]"
              value={values.allowedOrigins}
              onChange={(e) => set('allowedOrigins', e.target.value)}
              placeholder="https://www.example.com"
            />
          </Field>
        </section>

        <SaveBar dirty={dirty} saving={saving} onSave={save} onDiscard={() => setValues(saved)} />
      </div>

      <div className="xl:sticky xl:top-24 xl:self-start">
        <p className="mb-2 text-sm font-medium">Live preview</p>
        <WidgetPreview config={previewConfig} />
      </div>
    </div>
  );
}
