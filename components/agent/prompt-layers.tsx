'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Eye, Loader2, Lock, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api-client';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PROMPT_CHANNELS, PROMPT_LAYERS } from '@/lib/validation';

type LayerType = (typeof PROMPT_LAYERS)[number];
type Channel = (typeof PROMPT_CHANNELS)[number];

export interface PromptLayerDto {
  id: string;
  layer: LayerType;
  channel: Channel | null;
  content: string;
  isActive: boolean;
  sortOrder: number;
  /** ISO timestamp; re-keys the editor after a save so it shows the stored text. */
  updatedAt: string;
}

const LAYER_INFO: Record<LayerType, { label: string; description: string }> = {
  GLOBAL_POLICY: { label: 'Global policy', description: 'Non-negotiable ground rules: honesty, privacy, never inventing facts. Applies to every channel.' },
  BUSINESS_IDENTITY: { label: 'Business identity & instructions', description: 'Who the assistant represents and how it should help. Your main custom instructions go here.' },
  PERSONALITY: { label: 'Personality', description: 'Extra style guidance on top of the tone you picked under Behavior.' },
  CHANNEL: { label: 'Channel instructions', description: 'Formatting and style for one channel.' },
  BUSINESS_RULES: { label: 'Business rules', description: 'Hard rules for your business, e.g. "Never quote prices for custom work."' },
};

const CHANNEL_LABEL: Record<Channel, string> = { WEBSITE: 'Website', WHATSAPP: 'WhatsApp' };

const ORDER: { layer: LayerType; channel: Channel | null }[] = [
  { layer: 'GLOBAL_POLICY', channel: null },
  { layer: 'BUSINESS_IDENTITY', channel: null },
  { layer: 'PERSONALITY', channel: null },
  { layer: 'CHANNEL', channel: 'WEBSITE' },
  { layer: 'CHANNEL', channel: 'WHATSAPP' },
  { layer: 'BUSINESS_RULES', channel: null },
];

const PLACEHOLDER: Record<LayerType, string> = {
  GLOBAL_POLICY: '',
  BUSINESS_IDENTITY:
    'You are the AI customer-service assistant for ACME GmbH. Be friendly and professional. Answer questions using the company knowledge base. If pricing information is unavailable, ask the customer to speak with sales.',
  PERSONALITY: 'Use the customer’s first name once you know it. Avoid exclamation marks.',
  CHANNEL: 'Keep answers under 3 short paragraphs.',
  BUSINESS_RULES: '- Never quote delivery dates.\n- Refund requests always go to a human.',
};

function LayerCard({ layer, locked, onChanged }: { layer: PromptLayerDto; locked: boolean; onChanged: () => void }) {
  const [content, setContent] = useState(layer.content);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dirty = content.trim() !== layer.content.trim();
  const info = LAYER_INFO[layer.layer];

  async function patch(data: Partial<Pick<PromptLayerDto, 'content' | 'isActive'>>, message: string) {
    setSaving(true);
    try {
      await api(`/api/v1/bot/prompts/${layer.id}`, { method: 'PATCH', json: data });
      toast.success(message);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    try {
      await api(`/api/v1/bot/prompts/${layer.id}`, { method: 'DELETE' });
      toast.success('Layer removed');
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not remove');
    }
  }

  return (
    <div className={cn('rounded-xl border bg-card p-4 shadow-sm shadow-black/[0.02] sm:p-5', !layer.isActive && 'bg-muted/30')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{info.label}</h3>
            {layer.channel && <Badge variant="secondary">{CHANNEL_LABEL[layer.channel]}</Badge>}
            {!layer.isActive && <Badge variant="outline">Off</Badge>}
            {locked && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Lock className="h-3 w-3" /> Owners only
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[13px] text-muted-foreground">{info.description}</p>
        </div>
        <div className="flex items-center gap-1">
          <Switch
            checked={layer.isActive}
            disabled={locked || saving}
            onCheckedChange={(v) => patch({ isActive: v }, v ? 'Layer turned on' : 'Layer turned off')}
            aria-label={`${info.label} active`}
          />
          {!locked && (
            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={() => setConfirmDelete(true)} aria-label="Remove layer">
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
      <Textarea
        className="mt-3 min-h-[120px] font-mono text-[13px] leading-relaxed"
        value={content}
        readOnly={locked}
        maxLength={8000}
        onChange={(e) => setContent(e.target.value)}
        aria-label={`${info.label} content`}
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">{formatNumber(content.length)} / 8,000</span>
        {dirty && !locked && (
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setContent(layer.content)} disabled={saving}>
              Discard
            </Button>
            <Button size="sm" onClick={() => patch({ content }, 'Prompt layer saved')} disabled={saving || !content.trim()}>
              {saving && <Loader2 className="me-2 h-3.5 w-3.5 animate-spin" />}
              Save
            </Button>
          </div>
        )}
      </div>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this layer?</AlertDialogTitle>
            <AlertDialogDescription>The assistant stops using these instructions immediately. You can turn a layer off instead to keep it.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={remove}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function NewLayerCard({ layer, channel, onDone }: { layer: LayerType; channel: Channel | null; onDone: (created: boolean) => void }) {
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  async function create() {
    setSaving(true);
    try {
      await api('/api/v1/bot/prompts', { method: 'POST', json: { layer, channel, content } });
      toast.success('Prompt layer added');
      onDone(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add the layer');
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="rounded-xl border border-dashed border-primary/50 bg-primary/[0.03] p-4 sm:p-5">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">New: {LAYER_INFO[layer].label}</h3>
        {channel && <Badge variant="secondary">{CHANNEL_LABEL[channel]}</Badge>}
      </div>
      <Textarea
        autoFocus
        className="mt-3 min-h-[120px] font-mono text-[13px]"
        placeholder={PLACEHOLDER[layer]}
        value={content}
        maxLength={8000}
        onChange={(e) => setContent(e.target.value)}
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => onDone(false)} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" onClick={create} disabled={saving || !content.trim()}>
          {saving && <Loader2 className="me-2 h-3.5 w-3.5 animate-spin" />}
          Add layer
        </Button>
      </div>
    </div>
  );
}

function PromptPreviewDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [channel, setChannel] = useState<Channel>('WEBSITE');
  const [data, setData] = useState<{ prompt: string; estimatedTokens: number; tools: string[] } | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (next: Channel) => {
    setChannel(next);
    setLoading(true);
    try {
      const res = await api<{ data: { prompt: string; estimatedTokens: number; tools: string[] } }>(`/api/v1/bot/prompt-preview?channel=${next}`);
      setData(res.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load the preview');
    } finally {
      setLoading(false);
    }
  }, []);

  // Load whenever the dialog opens (onOpenChange only fires for user-initiated changes).
  useEffect(() => {
    if (open) void load('WEBSITE');
  }, [open, load]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Full system prompt</DialogTitle>
          <DialogDescription>
            Exactly what the assistant receives, with a sample customer. Knowledge snippets and the customer’s profile are added per message.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border p-0.5">
            {PROMPT_CHANNELS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => load(c)}
                className={cn('rounded-md px-3 py-1 text-sm', channel === c ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
              >
                {CHANNEL_LABEL[c]}
              </button>
            ))}
          </div>
          {data && (
            <span className="text-xs text-muted-foreground">
              ≈ {formatNumber(data.estimatedTokens)} tokens · {data.tools.length} tools enabled
            </span>
          )}
        </div>
        <div className="relative max-h-[60vh] overflow-auto rounded-lg border bg-muted/40 p-4">
          {loading && !data ? (
            <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed">{data?.prompt}</pre>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function PromptLayers({ layers, canEditPolicy }: { layers: PromptLayerDto[]; canEditPolicy: boolean }) {
  const router = useRouter();
  const [adding, setAdding] = useState<{ layer: LayerType; channel: Channel | null } | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const groups = useMemo(
    () =>
      ORDER.map((slot) => ({
        ...slot,
        items: layers.filter((l) => l.layer === slot.layer && l.channel === slot.channel).sort((a, b) => a.sortOrder - b.sortOrder),
      })),
    [layers],
  );
  const addOptions = ORDER.filter((o) => o.layer !== 'GLOBAL_POLICY' || canEditPolicy);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4 sm:p-5">
        <div className="max-w-2xl">
          <h2 className="text-base font-semibold tracking-tight">Prompt layers</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The assistant’s instructions are composed from these layers, top to bottom, then your Behavior settings, the customer’s profile, the
            conversation summary and the knowledge relevant to each message.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setPreviewOpen(true)}>
            <Eye className="me-2 h-4 w-4" /> Preview
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button>
                <Plus className="me-2 h-4 w-4" /> Add layer
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {addOptions.map((o) => (
                <DropdownMenuItem key={`${o.layer}-${o.channel}`} onSelect={() => setAdding(o)}>
                  {LAYER_INFO[o.layer].label}
                  {o.channel ? ` · ${CHANNEL_LABEL[o.channel]}` : ''}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {groups.map((group) => (
        <div key={`${group.layer}-${group.channel}`} className="space-y-3">
          {group.items.map((layer) => (
            <LayerCard key={`${layer.id}-${layer.updatedAt}`} layer={layer} locked={layer.layer === 'GLOBAL_POLICY' && !canEditPolicy} onChanged={() => router.refresh()} />
          ))}
          {adding?.layer === group.layer && adding.channel === group.channel && (
            <NewLayerCard
              layer={group.layer}
              channel={group.channel}
              onDone={(created) => {
                setAdding(null);
                if (created) router.refresh();
              }}
            />
          )}
        </div>
      ))}

      <PromptPreviewDialog open={previewOpen} onOpenChange={setPreviewOpen} />
    </div>
  );
}
