'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatDistanceToNowStrict } from 'date-fns';
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Download,
  ExternalLink,
  FileText,
  Globe,
  HelpCircle,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Type,
} from 'lucide-react';
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api-client';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { AddSourceDialog, FaqForm, TextForm, type SourceKind } from './source-forms';

export interface KnowledgeDoc {
  id: string;
  title: string;
  sourceType: 'PDF' | 'DOCX' | 'TXT' | 'MARKDOWN' | 'WEBSITE' | 'FAQ' | 'MANUAL';
  sourceLabel: string;
  sourceUrl: string | null;
  fileName: string | null;
  fileSize: number | null;
  status: 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';
  error: string | null;
  chunkCount: number;
  tokenCount: number;
  usageCount: number;
  semantic: boolean;
  embeddingError: string | null;
  pageCount: number | null;
  processedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
}

export interface KnowledgeOverviewData {
  documents: KnowledgeDoc[];
  stats: {
    documents: number;
    ready: number;
    processing: number;
    failed: number;
    chunks: number;
    semantic: number;
    embeddingsConfigured: boolean;
    embeddingModel: string;
  };
}

interface DocumentDetail extends KnowledgeDoc {
  downloadUrl: string | null;
  faq: { question: string; answer: string }[] | null;
  text: string | null;
  chunks: { chunkIndex: number; content: string; location: string | null; pageNumber: number | null; embedded: boolean }[];
}

interface SearchResult {
  chunkId: string;
  title: string;
  location: string | null;
  pageNumber: number | null;
  content: string;
  score: number;
  similarity: number | null;
  matchedBy: ('semantic' | 'keyword')[];
}

const ICON = { PDF: FileText, DOCX: FileText, TXT: FileText, MARKDOWN: FileText, WEBSITE: Globe, FAQ: HelpCircle, MANUAL: Type } as const;

function Ago({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={new Date(iso).toISOString()} suppressHydrationWarning>
      {formatDistanceToNowStrict(new Date(iso), { addSuffix: true })}
    </time>
  );
}

function StatusBadge({ doc }: { doc: KnowledgeDoc }) {
  if (doc.status === 'PENDING' || doc.status === 'PROCESSING') {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> {doc.status === 'PENDING' ? 'Queued' : 'Processing'}
      </span>
    );
  }
  if (doc.status === 'FAILED') {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-destructive" title={doc.error ?? undefined}>
        <AlertTriangle className="h-3.5 w-3.5" /> Failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400" title={doc.semantic ? 'Semantic + keyword search' : (doc.embeddingError ?? 'Keyword search only')}>
      <CheckCircle2 className="h-3.5 w-3.5" /> Ready
      {!doc.semantic && <span className="text-xs text-muted-foreground">· keyword only</span>}
    </span>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm shadow-black/[0.02]">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function SearchTester() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ results: SearchResult[]; ms: number; semanticEnabled: boolean } | null>(null);
  async function run() {
    if (query.trim().length < 2) return;
    setLoading(true);
    try {
      const res = await api<{ data: { results: SearchResult[]; ms: number; semanticEnabled: boolean } }>('/api/v1/knowledge/search', { method: 'POST', json: { query } });
      setResult(res.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setLoading(false);
    }
  }
  return (
    <section className="space-y-4 rounded-xl border bg-card p-5 shadow-sm shadow-black/[0.02] sm:p-6">
      <div>
        <h2 className="text-base font-semibold tracking-tight">Test a question</h2>
        <p className="mt-1 text-sm text-muted-foreground">See exactly which passages the assistant would receive for a customer question, in any language.</p>
      </div>
      <div className="flex gap-2">
        <Input placeholder="e.g. Wo werden meine Daten gespeichert?" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} />
        <Button onClick={run} disabled={loading || query.trim().length < 2}>
          {loading ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : <Search className="me-2 h-4 w-4" />}
          Search
        </Button>
      </div>
      {result && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {result.results.length} passage{result.results.length === 1 ? '' : 's'} · {result.ms} ms · {result.semanticEnabled ? 'semantic + keyword' : 'keyword only (no embedding provider)'}
          </p>
          {result.results.length === 0 ? (
            <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              Nothing relevant found. The assistant would say it doesn’t have verified information — consider adding a source that answers this.
            </p>
          ) : (
            result.results.map((r, i) => (
              <div key={r.chunkId} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">
                    [{i + 1}] {r.title}
                  </span>
                  {r.pageNumber && <span className="text-xs text-muted-foreground">page {r.pageNumber}</span>}
                  {r.matchedBy.map((m) => (
                    <Badge key={m} variant="secondary" className="text-[11px]">
                      {m}
                    </Badge>
                  ))}
                  <span className="ms-auto text-xs text-muted-foreground">
                    relevance {Math.round(r.score * 100)}%{r.similarity !== null ? ` · similarity ${r.similarity.toFixed(2)}` : ''}
                  </span>
                </div>
                <p className="mt-1.5 line-clamp-3 whitespace-pre-line text-[13px] text-muted-foreground">{r.content}</p>
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
}

function DocumentSheet({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const load = useCallback(async () => {
    if (!id) return;
    try {
      const res = await api<{ data: DocumentDetail }>(`/api/v1/knowledge/${id}`);
      setDoc(res.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load the document');
      onClose();
    }
  }, [id, onClose]);

  useEffect(() => {
    setDoc(null);
    setEditing(false);
    void load();
  }, [load]);

  // Keep refreshing while it is being processed.
  useEffect(() => {
    if (!doc || (doc.status !== 'PENDING' && doc.status !== 'PROCESSING')) return;
    const t = setTimeout(() => void load(), 2000);
    return () => clearTimeout(t);
  }, [doc, load]);

  const afterEdit = () => {
    setEditing(false);
    onChanged();
    void load();
  };

  return (
    <Sheet open={id !== null} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        {!doc ? (
          <div className="flex h-40 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-5">
            <SheetHeader>
              <SheetTitle className="pe-6">{doc.title}</SheetTitle>
              <SheetDescription>
                {doc.sourceLabel}
                {doc.pageCount ? ` · ${doc.pageCount} pages` : ''} · {formatNumber(doc.chunkCount)} passages · used in {formatNumber(doc.usageCount)} answer
                {doc.usageCount === 1 ? '' : 's'}
              </SheetDescription>
            </SheetHeader>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge doc={doc} />
              {doc.sourceUrl && (
                <a href={doc.sourceUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
                  Open page <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
              {doc.downloadUrl && (
                <a href={doc.downloadUrl} className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
                  <Download className="h-3.5 w-3.5" /> {doc.fileName ?? 'Download'}
                </a>
              )}
              {(doc.faq || doc.text !== null) && !editing && (
                <Button variant="outline" size="sm" className="ms-auto" onClick={() => setEditing(true)}>
                  Edit
                </Button>
              )}
            </div>
            {doc.error && <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{doc.error}</p>}
            {doc.status === 'READY' && !doc.semantic && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
                Keyword search only{doc.embeddingError ? `: ${doc.embeddingError}` : ''}. Semantic search is added automatically once embeddings can be computed.
              </p>
            )}

            {editing && doc.faq ? (
              <FaqForm documentId={doc.id} initial={{ title: doc.title, entries: doc.faq }} onDone={afterEdit} />
            ) : editing && doc.text !== null ? (
              <TextForm documentId={doc.id} initial={{ title: doc.title, content: doc.text }} onDone={afterEdit} />
            ) : (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold">Passages</h3>
                {doc.chunks.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No passages yet.</p>
                ) : (
                  doc.chunks.map((c) => (
                    <div key={c.chunkIndex} className="rounded-lg border p-3">
                      <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                        <span>#{c.chunkIndex + 1}</span>
                        {c.pageNumber ? <span>page {c.pageNumber}</span> : null}
                        {c.location && c.location !== doc.title ? <span className="truncate">{c.location}</span> : null}
                        {c.embedded && (
                          <span className="ms-auto inline-flex items-center gap-1" title="Semantic vector stored">
                            <Sparkles className="h-3 w-3" /> semantic
                          </span>
                        )}
                      </div>
                      <p className="whitespace-pre-line text-[13px] leading-relaxed">{c.content}</p>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

export function KnowledgeManager({ initial }: { initial: KnowledgeOverviewData }) {
  const [data, setData] = useState(initial);
  const [adding, setAdding] = useState<SourceKind | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<KnowledgeDoc | null>(null);
  const [filter, setFilter] = useState('');

  const refresh = useCallback(async () => {
    try {
      const res = await api<{ data: KnowledgeOverviewData }>('/api/v1/knowledge');
      setData(res.data);
    } catch {
      /* keep the last state; next poll retries */
    }
  }, []);

  // Poll while anything is queued or processing.
  const busy = data.stats.processing > 0;
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void refresh(), 2500);
    return () => clearInterval(t);
  }, [busy, refresh]);

  const docs = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? data.documents.filter((d) => `${d.title} ${d.sourceUrl ?? ''} ${d.fileName ?? ''}`.toLowerCase().includes(q)) : data.documents;
  }, [data.documents, filter]);

  async function reindex(doc: KnowledgeDoc) {
    try {
      await api(`/api/v1/knowledge/${doc.id}/reindex`, { method: 'POST' });
      toast.success(doc.sourceType === 'WEBSITE' ? 'Refreshing the page…' : 'Re-indexing…');
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not re-index');
    }
  }

  async function remove(doc: KnowledgeDoc) {
    try {
      await api(`/api/v1/knowledge/${doc.id}`, { method: 'DELETE' });
      toast.success('Source deleted', { description: 'The assistant no longer uses it.' });
      if (selected === doc.id) setSelected(null);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete');
    }
  }

  const s = data.stats;
  return (
    <div className="space-y-6">
      {!s.embeddingsConfigured && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            Semantic search is off because no embedding provider is configured (OPENAI_API_KEY). Keyword search works meanwhile; existing sources are
            embedded automatically once a key is set.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Sources" value={formatNumber(s.documents)} hint={s.failed ? `${s.failed} failed` : s.processing ? `${s.processing} processing` : 'All processed'} />
        <Stat label="Passages" value={formatNumber(s.chunks)} hint="Searchable text sections" />
        <Stat label="Semantic" value={s.documents ? `${Math.round((s.semantic / Math.max(1, s.ready)) * 100)}%` : '–'} hint={s.embeddingModel} />
        <Stat
          label="Most used"
          value={formatNumber(data.documents.reduce((n, d) => n + d.usageCount, 0))}
          hint={[...data.documents].sort((a, b) => b.usageCount - a.usageCount)[0]?.usageCount ? `Top: ${[...data.documents].sort((a, b) => b.usageCount - a.usageCount)[0]!.title}` : 'Answers citing a source'}
        />
      </div>

      <section className="space-y-4 rounded-xl border bg-card p-5 shadow-sm shadow-black/[0.02] sm:p-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="me-auto">
            <h2 className="text-base font-semibold tracking-tight">Sources</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">Documents, web pages, FAQs and notes the assistant answers from.</p>
          </div>
          <Input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} className="h-9 w-full sm:w-48" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button>
                <Plus className="me-2 h-4 w-4" /> Add source
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setAdding('file')}>
                <FileText className="me-2 h-4 w-4" /> Upload files
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setAdding('website')}>
                <Globe className="me-2 h-4 w-4" /> Website
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setAdding('faq')}>
                <HelpCircle className="me-2 h-4 w-4" /> FAQ entries
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setAdding('text')}>
                <Type className="me-2 h-4 w-4" /> Text
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {data.documents.length === 0 ? (
          <div className="flex flex-col items-center rounded-lg border border-dashed px-6 py-12 text-center">
            <BookOpen className="h-8 w-8 text-muted-foreground" />
            <p className="mt-3 text-sm font-medium">Your knowledge base is empty</p>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              Add your product documentation, pricing, policies or FAQ. The assistant answers from these sources and says so when it doesn’t know.
            </p>
            <Button className="mt-4" onClick={() => setAdding('file')}>
              <Plus className="me-2 h-4 w-4" /> Add the first source
            </Button>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Source</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden text-end md:table-cell">Passages</TableHead>
                  <TableHead className="hidden text-end md:table-cell">Used</TableHead>
                  <TableHead className="hidden lg:table-cell">Updated</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {docs.map((doc) => {
                  const Icon = ICON[doc.sourceType];
                  return (
                    <TableRow key={doc.id} className="cursor-pointer" onClick={() => setSelected(doc.id)}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
                            <Icon className="h-4 w-4 text-muted-foreground" />
                          </div>
                          <div className="min-w-0">
                            <p className="truncate font-medium">{doc.title}</p>
                            <p className="truncate text-xs text-muted-foreground">
                              {doc.sourceLabel}
                              {doc.sourceUrl ? ` · ${doc.sourceUrl.replace(/^https?:\/\//, '')}` : doc.fileName ? ` · ${doc.fileName}` : ''}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <StatusBadge doc={doc} />
                      </TableCell>
                      <TableCell className={cn('hidden text-end text-sm md:table-cell')}>{formatNumber(doc.chunkCount)}</TableCell>
                      <TableCell className="hidden text-end text-sm md:table-cell">{formatNumber(doc.usageCount)}</TableCell>
                      <TableCell className="hidden whitespace-nowrap text-sm text-muted-foreground lg:table-cell">
                        <Ago iso={doc.updatedAt} />
                      </TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Actions for ${doc.title}`}>
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => setSelected(doc.id)}>View passages</DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => reindex(doc)} disabled={doc.status === 'PROCESSING'}>
                              <RefreshCw className="me-2 h-4 w-4" /> {doc.sourceType === 'WEBSITE' ? 'Refresh page' : 'Re-index'}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setDeleting(doc)}>
                              <Trash2 className="me-2 h-4 w-4" /> Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <SearchTester />

      {adding && <AddSourceDialog open initialKind={adding} onOpenChange={(v) => !v && setAdding(null)} onAdded={() => void refresh()} />}
      <DocumentSheet id={selected} onClose={() => setSelected(null)} onChanged={() => void refresh()} />
      <AlertDialog open={deleting !== null} onOpenChange={(v) => !v && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleting?.title}”?</AlertDialogTitle>
            <AlertDialogDescription>The assistant stops using this source immediately. Uploaded files are deleted from storage too.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleting && remove(deleting)}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
