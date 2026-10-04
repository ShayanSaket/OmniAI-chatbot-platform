'use client';

import { useMemo, useState } from 'react';
import { Loader2, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ApiError, api } from '@/lib/api-client';
import { MAX_TAGS_PER_CUSTOMER, type CustomerProfile, type TagItem } from '@/lib/customers';

interface Props {
  customer: CustomerProfile;
  allTags: TagItem[];
  canManage: boolean;
  onSaved: (customer: CustomerProfile) => void;
}

export function TagEditor({ customer, allTags, canManage, onSaved }: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const current = customer.tags.map((t) => t.name);

  const suggestions = useMemo(() => {
    const q = text.trim().toLowerCase();
    return allTags.filter((t) => !current.some((c) => c.toLowerCase() === t.name.toLowerCase()) && (!q || t.name.toLowerCase().includes(q))).slice(0, 8);
  }, [allTags, current, text]);

  async function save(names: string[]) {
    setSaving(true);
    try {
      const res = await api<{ data: CustomerProfile }>(`/api/v1/customers/${customer.id}/tags`, { method: 'PUT', json: { tags: names } });
      onSaved(res.data);
      setText('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update tags.');
    } finally {
      setSaving(false);
    }
  }

  const exact = text.trim() && !allTags.some((t) => t.name.toLowerCase() === text.trim().toLowerCase());

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {customer.tags.length === 0 && !canManage && <span className="text-sm text-muted-foreground">No tags</span>}
      {customer.tags.map((t) => (
        <span key={t.id} className="inline-flex items-center gap-1 rounded-full py-0.5 pe-1 ps-2.5 text-xs font-medium" style={{ backgroundColor: `${t.color}22`, color: t.color }}>
          {t.name}
          {canManage && (
            <button type="button" aria-label={`Remove tag ${t.name}`} onClick={() => void save(current.filter((n) => n !== t.name))} disabled={saving} className="rounded-full p-0.5 hover:bg-black/10">
              <X className="h-3 w-3" />
            </button>
          )}
        </span>
      ))}
      {canManage && current.length < MAX_TAGS_PER_CUSTOMER && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button type="button" className="inline-flex items-center gap-1 rounded-full border border-dashed px-2.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />} Add tag
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-60 p-2">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const name = text.trim();
                if (name) void save([...current, suggestions.find((s) => s.name.toLowerCase() === name.toLowerCase())?.name ?? name]);
              }}
            >
              <input
                autoFocus
                value={text}
                maxLength={40}
                onChange={(e) => setText(e.target.value)}
                placeholder="Tag name"
                aria-label="Tag name"
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring/40"
              />
            </form>
            <ul className="mt-2 max-h-48 overflow-y-auto">
              {suggestions.map((t) => (
                <li key={t.id}>
                  <button type="button" onClick={() => void save([...current, t.name])} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: t.color }} />
                    {t.name}
                  </button>
                </li>
              ))}
              {exact && (
                <li>
                  <button type="button" onClick={() => void save([...current, text.trim()])} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted">
                    <Plus className="h-3.5 w-3.5" /> Create “{text.trim()}”
                  </button>
                </li>
              )}
            </ul>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
