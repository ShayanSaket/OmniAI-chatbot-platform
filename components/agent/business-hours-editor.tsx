'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api-client';
import { businessHoursUpdateSchema } from '@/lib/validation';
import { SaveBar, SettingsSection } from './form-parts';

export interface HoursRange {
  weekday: number;
  opensAt: string;
  closesAt: string;
}

// Monday first; weekday numbers follow JavaScript (0 = Sunday).
const DAYS = [
  { weekday: 1, label: 'Monday' },
  { weekday: 2, label: 'Tuesday' },
  { weekday: 3, label: 'Wednesday' },
  { weekday: 4, label: 'Thursday' },
  { weekday: 5, label: 'Friday' },
  { weekday: 6, label: 'Saturday' },
  { weekday: 0, label: 'Sunday' },
];
const MAX_RANGES = 3;

const normalize = (hours: HoursRange[]) =>
  [...hours].sort((a, b) => a.weekday - b.weekday || a.opensAt.localeCompare(b.opensAt) || a.closesAt.localeCompare(b.closesAt));

function rangeNote(r: HoursRange) {
  if (r.opensAt === r.closesAt) return 'Open 24 hours';
  if (r.closesAt < r.opensAt) return 'Until the next day';
  return null;
}

export function BusinessHoursEditor({ initial, timeZone, canEditTimeZone }: { initial: HoursRange[]; timeZone: string; canEditTimeZone: boolean }) {
  const router = useRouter();
  const [hours, setHours] = useState(() => normalize(initial));
  const [saved, setSaved] = useState(() => normalize(initial));
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(normalize(hours)) !== JSON.stringify(saved);

  const rangesFor = (weekday: number) => hours.map((r, index) => ({ r, index })).filter(({ r }) => r.weekday === weekday);
  const update = (index: number, patch: Partial<HoursRange>) => setHours((h) => h.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const remove = (index: number) => setHours((h) => h.filter((_, i) => i !== index));
  const add = (weekday: number) => {
    const existing = rangesFor(weekday);
    const last = existing.at(-1)?.r;
    setHours((h) => [...h, last ? { weekday, opensAt: last.closesAt < '20:00' ? '19:00' : '09:00', closesAt: '21:00' } : { weekday, opensAt: '09:00', closesAt: '18:00' }]);
  };
  const setOpen = (weekday: number, open: boolean) =>
    setHours((h) => (open ? [...h, { weekday, opensAt: '09:00', closesAt: '18:00' }] : h.filter((r) => r.weekday !== weekday)));

  async function save() {
    const parsed = businessHoursUpdateSchema.safeParse({ hours });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Check the times');
      return;
    }
    setSaving(true);
    try {
      await api('/api/v1/business-hours', { method: 'PUT', json: parsed.data });
      setSaved(normalize(hours));
      toast.success('Business hours saved', { description: 'The widget shows the new team status right away.' });
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <SettingsSection
        title="Business hours"
        description={
          <>
            When your team answers chats. Outside these hours the AI keeps helping and tells customers when the team is back. Times are in{' '}
            <span className="font-medium text-foreground">{timeZone}</span>
            {canEditTimeZone && (
              <>
                {' '}
                (
                <Link href="/settings" className="underline underline-offset-2 hover:text-foreground">
                  change
                </Link>
                )
              </>
            )}
            .
          </>
        }
      >
        <div className="divide-y rounded-lg border">
          {DAYS.map(({ weekday, label }) => {
            const ranges = rangesFor(weekday);
            const open = ranges.length > 0;
            return (
              <div key={weekday} className="flex flex-col gap-3 p-3.5 sm:flex-row sm:items-start">
                <div className="flex w-40 shrink-0 items-center gap-3 pt-1.5">
                  <Switch id={`day-${weekday}`} checked={open} onCheckedChange={(v) => setOpen(weekday, v)} aria-label={`${label} open`} />
                  <label htmlFor={`day-${weekday}`} className="text-sm font-medium">
                    {label}
                  </label>
                </div>
                {open ? (
                  <div className="flex-1 space-y-2">
                    {ranges.map(({ r, index }) => (
                      <div key={index} className="flex flex-wrap items-center gap-2">
                        <Input
                          type="time"
                          aria-label={`${label} opens at`}
                          value={r.opensAt}
                          onChange={(e) => update(index, { opensAt: e.target.value })}
                          className="h-9 w-[7.5rem]"
                        />
                        <span className="text-sm text-muted-foreground">to</span>
                        <Input
                          type="time"
                          aria-label={`${label} closes at`}
                          value={r.closesAt}
                          onChange={(e) => update(index, { closesAt: e.target.value })}
                          className="h-9 w-[7.5rem]"
                        />
                        {rangeNote(r) && <span className="text-xs text-muted-foreground">{rangeNote(r)}</span>}
                        {ranges.length > 1 && (
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => remove(index)} aria-label="Remove time range">
                            <X className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    ))}
                    {ranges.length < MAX_RANGES && (
                      <button type="button" onClick={() => add(weekday)} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                        <Plus className="h-3.5 w-3.5" /> Add hours
                      </button>
                    )}
                  </div>
                ) : (
                  <p className="pt-2 text-sm text-muted-foreground">Closed</p>
                )}
              </div>
            );
          })}
        </div>
        <p className="text-[13px] text-muted-foreground">Same opening and closing time means open 24 hours. A closing time before the opening time runs past midnight.</p>
      </SettingsSection>
      <SaveBar dirty={dirty} saving={saving} onSave={save} onDiscard={() => setHours(saved)} />
    </div>
  );
}
