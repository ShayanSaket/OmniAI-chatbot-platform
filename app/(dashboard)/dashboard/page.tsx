import type { Metadata } from 'next';
import Link from 'next/link';
import { formatDistanceToNowStrict } from 'date-fns';
import {
  Bot,
  BookOpen,
  CheckCircle2,
  Clock,
  Globe,
  Headset,
  MessageCircle,
  MessagesSquare,
  Percent,
  Radio,
  Sparkles,
  Target,
  TrendingUp,
} from 'lucide-react';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState } from '@/components/common/empty-state';
import { BarList } from '@/components/dashboard/bar-list';
import { ChannelBadge, STATUS_LABEL, StatusBadge } from '@/components/dashboard/channel-badge';
import { ConversationsChart } from '@/components/dashboard/conversations-chart';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { RangeTabs } from '@/components/dashboard/range-tabs';
import { formatDuration, formatNumber, formatPercent, humanize } from '@/lib/format';
import { initials } from '@/lib/utils';
import { analyticsRangeSchema } from '@/lib/validation';
import { requirePageAuth } from '@/server/auth/session';
import { getOverview } from '@/server/modules/analytics/overview-service';

export const metadata: Metadata = { title: 'Dashboard' };

function greeting(timeZone: string) {
  const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(new Date()));
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

const COMPARISON = { today: 'vs. yesterday', '7d': 'vs. prior 7d', '30d': 'vs. prior 30d' } as const;
const LEAD_STAGES = ['NEW', 'CONTACTED', 'QUALIFIED', 'PROPOSAL', 'WON', 'LOST'];

function Panel({ title, description, children, className = '' }: { title: string; description?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border bg-card p-5 shadow-sm shadow-black/[0.02] ${className}`}>
      <div className="mb-4">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

export default async function DashboardPage({ searchParams }: { searchParams: { range?: string } }) {
  const ctx = await requirePageAuth('dashboard:view');
  const range = analyticsRangeSchema.parse(searchParams.range);
  const data = await getOverview(ctx, { range, timeZone: ctx.organization.timezone });
  const k = data.kpis;
  const compare = COMPARISON[range];
  const firstName = ctx.user.name?.split(' ')[0];
  const isEmpty = k.totalConversations.value === 0 && k.activeConversations.value === 0 && data.recentConversations.length === 0;

  return (
    <>
      <PageHeader
        title={`${greeting(ctx.organization.timezone)}${firstName ? `, ${firstName}` : ''}`}
        description={`Here's how ${ctx.organization.name} is doing across Website and WhatsApp.`}
        actions={<RangeTabs value={range} />}
      />

      {isEmpty && (
        <div className="mb-6 overflow-hidden rounded-xl border bg-gradient-to-br from-accent via-card to-card p-6">
          <div className="flex items-start gap-4">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Sparkles className="h-5 w-5" />
            </span>
            <div>
              <h2 className="font-semibold">Your workspace is ready</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Conversations will appear here once your AI agent is live. Next steps:
              </p>
              <ol className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
                {[
                  { icon: Bot, text: 'Configure your AI agent', href: '/agent' },
                  { icon: BookOpen, text: 'Add knowledge sources', href: '/knowledge' },
                  { icon: Globe, text: 'Install the website widget', href: '/agent' },
                ].map((step, i) => (
                  <li key={step.text}>
                    <Link href={step.href} className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 transition-colors hover:border-primary/40">
                      <span className="text-xs font-semibold text-muted-foreground">{i + 1}</span>
                      <step.icon className="h-4 w-4 text-primary" />
                      {step.text}
                    </Link>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
        <KpiCard label="Conversations" icon={MessagesSquare} value={formatNumber(k.totalConversations.value)} current={k.totalConversations.value} previous={k.totalConversations.previous} comparisonLabel={compare} />
        <KpiCard label="Today" icon={TrendingUp} value={formatNumber(k.conversationsToday.value)} current={k.conversationsToday.value} previous={k.conversationsToday.previous} comparisonLabel="vs. yesterday" />
        <KpiCard label="AI resolved" icon={CheckCircle2} value={formatNumber(k.aiResolved.value)} current={k.aiResolved.value} previous={k.aiResolved.previous} comparisonLabel={compare} />
        <KpiCard label="Human escalations" icon={Headset} value={formatNumber(k.humanEscalations.value)} current={k.humanEscalations.value} previous={k.humanEscalations.previous} lowerIsBetter comparisonLabel={compare} />
        <KpiCard label="Active now" icon={Radio} value={formatNumber(k.activeConversations.value)} current={k.activeConversations.value} previous={null} hint="Open conversations" comparisonLabel="" />
        <KpiCard label="New leads" icon={Target} value={formatNumber(k.newLeads.value)} current={k.newLeads.value} previous={k.newLeads.previous} comparisonLabel={compare} />
        <KpiCard label="Conversion rate" icon={Percent} value={formatPercent(k.conversionRate.value)} current={k.conversionRate.value} previous={k.conversionRate.previous} hint="Conversations → leads" comparisonLabel={compare} />
        <KpiCard label="Avg. first response" icon={Clock} value={formatDuration(k.avgFirstResponseSeconds.value)} current={k.avgFirstResponseSeconds.value} previous={k.avgFirstResponseSeconds.previous} lowerIsBetter comparisonLabel={compare} />
        <KpiCard label="WhatsApp messages" icon={MessageCircle} value={formatNumber(k.whatsappMessages.value)} current={k.whatsappMessages.value} previous={k.whatsappMessages.previous} comparisonLabel={compare} />
        <KpiCard label="Website messages" icon={Globe} value={formatNumber(k.websiteMessages.value)} current={k.websiteMessages.value} previous={k.websiteMessages.previous} comparisonLabel={compare} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Panel title="Conversations by channel" description={range === 'today' ? 'New conversations per hour' : 'New conversations per day'} className="lg:col-span-2">
          {k.totalConversations.value > 0 ? (
            <ConversationsChart data={data.series} />
          ) : (
            <EmptyState icon={MessagesSquare} title="No conversations in this period" description="Try a longer date range." />
          )}
        </Panel>
        <Panel title="Status" description="Conversations started in this period">
          <BarList
            items={data.statusBreakdown
              .sort((a, b) => b.count - a.count)
              .map((s) => ({ label: STATUS_LABEL[s.status], value: s.count }))}
            emptyLabel="No conversations yet"
          />
        </Panel>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Panel title="Recent conversations" className="lg:col-span-2">
          {data.recentConversations.length === 0 ? (
            <EmptyState icon={MessagesSquare} title="No conversations yet" description="New Website and WhatsApp chats will show up here." />
          ) : (
            <ul className="-mx-2 divide-y">
              {data.recentConversations.map((c) => (
                <li key={c.id} className="flex items-center gap-3 rounded-lg px-2 py-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
                    {initials(c.customerName)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium">{c.customerName}</p>
                      {c.unreadCount > 0 && (
                        <span className="rounded-full bg-primary px-1.5 text-[10px] font-semibold leading-4 text-primary-foreground">
                          {c.unreadCount}
                        </span>
                      )}
                    </div>
                    <p className="truncate text-[13px] text-muted-foreground">{c.preview ?? 'No messages yet'}</p>
                  </div>
                  <div className="hidden shrink-0 flex-col items-end gap-1 sm:flex">
                    <StatusBadge status={c.status} />
                    <span className="flex items-center gap-2">
                      <ChannelBadge channel={c.channel} />
                      <span className="text-[11px] text-muted-foreground">
                        {formatDistanceToNowStrict(new Date(c.lastMessageAt), { addSuffix: true })}
                      </span>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <div className="grid gap-4">
          <Panel title="Top intents" description="What customers want, as detected by the AI">
            <BarList items={data.topIntents.map((i) => ({ label: humanize(i.intent), value: i.count }))} emptyLabel="No intents detected yet" />
          </Panel>
          <Panel title="Lead pipeline" description="All open and closed leads">
            {data.leadPipeline.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">No leads yet</p>
            ) : (
              <dl className="grid grid-cols-3 gap-2">
                {LEAD_STAGES.map((stage) => (
                  <div key={stage} className="rounded-lg bg-muted/50 px-2.5 py-2">
                    <dt className="truncate text-[11px] text-muted-foreground">{humanize(stage)}</dt>
                    <dd className="text-lg font-semibold tabular-nums">
                      {data.leadPipeline.find((p) => p.status === stage)?.count ?? 0}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
