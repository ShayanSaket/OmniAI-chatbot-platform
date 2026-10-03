'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ESCALATION_TRIGGER_LABELS, ESCALATION_TRIGGERS, type EscalationTrigger } from '@/lib/agent-tools';
import { api } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { ANSWER_LENGTHS, botUpdateSchema, ESCALATION_BEHAVIORS, SUPPORTED_LANGUAGES, TONES } from '@/lib/validation';
import { Field, fieldErrorsFrom, SaveBar, SettingsSection } from './form-parts';

type Tone = (typeof TONES)[number];
type AnswerLength = (typeof ANSWER_LENGTHS)[number];
type EscalationBehavior = (typeof ESCALATION_BEHAVIORS)[number];

export interface BehaviorFormValues {
  agentName: string;
  companyName: string;
  businessDescription: string;
  tone: Tone;
  customTone: string;
  answerLength: AnswerLength;
  creativity: number;
  defaultLanguage: string;
  model: string;
  fallbackResponse: string;
  escalationBehavior: EscalationBehavior;
  escalateOn: EscalationTrigger[];
  showSourcesWhatsapp: boolean;
}

const TONE_LABELS: Record<Tone, { label: string; example: string }> = {
  PROFESSIONAL: { label: 'Professional', example: 'Clear and courteous.' },
  FRIENDLY: { label: 'Friendly', example: 'Warm and approachable, still precise.' },
  CONCISE: { label: 'Concise', example: 'Brief and to the point.' },
  SALES: { label: 'Sales-oriented', example: 'Highlights value without pressure.' },
  TECHNICAL: { label: 'Technical', example: 'Exact terms, step-by-step.' },
  CUSTOM: { label: 'Custom', example: 'Describe it yourself.' },
};

const LENGTH_LABELS: Record<AnswerLength, string> = { SHORT: 'Short', MEDIUM: 'Medium', LONG: 'Detailed' };

const ESCALATION_OPTIONS: Record<EscalationBehavior, { label: string; description: string }> = {
  SUGGEST: { label: 'Suggest a human', description: 'Offer a "Talk to a human" button. A direct request for a person always hands over.' },
  AUTOMATIC: { label: 'Hand over automatically', description: 'Pass the conversation to your team as soon as a trigger below is detected.' },
  DISABLED: { label: 'Never escalate', description: 'The AI handles everything. Customers can still use the handoff button in the widget.' },
};

const MODELS = ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4.1'];

function creativityLabel(v: number) {
  if (v <= 0.2) return 'Precise';
  if (v <= 0.5) return 'Balanced';
  return 'Creative';
}

export function BehaviorSettings({ initial }: { initial: BehaviorFormValues }) {
  const router = useRouter();
  const [values, setValues] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const dirty = JSON.stringify(values) !== JSON.stringify(saved);
  const set = <K extends keyof BehaviorFormValues>(key: K, value: BehaviorFormValues[K]) => setValues((v) => ({ ...v, [key]: value }));

  async function save() {
    const { escalateOn, customTone, ...rest } = values;
    const parsed = botUpdateSchema.safeParse({
      ...rest,
      customTone: values.tone === 'CUSTOM' ? customTone : customTone || null,
      behavior: { escalateOn },
    });
    if (!parsed.success) {
      setErrors(fieldErrorsFrom(parsed.error));
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      await api('/api/v1/bot', { method: 'PATCH', json: parsed.data });
      setSaved(values);
      toast.success('Agent behavior saved', { description: 'The next reply uses the new settings.' });
      router.refresh();
    } catch (err) {
      setErrors(fieldErrorsFrom(err));
      toast.error(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  const toggleTrigger = (trigger: EscalationTrigger, on: boolean) =>
    set('escalateOn', on ? [...values.escalateOn, trigger] : values.escalateOn.filter((t) => t !== trigger));

  return (
    <div className="space-y-6">
      <SettingsSection title="Identity" description="Who the assistant is and what your business does. Used in every conversation.">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Agent name" htmlFor="agentName" error={errors.agentName}>
            <Input id="agentName" value={values.agentName} maxLength={60} onChange={(e) => set('agentName', e.target.value)} />
          </Field>
          <Field label="Company name" htmlFor="companyName" error={errors.companyName}>
            <Input id="companyName" value={values.companyName} maxLength={120} onChange={(e) => set('companyName', e.target.value)} />
          </Field>
        </div>
        <Field
          label="Business description"
          htmlFor="businessDescription"
          error={errors.businessDescription}
          hint="A few sentences about what you offer and who your customers are. Detailed facts belong in the knowledge base."
        >
          <Textarea
            id="businessDescription"
            rows={4}
            maxLength={2000}
            value={values.businessDescription}
            onChange={(e) => set('businessDescription', e.target.value)}
            placeholder="We build AI chatbots for small and mid-sized businesses in Germany…"
          />
        </Field>
      </SettingsSection>

      <SettingsSection title="Voice" description="How the assistant sounds and how long its answers are.">
        <Field label="Tone of voice" error={errors.tone}>
          <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Tone of voice">
            {TONES.map((tone) => (
              <button
                key={tone}
                type="button"
                role="radio"
                aria-checked={values.tone === tone}
                onClick={() => set('tone', tone)}
                className={cn(
                  'rounded-lg border p-3 text-start transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  values.tone === tone && 'border-primary bg-primary/5 ring-1 ring-primary',
                )}
              >
                <span className="block text-sm font-medium">{TONE_LABELS[tone].label}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{TONE_LABELS[tone].example}</span>
              </button>
            ))}
          </div>
        </Field>
        {values.tone === 'CUSTOM' && (
          <Field label="Custom tone" htmlFor="customTone" error={errors.customTone} hint="For example: Calm, warm and a little playful. Use short sentences.">
            <Textarea id="customTone" rows={2} maxLength={500} value={values.customTone} onChange={(e) => set('customTone', e.target.value)} />
          </Field>
        )}

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Answer length">
            <div className="inline-flex rounded-lg border p-0.5" role="radiogroup" aria-label="Answer length">
              {ANSWER_LENGTHS.map((length) => (
                <button
                  key={length}
                  type="button"
                  role="radio"
                  aria-checked={values.answerLength === length}
                  onClick={() => set('answerLength', length)}
                  className={cn(
                    'rounded-md px-3.5 py-1.5 text-sm transition-colors',
                    values.answerLength === length ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {LENGTH_LABELS[length]}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Default language" hint="The assistant always answers in the customer's language; this is used when it can't tell.">
            <Select value={values.defaultLanguage} onValueChange={(v) => set('defaultLanguage', v)}>
              <SelectTrigger aria-label="Default language">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SUPPORTED_LANGUAGES.map((l) => (
                  <SelectItem key={l.code} value={l.code}>
                    {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label={`Creativity: ${creativityLabel(values.creativity)}`} hint="Keep it low for support: answers stay close to your knowledge base.">
            <Slider
              aria-label="Creativity"
              min={0}
              max={1}
              step={0.05}
              value={[values.creativity]}
              onValueChange={([v]) => set('creativity', Math.round((v ?? 0) * 100) / 100)}
              className="py-2"
            />
          </Field>
          <Field label="AI model" htmlFor="model" error={errors.model} hint="Any chat model your provider offers. Larger models cost more per message.">
            <Input id="model" list="model-options" value={values.model} onChange={(e) => set('model', e.target.value.trim())} className="font-mono text-[13px]" />
            <datalist id="model-options">
              {MODELS.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </Field>
        </div>
      </SettingsSection>

      <SettingsSection title="When the AI can't help" description="Fallback answer and when to bring in your team.">
        <Field
          label="Fallback response"
          htmlFor="fallbackResponse"
          error={errors.fallbackResponse}
          hint="Used when the answer isn't in your knowledge base. The assistant adapts it to the customer's language."
        >
          <Textarea id="fallbackResponse" rows={2} maxLength={500} value={values.fallbackResponse} onChange={(e) => set('fallbackResponse', e.target.value)} />
        </Field>

        <div className="space-y-2">
          <Label>Human escalation</Label>
          <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Human escalation">
            {ESCALATION_BEHAVIORS.map((behavior) => (
              <button
                key={behavior}
                type="button"
                role="radio"
                aria-checked={values.escalationBehavior === behavior}
                onClick={() => set('escalationBehavior', behavior)}
                className={cn(
                  'rounded-lg border p-3 text-start transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  values.escalationBehavior === behavior && 'border-primary bg-primary/5 ring-1 ring-primary',
                )}
              >
                <span className="block text-sm font-medium">{ESCALATION_OPTIONS[behavior].label}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{ESCALATION_OPTIONS[behavior].description}</span>
              </button>
            ))}
          </div>
        </div>

        <fieldset className={cn('space-y-2', values.escalationBehavior === 'DISABLED' && 'pointer-events-none opacity-50')} disabled={values.escalationBehavior === 'DISABLED'}>
          <legend className="text-sm font-medium">Escalate when</legend>
          <p className="text-[13px] text-muted-foreground">Detected automatically for every customer message, in any language.</p>
          <div className="grid gap-2 pt-1 sm:grid-cols-2">
            {ESCALATION_TRIGGERS.map((trigger) => (
              <label key={trigger} className="flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5 text-sm hover:bg-muted/40">
                <Checkbox checked={values.escalateOn.includes(trigger)} onCheckedChange={(v) => toggleTrigger(trigger, v === true)} />
                {ESCALATION_TRIGGER_LABELS[trigger]}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="flex items-start justify-between gap-4 rounded-lg border p-3.5">
          <div>
            <Label htmlFor="sourcesWhatsapp">Show sources on WhatsApp</Label>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              Append the names of the documents an answer is based on. Off by default: on WhatsApp it usually reads as clutter.
            </p>
          </div>
          <Switch id="sourcesWhatsapp" checked={values.showSourcesWhatsapp} onCheckedChange={(v) => set('showSourcesWhatsapp', v)} />
        </div>
      </SettingsSection>

      <SaveBar dirty={dirty} saving={saving} onSave={save} onDiscard={() => setValues(saved)} />
    </div>
  );
}
