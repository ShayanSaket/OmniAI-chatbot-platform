'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, api } from '@/lib/api-client';
import type { InboxMessage } from '@/lib/inbox';
import { cn } from '@/lib/utils';

interface Template {
  id: string;
  name: string;
  language: string;
  category: string;
  body: string;
  header: string | null;
  variables: number;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  onSent: (message: InboxMessage) => void;
}

/** Sends an approved WhatsApp template (the only option outside the 24-hour window). */
export function TemplateDialog({ open, onOpenChange, conversationId, onSent }: Props) {
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [params, setParams] = useState<string[]>([]);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTemplates(null);
    api<{ data: { templates: Template[] } }>(`/api/v1/conversations/${conversationId}/whatsapp-template`)
      .then((res) => setTemplates(res.data.templates))
      .catch(() => setTemplates([]));
  }, [open, conversationId]);

  const template = templates?.find((t) => t.id === selected) ?? null;
  useEffect(() => setParams(Array.from({ length: template?.variables ?? 0 }, () => '')), [template?.id, template?.variables]);

  const preview = useMemo(() => {
    if (!template) return '';
    return template.body.replace(/\{\{(\d+)\}\}/g, (_, n: string) => params[Number(n) - 1]?.trim() || `{{${n}}}`);
  }, [template, params]);

  async function send() {
    if (!template) return;
    setSending(true);
    try {
      const res = await api<{ data: { delivered: boolean; error: string | null; message: { id: string } } }>(`/api/v1/conversations/${conversationId}/whatsapp-template`, {
        method: 'POST',
        json: { templateId: template.id, params: params.map((p) => p.trim()) },
      });
      if (res.data.delivered) toast.success('Template sent.');
      else toast.error(res.data.error ?? 'The template could not be delivered.');
      // The inbox refreshes the thread from the live feed; nudge it with a minimal message.
      onSent({
        id: res.data.message.id,
        senderType: 'AGENT',
        messageType: 'TEMPLATE',
        content: [template.header, preview].filter(Boolean).join('\n\n'),
        createdAt: new Date().toISOString(),
        status: res.data.delivered ? 'SENT' : 'FAILED',
        errorCode: null,
        error: res.data.error,
        authorName: null,
        attachments: [],
        sources: [],
        intent: null,
        label: `Template: ${template.name}`,
        clientMessageId: null,
      });
      onOpenChange(false);
      setSelected(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'The template could not be sent.');
    } finally {
      setSending(false);
    }
  }

  const ready = template && params.every((p) => p.trim());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Send a WhatsApp template</DialogTitle>
          <DialogDescription>Templates approved by Meta can be sent at any time, also after the 24-hour window.</DialogDescription>
        </DialogHeader>
        {templates === null ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : templates.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No approved templates. An admin can sync templates on the Channels page.</p>
        ) : (
          <div className="space-y-4">
            <ul className="max-h-48 space-y-1 overflow-y-auto" role="listbox" aria-label="Templates">
              {templates.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={t.id === selected}
                    onClick={() => setSelected(t.id)}
                    className={cn('w-full rounded-md border px-3 py-2 text-start text-sm', t.id === selected ? 'border-primary bg-primary/5' : 'hover:bg-muted')}
                  >
                    <span className="font-medium">{t.name}</span>
                    <span className="ms-2 text-xs text-muted-foreground">
                      {t.language} · {t.category.toLowerCase()}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {template && (
              <>
                {params.map((value, i) => (
                  <div key={i} className="space-y-1.5">
                    <Label htmlFor={`tpl-var-${i}`}>Variable {`{{${i + 1}}}`}</Label>
                    <Input id={`tpl-var-${i}`} value={value} maxLength={1000} onChange={(e) => setParams((p) => p.map((v, j) => (j === i ? e.target.value : v)))} />
                  </div>
                ))}
                <div className="rounded-md bg-muted/60 p-3 text-sm">
                  {template.header && <p className="mb-1 font-semibold">{template.header}</p>}
                  <p className="whitespace-pre-line" dir="auto">
                    {preview}
                  </p>
                </div>
              </>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void send()} disabled={!ready || sending}>
            {sending && <Loader2 className="me-1.5 h-4 w-4 animate-spin" />}
            Send template
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
