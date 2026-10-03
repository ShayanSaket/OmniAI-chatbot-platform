'use client';

import { useRef, useState } from 'react';
import { FileUp, Globe, HelpCircle, Loader2, Plus, Trash2, Type, UploadCloud } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Field, fieldErrorsFrom } from '@/components/agent/form-parts';
import { api, ApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { KNOWLEDGE_MAX_FILE_BYTES, knowledgeFaqSchema, knowledgeTextSchema, knowledgeWebsiteSchema } from '@/lib/validation';

export type SourceKind = 'file' | 'website' | 'faq' | 'text';

const ACCEPT = '.pdf,.docx,.txt,.md,.markdown';

function UploadForm({ onDone }: { onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [queue, setQueue] = useState<{ name: string; state: 'waiting' | 'uploading' | 'done' | 'error'; error?: string }[]>([]);
  const busy = queue.some((q) => q.state === 'uploading' || q.state === 'waiting');

  async function upload(files: File[]) {
    if (!files.length) return;
    setQueue(files.map((f) => ({ name: f.name, state: 'waiting' })));
    let ok = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i]!;
      setQueue((q) => q.map((item, j) => (j === i ? { ...item, state: 'uploading' } : item)));
      try {
        if (f.size > KNOWLEDGE_MAX_FILE_BYTES) throw new Error('Larger than 20 MB');
        const form = new FormData();
        form.set('file', f);
        await api('/api/v1/knowledge', { method: 'POST', body: form });
        ok++;
        setQueue((q) => q.map((item, j) => (j === i ? { ...item, state: 'done' } : item)));
      } catch (err) {
        setQueue((q) => q.map((item, j) => (j === i ? { ...item, state: 'error', error: err instanceof Error ? err.message : 'Upload failed' } : item)));
      }
    }
    if (ok) {
      toast.success(`${ok} file${ok === 1 ? '' : 's'} added`, { description: 'Processing runs in the background — usually a few seconds.' });
      onDone();
    }
  }

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void upload(Array.from(e.dataTransfer.files));
        }}
        disabled={busy}
        className={cn(
          'flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors',
          dragging ? 'border-primary bg-primary/5' : 'hover:border-primary/50 hover:bg-muted/40',
        )}
      >
        <UploadCloud className="h-8 w-8 text-muted-foreground" />
        <span className="text-sm font-medium">Drop files here or click to choose</span>
        <span className="text-xs text-muted-foreground">PDF, Word (.docx), text or Markdown · up to 20 MB each</span>
      </button>
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          void upload(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
      {queue.length > 0 && (
        <ul className="space-y-1.5 text-sm">
          {queue.map((q, i) => (
            <li key={i} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
              <span className="truncate">{q.name}</span>
              <span className={cn('shrink-0 text-xs', q.state === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
                {q.state === 'uploading' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : q.state === 'done' ? 'Added' : q.state === 'error' ? q.error : 'Waiting'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function WebsiteForm({ onDone }: { onDone: () => void }) {
  const [url, setUrl] = useState('');
  const [crawl, setCrawl] = useState(false);
  const [maxPages, setMaxPages] = useState(10);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  async function submit() {
    const parsed = knowledgeWebsiteSchema.safeParse({ url: /^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`, crawl, maxPages });
    if (!parsed.success) return setErrors(fieldErrorsFrom(parsed.error));
    setErrors({});
    setSaving(true);
    try {
      await api('/api/v1/knowledge/website', { method: 'POST', json: parsed.data });
      toast.success(crawl ? 'Website import started' : 'Page added', { description: crawl ? `Linked pages on the same site are added as they are fetched (up to ${maxPages}).` : undefined });
      onDone();
    } catch (err) {
      setErrors(fieldErrorsFrom(err));
      toast.error(err instanceof Error ? err.message : 'Could not add the website');
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="space-y-4">
      <Field label="Page URL" htmlFor="kb-url" error={errors.url} hint="The main content is extracted; navigation, footers and scripts are ignored. robots.txt is respected.">
        <Input id="kb-url" placeholder="https://www.example.com/help" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </Field>
      <div className="flex items-start justify-between gap-4 rounded-lg border p-3.5">
        <div>
          <label htmlFor="kb-crawl" className="text-sm font-medium">
            Also add linked pages
          </label>
          <p className="mt-0.5 text-[13px] text-muted-foreground">Pages on the same website that this page links to (one level deep).</p>
          {crawl && (
            <div className="mt-2 flex items-center gap-2 text-sm">
              Up to
              <Input type="number" min={1} max={25} value={maxPages} onChange={(e) => setMaxPages(Math.min(25, Math.max(1, Number(e.target.value) || 1)))} className="h-8 w-20" />
              pages
            </div>
          )}
        </div>
        <Switch id="kb-crawl" checked={crawl} onCheckedChange={setCrawl} />
      </div>
      <div className="flex justify-end">
        <Button onClick={submit} disabled={saving || !url.trim()}>
          {saving && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
          Add website
        </Button>
      </div>
    </div>
  );
}

export interface FaqValues {
  title: string;
  entries: { question: string; answer: string }[];
}

export function FaqForm({ initial, documentId, onDone }: { initial?: FaqValues; documentId?: string; onDone: () => void }) {
  const [values, setValues] = useState<FaqValues>(initial ?? { title: '', entries: [{ question: '', answer: '' }] });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const setEntry = (i: number, patch: Partial<FaqValues['entries'][number]>) =>
    setValues((v) => ({ ...v, entries: v.entries.map((e, j) => (j === i ? { ...e, ...patch } : e)) }));

  async function submit() {
    const parsed = knowledgeFaqSchema.safeParse({ ...values, entries: values.entries.filter((e) => e.question.trim() || e.answer.trim()) });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Check the entries');
    setError(null);
    setSaving(true);
    try {
      await api(documentId ? `/api/v1/knowledge/${documentId}` : '/api/v1/knowledge/faq', { method: documentId ? 'PATCH' : 'POST', json: parsed.data });
      toast.success(documentId ? 'FAQ updated' : 'FAQ added');
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <Field label="Title" htmlFor="faq-title">
        <Input id="faq-title" placeholder="Shipping FAQ" value={values.title} onChange={(e) => setValues((v) => ({ ...v, title: e.target.value }))} />
      </Field>
      <div className="max-h-[45vh] space-y-3 overflow-y-auto pe-1">
        {values.entries.map((entry, i) => (
          <div key={i} className="space-y-2 rounded-lg border p-3">
            <div className="flex items-center gap-2">
              <Input placeholder="Question" aria-label={`Question ${i + 1}`} value={entry.question} onChange={(e) => setEntry(i, { question: e.target.value })} />
              {values.entries.length > 1 && (
                <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" aria-label="Remove question" onClick={() => setValues((v) => ({ ...v, entries: v.entries.filter((_, j) => j !== i) }))}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
            <Textarea rows={2} placeholder="Answer" aria-label={`Answer ${i + 1}`} value={entry.answer} onChange={(e) => setEntry(i, { answer: e.target.value })} />
          </div>
        ))}
      </div>
      {error && <p className="text-[13px] font-medium text-destructive">{error}</p>}
      <div className="flex items-center justify-between">
        <Button variant="outline" size="sm" onClick={() => setValues((v) => ({ ...v, entries: [...v.entries, { question: '', answer: '' }] }))}>
          <Plus className="me-1.5 h-4 w-4" /> Add question
        </Button>
        <Button onClick={submit} disabled={saving}>
          {saving && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
          {documentId ? 'Save FAQ' : 'Add FAQ'}
        </Button>
      </div>
    </div>
  );
}

export function TextForm({ initial, documentId, onDone }: { initial?: { title: string; content: string }; documentId?: string; onDone: () => void }) {
  const [values, setValues] = useState(initial ?? { title: '', content: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  async function submit() {
    const parsed = knowledgeTextSchema.safeParse(values);
    if (!parsed.success) return setErrors(fieldErrorsFrom(parsed.error));
    setErrors({});
    setSaving(true);
    try {
      await api(documentId ? `/api/v1/knowledge/${documentId}` : '/api/v1/knowledge/text', { method: documentId ? 'PATCH' : 'POST', json: parsed.data });
      toast.success(documentId ? 'Text updated' : 'Text added');
      onDone();
    } catch (err) {
      setErrors(fieldErrorsFrom(err));
      toast.error(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="space-y-4">
      <Field label="Title" htmlFor="text-title" error={errors.title}>
        <Input id="text-title" placeholder="Return policy" value={values.title} onChange={(e) => setValues((v) => ({ ...v, title: e.target.value }))} />
      </Field>
      <Field label="Content" htmlFor="text-content" error={errors.content} hint="Markdown headings (# Title) become sections the assistant can cite.">
        <Textarea id="text-content" rows={12} className="font-mono text-[13px]" value={values.content} onChange={(e) => setValues((v) => ({ ...v, content: e.target.value }))} />
      </Field>
      <div className="flex justify-end">
        <Button onClick={submit} disabled={saving}>
          {saving && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
          {documentId ? 'Save text' : 'Add text'}
        </Button>
      </div>
    </div>
  );
}

export function AddSourceDialog({ open, onOpenChange, initialKind, onAdded }: { open: boolean; onOpenChange: (v: boolean) => void; initialKind: SourceKind; onAdded: () => void }) {
  const done = () => {
    onAdded();
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add knowledge</DialogTitle>
          <DialogDescription>Everything you add is split into passages, indexed for search, and used by the assistant to answer with sources.</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue={initialKind}>
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="file">
              <FileUp className="me-1.5 h-4 w-4" /> Files
            </TabsTrigger>
            <TabsTrigger value="website">
              <Globe className="me-1.5 h-4 w-4" /> Website
            </TabsTrigger>
            <TabsTrigger value="faq">
              <HelpCircle className="me-1.5 h-4 w-4" /> FAQ
            </TabsTrigger>
            <TabsTrigger value="text">
              <Type className="me-1.5 h-4 w-4" /> Text
            </TabsTrigger>
          </TabsList>
          <TabsContent value="file" className="pt-3">
            <UploadForm onDone={onAdded} />
          </TabsContent>
          <TabsContent value="website" className="pt-3">
            <WebsiteForm onDone={done} />
          </TabsContent>
          <TabsContent value="faq" className="pt-3">
            <FaqForm onDone={done} />
          </TabsContent>
          <TabsContent value="text" className="pt-3">
            <TextForm onDone={done} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
