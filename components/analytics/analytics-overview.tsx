import Link from 'next/link';
import {
  Bot,
  CheckCircle2,
  Clock,
  Coins,
  Globe,
  Headset,
  HelpCircle,
  Inbox,
  MessageCircle,
  MessagesSquare,
  Percent,
  Send,
  Target,
  UserPlus,
  Users,
} from 'lucide-react';
import { BarList } from '@/components/dashboard/bar-list';
import { ConversationsChart } from '@/components/dashboard/conversations-chart';
import { KpiCard } from '@/components/dashboard/kpi-card';
import type { AnalyticsReport } from '@/lib/analytics';
import { formatDuration, formatNumber, formatPercent, humanize } from '@/lib/format';
import { ActivityChart } from './activity-chart';

const usd = (v: number) => (v === 0 ? '$0.00' : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
const KIND_LABEL: Record<string, string> = {
  CHAT: 'Chat replies',
  EMBEDDING: 'Knowledge indexing & search',
  SUMMARY: 'Summaries & insights',
  CLASSIFICATION: 'Intent detection',
  SUGGESTION: 'Reply suggestions',
  TRANSCRIPTION: 'Voice transcription',
};

export function Panel({ title, description, children, className = '', action }: { title: string; description?: string; children: React.ReactNode; className?: string; action?: React.ReactNode }) {
  return (
    <section className={`min-w-0 rounded-xl border bg-card p-5 shadow-sm shadow-black/[0.02] ${className}`}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function AnalyticsOverview({ report: r, compare, insightsHref }: { report: AnalyticsReport; compare: string; insightsHref: string }) {
  const k = r.kpis;
  const knowledgeShare = r.knowledge.aiReplies ? Math.round((r.knowledge.repliesWithSources / r.knowledge.aiReplies) * 100) : 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-5">
        <KpiCard label="Conversations" icon={MessagesSquare} value={formatNumber(k.conversations.value)} current={k.conversations.value} previous={k.conversations.previous} comparisonLabel={compare} />
        <KpiCard label="Website" icon={Globe} value={formatNumber(k.websiteConversations.value)} current={k.websiteConversations.value} previous={k.websiteConversations.previous} comparisonLabel={compare} />
        <KpiCard label="WhatsApp" icon={MessageCircle} value={formatNumber(k.whatsappConversations.value)} current={k.whatsappConversations.value} previous={k.whatsappConversations.previous} comparisonLabel={compare} />
        <KpiCard label="Unique customers" icon={Users} value={formatNumber(k.uniqueCustomers.value)} current={k.uniqueCustomers.value} previous={k.uniqueCustomers.previous} comparisonLabel={compare} />
        <KpiCard label="Messages received" icon={Inbox} value={formatNumber(k.messagesReceived.value)} current={k.messagesReceived.value} previous={k.messagesReceived.previous} comparisonLabel={compare} />
        <KpiCard label="Messages sent" icon={Send} value={formatNumber(k.messagesSent.value)} current={k.messagesSent.value} previous={k.messagesSent.previous} hint="By the AI and your team" comparisonLabel={compare} />
        <KpiCard label="AI resolution rate" icon={CheckCircle2} value={formatPercent(k.aiResolutionRate.value)} current={k.aiResolutionRate.value} previous={k.aiResolutionRate.previous} hint="Closed without a person" comparisonLabel={compare} />
        <KpiCard label="Escalation rate" icon={Headset} value={formatPercent(k.escalationRate.value)} current={k.escalationRate.value} previous={k.escalationRate.previous} lowerIsBetter comparisonLabel={compare} />
        <KpiCard label="Questions answered" icon={HelpCircle} value={formatPercent(k.answerRate.value)} current={k.answerRate.value} previous={k.answerRate.previous} hint="From verified information" comparisonLabel={compare} />
        <KpiCard label="Leads" icon={Target} value={formatNumber(k.leads.value)} current={k.leads.value} previous={k.leads.previous} comparisonLabel={compare} />
        <KpiCard label="Conversion rate" icon={Percent} value={formatPercent(k.conversionRate.value)} current={k.conversionRate.value} previous={k.conversionRate.previous} hint="Conversations → leads" comparisonLabel={compare} />
        <KpiCard label="New customers" icon={UserPlus} value={formatNumber(k.newCustomers.value)} current={k.newCustomers.value} previous={k.newCustomers.previous} comparisonLabel={compare} />
        <KpiCard label="First response" icon={Bot} value={formatDuration(k.avgFirstResponseSeconds.value)} current={k.avgFirstResponseSeconds.value} previous={k.avgFirstResponseSeconds.previous} lowerIsBetter hint="Average, AI or team" comparisonLabel={compare} />
        <KpiCard label="Human response" icon={Clock} value={formatDuration(k.avgHumanResponseSeconds.value)} current={k.avgHumanResponseSeconds.value} previous={k.avgHumanResponseSeconds.previous} lowerIsBetter hint="Handoff → first team reply" comparisonLabel={compare} />
        <KpiCard label="AI cost (est.)" icon={Coins} value={usd(k.costUsd.value)} current={k.costUsd.value} previous={k.costUsd.previous} lowerIsBetter hint={`${formatNumber(k.tokens.value)} tokens`} comparisonLabel={compare} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Conversations by channel" description={r.period.bucket === 'hour' ? 'New conversations per hour' : 'New conversations per day'} className="lg:col-span-2">
          <ConversationsChart data={r.series.map((s) => ({ bucket: s.bucket, website: s.website, whatsapp: s.whatsapp, other: 0 }))} />
        </Panel>
        <Panel title="Channels" description="Conversations, messages and leads">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="pb-2 text-left font-medium">Channel</th>
                <th className="pb-2 text-right font-medium">Conv.</th>
                <th className="pb-2 text-right font-medium">Msgs</th>
                <th className="pb-2 text-right font-medium">Leads</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {r.channels.map((c) => (
                <tr key={c.channel} className="border-t">
                  <td className="py-2">{c.channel === 'WHATSAPP' ? 'WhatsApp' : 'Website'}</td>
                  <td className="py-2 text-right">{formatNumber(c.conversations)}</td>
                  <td className="py-2 text-right">{formatNumber(c.messages)}</td>
                  <td className="py-2 text-right">{formatNumber(c.leads)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-5">
            <p className="mb-2 text-xs font-medium text-muted-foreground">Customer mood</p>
            <BarList items={r.sentiment.map((s) => ({ label: humanize(s.sentiment.toUpperCase()), value: s.count }))} emptyLabel="No sentiment detected yet" />
          </div>
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Top questions" description={`${formatNumber(r.questions.total)} questions · ${formatNumber(r.questions.unanswered)} without a verified answer`} className="lg:col-span-2" action={<Link href={insightsHref} className="shrink-0 text-xs font-medium text-primary hover:underline">AI insights →</Link>}>
          {r.topQuestions.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Not enough questions in this period to find topics.</p>
          ) : (
            <ul className="divide-y">
              {r.topQuestions.map((t) => (
                <li key={t.label} className="py-2.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="font-medium first-letter:uppercase" dir="auto">
                      {t.label}
                    </p>
                    <p className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {t.count} questions · {t.customers} {t.customers === 1 ? 'customer' : 'customers'}
                    </p>
                  </div>
                  <p className="mt-0.5 truncate text-[13px] text-muted-foreground" dir="auto">
                    “{t.examples[0]?.text}”
                  </p>
                </li>
              ))}
            </ul>
          )}
          {r.topKeywords.length > 0 && (
            <div className="mt-4 border-t pt-4">
              <p className="mb-2 text-xs font-medium text-muted-foreground">Most mentioned topics</p>
              <div className="flex flex-wrap gap-1.5">
                {r.topKeywords.map((w) => (
                  <span key={w.term} className="rounded-full bg-muted px-2.5 py-1 text-xs" dir="auto">
                    {w.term} <span className="text-muted-foreground">{w.count}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </Panel>
        <Panel title="Intents" description="What customers wanted, per message">
          <BarList items={r.intents.slice(0, 8).map((i) => ({ label: humanize(i.intent), value: i.count }))} emptyLabel="No intents detected yet" />
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Knowledge base usage" description="How often answers were backed by your sources">
          <dl className="grid grid-cols-3 gap-2">
            {[
              { label: 'AI replies', value: formatNumber(r.knowledge.aiReplies) },
              { label: 'With sources', value: `${knowledgeShare}%` },
              { label: 'Search hit rate', value: formatPercent(r.knowledge.retrievalHitRate) },
            ].map((s) => (
              <div key={s.label} className="rounded-lg bg-muted/50 px-3 py-2">
                <dt className="text-[11px] text-muted-foreground">{s.label}</dt>
                <dd className="text-lg font-semibold tabular-nums">{s.value}</dd>
              </div>
            ))}
          </dl>
          <p className="mb-2 mt-5 text-xs font-medium text-muted-foreground">Most cited sources</p>
          <BarList items={r.knowledge.topDocuments.map((d) => ({ label: d.title, value: d.citations }))} emptyLabel="No sources cited in this period" />
          {r.knowledge.unusedDocuments.length > 0 && (
            <p className="mt-4 text-xs text-muted-foreground">
              Not cited in this period: {r.knowledge.unusedDocuments.map((d) => d.title).join(', ')}
            </p>
          )}
        </Panel>
        <Panel title="AI usage & cost" description={`Estimated from token prices · ${usd(r.cost.perConversationUsd)} per conversation${r.cost.avgChatLatencyMs ? ` · ${(r.cost.avgChatLatencyMs / 1000).toFixed(1)} s average reply time` : ''}`}>
          <ActivityChart data={r.series} metric="cost" />
          <table className="mt-4 w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="pb-2 text-left font-medium">Used for</th>
                <th className="pb-2 text-right font-medium">Calls</th>
                <th className="pb-2 text-right font-medium">Tokens</th>
                <th className="pb-2 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {r.cost.byKind.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-4 text-center text-muted-foreground">
                    No AI usage in this period
                  </td>
                </tr>
              )}
              {r.cost.byKind.map((c) => (
                <tr key={c.kind} className="border-t">
                  <td className="py-1.5">{KIND_LABEL[c.kind] ?? humanize(c.kind)}</td>
                  <td className="py-1.5 text-right">{formatNumber(c.calls)}</td>
                  <td className="py-1.5 text-right">{formatNumber(c.tokens)}</td>
                  <td className="py-1.5 text-right">{usd(c.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {r.cost.byModel.length > 0 && <p className="mt-3 text-xs text-muted-foreground">Models: {r.cost.byModel.map((m) => `${m.model} (${usd(m.costUsd)})`).join(' · ')}</p>}
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Message volume" description="Messages from customers, the AI and your team">
          <ActivityChart data={r.series} metric="messages" />
        </Panel>
        <Panel title="Team" description="Replies by team members in this period">
          {r.team.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No team replies in this period — the AI handled everything.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="pb-2 text-left font-medium">Member</th>
                  <th className="pb-2 text-right font-medium">Conversations</th>
                  <th className="pb-2 text-right font-medium">Replies</th>
                  <th className="pb-2 text-right font-medium">First reply</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {r.team.map((t) => (
                  <tr key={t.userId} className="border-t">
                    <td className="py-2">{t.name}</td>
                    <td className="py-2 text-right">{formatNumber(t.conversations)}</td>
                    <td className="py-2 text-right">{formatNumber(t.replies)}</td>
                    <td className="py-2 text-right">{t.avgFirstReplySeconds === null ? '—' : formatDuration(t.avgFirstReplySeconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  );
}
