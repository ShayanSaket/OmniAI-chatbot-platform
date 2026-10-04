'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { formatDistanceToNowStrict } from 'date-fns';
import { AlertTriangle, ArrowDownRight, ArrowUpRight, BookPlus, HelpCircle, Lightbulb, Loader2, MessageSquareWarning, Minus, Sparkles, TrendingUp } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ApiError, api } from '@/lib/api-client';
import type { InsightItem, InsightsData, PeriodQuery, TopicCluster } from '@/lib/analytics';
import { formatNumber, formatPercent, humanize } from '@/lib/format';
import { cn } from '@/lib/utils';

const KIND: Record<InsightItem['kind'], { icon: typeof Lightbulb; label: string; tone: string }> = {
  knowledge_gap: { icon: BookPlus, label: 'Knowledge gap', tone: 'text-amber-600 bg-amber-500/10 dark:text-amber-400' },
  faq: { icon: HelpCircle, label: 'Frequent question', tone: 'text-sky-600 bg-sky-500/10 dark:text-sky-400' },
  complaint: { icon: MessageSquareWarning, label: 'Complaint', tone: 'text-rose-600 bg-rose-500/10 dark:text-rose-400' },
  trend: { icon: TrendingUp, label: 'Trend', tone: 'text-violet-600 bg-violet-500/10 dark:text-violet-400' },
  opportunity: { icon: Lightbulb, label: 'Opportunity', tone: 'text-emerald-600 bg-emerald-500/10 dark:text-emerald-400' },
};

/** Opens the knowledge base with these questions pre-filled as new FAQ entries. */
export function knowledgeLink(topic: TopicCluster) {
  const p = new URLSearchParams({ add: 'faq', title: `FAQ: ${topic.label}` });
  topic.examples.slice(0, 5).forEach((e) => p.append('q', e.text.slice(0, 300)));
  return `/knowledge?${p.toString()}`;
}

function Topic({ topic, kind, canEditKnowledge, canInbox }: { topic: TopicCluster; kind: 'gap' | 'faq' | 'complaint'; canEditKnowledge: boolean; canInbox: boolean }) {
  return (
    <li className="rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium first-letter:uppercase" dir="auto">
          {topic.label}
        </p>
        <p className="text-xs tabular-nums text-muted-foreground">
          {topic.count} {topic.count === 1 ? 'message' : 'messages'} · {topic.customers} {topic.customers === 1 ? 'customer' : 'customers'}
        </p>
      </div>
      <ul className="mt-2 space-y-1">
        {topic.examples.map((e) => (
          <li key={`${e.conversationId}-${e.text}`} className="flex items-start gap-2 text-[13px] text-muted-foreground">
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/60" />
            {canInbox ? (
              <Link href={`/inbox?conversation=${e.conversationId}`} className="min-w-0 hover:text-foreground hover:underline" dir="auto">
                “{e.text}”
              </Link>
            ) : (
              <span dir="auto">“{e.text}”</span>
            )}
          </li>
        ))}
      </ul>
      {kind === 'gap' && canEditKnowledge && (
        <Button asChild size="sm" variant="secondary" className="mt-3 h-8">
          <Link href={knowledgeLink(topic)}>
            <BookPlus className="me-1.5 h-4 w-4" /> Add answers to the knowledge base
          </Link>
        </Button>
      )}
    </li>
  );
}

interface Props {
  initial: InsightsData;
  query: PeriodQuery;
  canEditKnowledge: boolean;
  canInbox: boolean;
}

export function InsightsView({ initial, query, canEditKnowledge, canInbox }: Props) {
  const [data, setData] = useState(initial);
  const [generating, setGenerating] = useState(false);
  // A new period (navigation) brings new server data.
  useEffect(() => setData(initial), [initial]);
  const q = data.questions;

  async function generate() {
    setGenerating(true);
    try {
      const res = await api<{ data: InsightsData }>('/api/v1/analytics/insights', { method: 'POST', json: query });
      setData(res.data);
      toast.success('Insights written.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not write insights.');
    } finally {
      setGenerating(false);
    }
  }

  const report = data.report;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {[
          { label: 'Customer questions', value: formatNumber(q.total), hint: 'Questions the AI received' },
          { label: 'Answered from your data', value: formatPercent(q.answerRate), hint: 'Knowledge, products, orders, hours' },
          { label: 'No verified answer', value: formatNumber(q.unanswered), hint: 'Possible knowledge gaps', warn: q.unanswered > 0 },
          { label: 'Complaints', value: formatNumber(data.complaintCount), hint: 'Messages detected as complaints', warn: data.complaintCount > 0 },
        ].map((s) => (
          <div key={s.label} className="rounded-xl border bg-card p-4 shadow-sm shadow-black/[0.02] sm:p-5">
            <p className="text-[13px] font-medium text-muted-foreground">{s.label}</p>
            <p className={cn('mt-2 text-2xl font-semibold tabular-nums tracking-tight', s.warn && 'text-amber-600 dark:text-amber-400')}>{s.value}</p>
            <p className="mt-1 text-xs text-muted-foreground">{s.hint}</p>
          </div>
        ))}
      </div>

      <section className="rounded-xl border bg-gradient-to-br from-violet-500/[0.06] via-card to-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <Sparkles className="h-4 w-4 text-violet-500" /> AI analysis
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {report ? (
                <span suppressHydrationWarning>
                  Written {formatDistanceToNowStrict(new Date(report.createdAt), { addSuffix: true })}
                  {report.createdBy ? ` by ${report.createdBy}` : ''} for{' '}
                  {new Date(report.periodStart).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} –{' '}
                  {new Date(new Date(report.periodEnd).getTime() - 1).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                </span>
              ) : (
                'Turns the topics below into concrete recommendations. Only aggregated numbers and short, redacted examples are sent to the AI.'
              )}
            </p>
          </div>
          <Button size="sm" onClick={() => void generate()} disabled={generating}>
            {generating ? <Loader2 className="me-1.5 h-4 w-4 animate-spin" /> : <Sparkles className="me-1.5 h-4 w-4" />}
            {report ? `Refresh for ${data.period.label.toLowerCase()}` : 'Write insights with AI'}
          </Button>
        </div>
        {report && (
          <div className="mt-4 space-y-3">
            <p className="text-sm leading-relaxed">{report.content.summary}</p>
            <ul className="grid gap-3 md:grid-cols-2">
              {report.content.insights.map((i, idx) => {
                const kind = KIND[i.kind] ?? KIND.opportunity;
                return (
                  <li key={idx} className="rounded-lg border bg-card p-4">
                    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium', kind.tone)}>
                      <kind.icon className="h-3 w-3" /> {kind.label}
                    </span>
                    <p className="mt-2 font-medium">{i.title}</p>
                    {i.detail && <p className="mt-1 text-[13px] text-muted-foreground">{i.detail}</p>}
                    {i.action && <p className="mt-2 text-[13px]"><span className="font-medium">Next step:</span> {i.action}</p>}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="min-w-0">
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold">
            <AlertTriangle className="h-4 w-4 text-amber-500" /> Questions the AI couldn’t answer
          </h2>
          <p className="mb-3 text-xs text-muted-foreground">No matching knowledge, product or order data was found, so the assistant had no verified answer.</p>
          {data.gaps.length === 0 ? (
            <Empty text={q.unanswered ? 'Unanswered questions don’t share a topic yet.' : 'Every question in this period was answered from your data.'} />
          ) : (
            <ul className="space-y-3">
              {data.gaps.map((t) => (
                <Topic key={t.label} topic={t} kind="gap" canEditKnowledge={canEditKnowledge} canInbox={canInbox} />
              ))}
            </ul>
          )}
        </section>
        <section className="min-w-0">
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold">
            <HelpCircle className="h-4 w-4 text-sky-500" /> Frequently asked questions
          </h2>
          <p className="mb-3 text-xs text-muted-foreground">Answered topics customers ask about most — good candidates for your website’s FAQ.</p>
          {data.faqs.length === 0 ? (
            <Empty text="Not enough answered questions to find topics." />
          ) : (
            <ul className="space-y-3">
              {data.faqs.map((t) => (
                <Topic key={t.label} topic={t} kind="faq" canEditKnowledge={canEditKnowledge} canInbox={canInbox} />
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="min-w-0">
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold">
            <MessageSquareWarning className="h-4 w-4 text-rose-500" /> Common complaints
          </h2>
          <p className="mb-3 text-xs text-muted-foreground">Messages the AI classified as complaints, grouped by topic.</p>
          {data.complaints.length === 0 ? (
            <Empty text="No complaints in this period." />
          ) : (
            <ul className="space-y-3">
              {data.complaints.map((t) => (
                <Topic key={t.label} topic={t} kind="complaint" canEditKnowledge={canEditKnowledge} canInbox={canInbox} />
              ))}
            </ul>
          )}
        </section>
        <section className="min-w-0 rounded-xl border bg-card p-5">
          <h2 className="mb-1 text-sm font-semibold">Top customer intents</h2>
          <p className="mb-4 text-xs text-muted-foreground">Compared with the previous period of the same length</p>
          {data.intents.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No intents detected yet</p>
          ) : (
            <ul className="space-y-2">
              {data.intents.map((i) => {
                const delta = i.count - i.previous;
                const Icon = delta > 0 ? ArrowUpRight : delta < 0 ? ArrowDownRight : Minus;
                return (
                  <li key={i.intent} className="flex items-center gap-3 text-sm">
                    <span className="w-28 shrink-0">{humanize(i.intent)}</span>
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <span className="block h-full rounded-full bg-primary/80" style={{ width: `${Math.max(4, (i.count / data.intents[0]!.count) * 100)}%` }} />
                    </span>
                    <span className="w-10 text-right tabular-nums">{i.count}</span>
                    <span className={cn('inline-flex w-14 items-center justify-end gap-0.5 text-xs tabular-nums', delta > 0 ? 'text-emerald-600' : delta < 0 ? 'text-rose-600' : 'text-muted-foreground')}>
                      <Icon className="h-3 w-3" />
                      {delta === 0 ? '0' : `${delta > 0 ? '+' : ''}${delta}`}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">{text}</p>;
}
