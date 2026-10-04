'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, FileText, Languages, Loader2, Paperclip, RotateCcw, Send, Sparkles, Undo2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ApiError, api } from '@/lib/api-client';
import { MAX_AGENT_ATTACHMENTS, MAX_AGENT_MESSAGE_LENGTH, type InboxConversationDetail, type InboxMessage, type SuggestionAction } from '@/lib/inbox';
import { SUPPORTED_LANGUAGES } from '@/lib/validation';
import { cn } from '@/lib/utils';
import { formatBytes } from './shared';
import { TemplateDialog } from './template-dialog';

interface Receipt {
  key: string;
  fileName: string;
  mimeType: string;
  size: number;
  sig: string;
  url: string;
}

interface PendingFile {
  id: string;
  fileName: string;
  size: number;
  status: 'uploading' | 'done' | 'error';
  receipt?: Receipt;
}

/** Unsent drafts survive switching between conversations (per browser tab). */
const drafts = new Map<string, string>();

const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().replace(/-/g, '') : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);

const TYPING_EVERY_MS = 3000;

interface Props {
  conversation: InboxConversationDetail;
  canReply: boolean;
  /** Optimistic and final versions of a sent message (matched by clientMessageId). */
  onMessage: (message: InboxMessage) => void;
  onReopen: () => void;
  busy: boolean;
  meName: string | null;
}

export function Composer({ conversation, canReply, onMessage, onReopen, busy, meName }: Props) {
  const id = conversation.id;
  const [text, setText] = useState(() => drafts.get(id) ?? '');
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [sending, setSending] = useState(false);
  const [suggesting, setSuggesting] = useState<SuggestionAction | null>(null);
  const [undo, setUndo] = useState<string | null>(null);
  const [templateOpen, setTemplateOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const lastTyping = useRef(0);

  // The parent remounts the composer per conversation (key), so `id` is stable here.
  useEffect(() => {
    if (text) drafts.set(id, text);
    else drafts.delete(id);
  }, [id, text]);

  // Auto-grow up to ~8 lines.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const customerLanguage = conversation.customer.language ?? 'en';
  const closed = conversation.status === 'CLOSED';
  const windowClosed = conversation.window !== null && !conversation.window.open;

  const notifyTyping = useCallback(() => {
    if (conversation.channel !== 'WEBSITE') return;
    const now = Date.now();
    if (now - lastTyping.current < TYPING_EVERY_MS) return;
    lastTyping.current = now;
    void api(`/api/v1/conversations/${id}/typing`, { method: 'POST' }).catch(() => undefined);
  }, [conversation.channel, id]);

  async function upload(list: FileList | null) {
    if (!list?.length) return;
    const room = MAX_AGENT_ATTACHMENTS - files.length;
    const picked = Array.from(list).slice(0, Math.max(0, room));
    if (list.length > room) toast.error(`You can attach up to ${MAX_AGENT_ATTACHMENTS} files.`);
    for (const file of picked) {
      const pid = newId();
      setFiles((f) => [...f, { id: pid, fileName: file.name, size: file.size, status: 'uploading' }]);
      const form = new FormData();
      form.append('file', file);
      try {
        const res = await api<{ data: Receipt }>(`/api/v1/conversations/${id}/uploads`, { method: 'POST', body: form });
        setFiles((f) => f.map((p) => (p.id === pid ? { ...p, status: 'done', receipt: res.data, fileName: res.data.fileName } : p)));
      } catch (err) {
        setFiles((f) => f.filter((p) => p.id !== pid));
        toast.error(err instanceof ApiError ? err.message : 'Upload failed.');
      }
    }
  }

  async function send() {
    const content = text.trim();
    const ready = files.filter((f) => f.status === 'done' && f.receipt);
    if ((!content && !ready.length) || sending) return;
    if (files.some((f) => f.status === 'uploading')) {
      toast.message('Wait for the upload to finish.');
      return;
    }
    const clientMessageId = newId();
    const optimistic: InboxMessage = {
      id: `tmp-${clientMessageId}`,
      senderType: 'AGENT',
      messageType: 'TEXT',
      content,
      createdAt: new Date().toISOString(),
      status: 'PENDING',
      errorCode: null,
      error: null,
      authorName: meName,
      attachments: ready.map((f) => ({ fileName: f.receipt!.fileName, mimeType: f.receipt!.mimeType, size: f.receipt!.size, url: f.receipt!.url })),
      sources: [],
      intent: null,
      label: null,
      clientMessageId,
    };
    onMessage(optimistic);
    setSending(true);
    setText('');
    setFiles([]);
    setUndo(null);
    try {
      const res = await api<{ data: { message: InboxMessage; delivered: boolean } }>(`/api/v1/conversations/${id}/messages`, {
        method: 'POST',
        json: { content, clientMessageId, attachments: ready.map(({ receipt }) => ({ key: receipt!.key, fileName: receipt!.fileName, mimeType: receipt!.mimeType, size: receipt!.size, sig: receipt!.sig })) },
      });
      onMessage(res.data.message);
      if (!res.data.delivered) toast.error(res.data.message.error ?? 'The message was saved but could not be delivered.');
    } catch (err) {
      // Put the text back so nothing typed is lost.
      onMessage({ ...optimistic, status: 'FAILED', error: err instanceof ApiError ? err.message : 'Not sent.' });
      setText(content);
      toast.error(err instanceof ApiError ? err.message : 'The message could not be sent.');
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  }

  async function suggest(action: SuggestionAction, language?: string) {
    if (suggesting) return;
    setSuggesting(action);
    try {
      const res = await api<{ data: { text: string } }>(`/api/v1/conversations/${id}/suggestions`, { method: 'POST', json: { action, draft: text, ...(language ? { language } : {}) } });
      setUndo(text);
      setText(res.data.text.slice(0, MAX_AGENT_MESSAGE_LENGTH));
      textareaRef.current?.focus();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'No suggestion right now.');
    } finally {
      setSuggesting(null);
    }
  }

  if (!canReply) {
    return <div className="border-t px-4 py-3 text-center text-sm text-muted-foreground">You can read this conversation but not reply.</div>;
  }

  if (closed) {
    return (
      <div className="flex flex-wrap items-center justify-center gap-3 border-t px-4 py-3 text-sm text-muted-foreground">
        This conversation is closed.
        <Button size="sm" variant="outline" onClick={onReopen} disabled={busy}>
          <RotateCcw className="me-1.5 h-3.5 w-3.5" /> Reopen
        </Button>
      </div>
    );
  }

  if (windowClosed) {
    return (
      <div className="border-t px-4 py-3">
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2.5 text-sm">
          <p className="min-w-0 flex-1 text-amber-900 dark:text-amber-200">
            The 24-hour WhatsApp window has closed. Only approved templates can be sent until the customer writes again.
          </p>
          <Button size="sm" onClick={() => setTemplateOpen(true)}>
            <FileText className="me-1.5 h-3.5 w-3.5" /> Send template
          </Button>
        </div>
        <TemplateDialog open={templateOpen} onOpenChange={setTemplateOpen} conversationId={id} onSent={onMessage} />
      </div>
    );
  }

  const aiMode = conversation.status === 'AI_ACTIVE' || conversation.status === 'WAITING_FOR_AGENT';
  const hasDraft = text.trim().length > 0;
  const languages = SUPPORTED_LANGUAGES.some((l) => l.code === customerLanguage) ? SUPPORTED_LANGUAGES : [{ code: customerLanguage, label: customerLanguage.toUpperCase() }, ...SUPPORTED_LANGUAGES];

  return (
    <div className="border-t bg-background px-3 pb-3 pt-2 sm:px-4">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <Button type="button" size="sm" variant="secondary" className="h-7 gap-1.5 px-2.5 text-xs" onClick={() => suggest('generate')} disabled={Boolean(suggesting)}>
          {suggesting === 'generate' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          Generate reply
        </Button>
        {(['shorten', 'friendlier', 'professional'] as const).map((a) => (
          <Button
            key={a}
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            onClick={() => suggest(a)}
            disabled={!hasDraft || Boolean(suggesting)}
            title={hasDraft ? undefined : 'Write or generate a draft first'}
          >
            {suggesting === a && <Loader2 className="me-1 h-3 w-3 animate-spin" />}
            {a === 'shorten' ? 'Shorten' : a === 'friendlier' ? 'Friendlier' : 'Professional'}
          </Button>
        ))}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs" disabled={!hasDraft || Boolean(suggesting)}>
              {suggesting === 'translate' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Languages className="h-3.5 w-3.5" />}
              Translate <ChevronDown className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel className="text-xs">Translate draft to</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {languages.map((l) => (
              <DropdownMenuItem key={l.code} onSelect={() => suggest('translate', l.code)}>
                {l.label}
                {l.code === customerLanguage && <span className="ms-auto ps-3 text-xs text-muted-foreground">customer</span>}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {undo !== null && (
          <Button type="button" size="sm" variant="ghost" className="ms-auto h-7 gap-1 px-2 text-xs text-muted-foreground" onClick={() => (setText(undo), setUndo(null))}>
            <Undo2 className="h-3.5 w-3.5" /> Undo
          </Button>
        )}
      </div>

      {files.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1.5" aria-label="Attachments">
          {files.map((f) => (
            <li key={f.id} className="flex max-w-[220px] items-center gap-1.5 rounded-md border bg-muted/50 px-2 py-1 text-xs">
              {f.status === 'uploading' ? <Loader2 className="h-3 w-3 shrink-0 animate-spin" /> : <Paperclip className="h-3 w-3 shrink-0" />}
              <span className="truncate">{f.fileName}</span>
              <span className="shrink-0 text-muted-foreground">{formatBytes(f.size)}</span>
              <button type="button" aria-label={`Remove ${f.fileName}`} onClick={() => setFiles((list) => list.filter((p) => p.id !== f.id))} className="rounded p-0.5 hover:bg-muted">
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className={cn('flex items-end gap-2 rounded-lg border bg-background px-2 py-1.5 focus-within:ring-2 focus-within:ring-ring/40', suggesting && 'opacity-70')}>
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => (void upload(e.target.files), (e.target.value = ''))} accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,.docx,text/plain" />
        <Button type="button" size="icon" variant="ghost" className="h-8 w-8 shrink-0" aria-label="Attach files" onClick={() => fileRef.current?.click()} disabled={files.length >= MAX_AGENT_ATTACHMENTS}>
          <Paperclip className="h-4 w-4" />
        </Button>
        <textarea
          ref={textareaRef}
          value={text}
          rows={1}
          dir="auto"
          maxLength={MAX_AGENT_MESSAGE_LENGTH}
          aria-label="Reply"
          placeholder={aiMode ? 'Write a reply — sending takes over from the AI' : `Reply on ${conversation.channel === 'WHATSAPP' ? 'WhatsApp' : 'the website chat'}…`}
          onChange={(e) => {
            setText(e.target.value);
            if (e.target.value) notifyTyping();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          disabled={Boolean(suggesting)}
          className="max-h-[200px] min-h-[36px] flex-1 resize-none bg-transparent py-1.5 text-sm outline-none placeholder:text-muted-foreground"
        />
        <Button type="button" size="icon" className="h-8 w-8 shrink-0" aria-label="Send" onClick={() => void send()} disabled={sending || (!text.trim() && !files.some((f) => f.status === 'done'))}>
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </div>
      <p className="mt-1.5 px-1 text-[11px] text-muted-foreground">
        Enter to send · Shift+Enter for a new line · AI suggestions are never sent without you
        {conversation.channel === 'WHATSAPP' && (
          <>
            {' · '}
            <button type="button" className="underline-offset-2 hover:underline" onClick={() => setTemplateOpen(true)}>
              Send template
            </button>
          </>
        )}
      </p>
      {conversation.channel === 'WHATSAPP' && <TemplateDialog open={templateOpen} onOpenChange={setTemplateOpen} conversationId={id} onSent={onMessage} />}
    </div>
  );
}
