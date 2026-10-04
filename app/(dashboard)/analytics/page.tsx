import type { Metadata } from 'next';
import Link from 'next/link';
import { Download } from 'lucide-react';
import { AnalyticsOverview } from '@/components/analytics/analytics-overview';
import { InsightsView } from '@/components/analytics/insights-view';
import { PeriodPicker } from '@/components/analytics/period-picker';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { parsePeriodQuery, periodQueryString } from '@/lib/analytics';
import { hasPermission } from '@/lib/permissions';
import { localDateKey } from '@/lib/time';
import { cn } from '@/lib/utils';
import { requirePageAuth } from '@/server/auth/session';
import { getInsights } from '@/server/modules/analytics/insights-service';
import { getAnalyticsReport } from '@/server/modules/analytics/report-service';

export const metadata: Metadata = { title: 'Analytics' };

type SearchParams = Record<string, string | string[] | undefined>;

export default async function AnalyticsPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await requirePageAuth('analytics:view');
  const params = new URLSearchParams(Object.entries(searchParams).flatMap(([k, v]) => (typeof v === 'string' ? [[k, v]] : [])));
  const view = params.get('view') === 'insights' ? 'insights' : 'overview';
  const query = parsePeriodQuery(params);
  const tz = ctx.organization.timezone;
  const today = localDateKey(new Date(), tz);
  const [report, insights] = await Promise.all([
    view === 'overview' ? getAnalyticsReport(ctx, query, tz) : Promise.resolve(null),
    view === 'insights' ? getInsights(ctx, query, tz) : Promise.resolve(null),
  ]);
  const period = (report ?? insights)!.period;
  const qs = periodQueryString(period.query);
  const compare = period.query.range === 'today' ? 'vs. yesterday' : `vs. previous ${period.days} days`;

  return (
    <>
      <PageHeader
        title="Analytics"
        description={`${period.label} · Website and WhatsApp, in ${tz.replace('_', ' ')} time`}
        actions={<PeriodPicker value={period.query} view={view} today={today} label={period.label} />}
      />
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Analytics sections" className="inline-flex rounded-md bg-muted p-0.5">
          {[
            { value: 'overview', label: 'Overview' },
            { value: 'insights', label: 'AI insights' },
          ].map((t) => (
            <Link
              key={t.value}
              href={`/analytics?view=${t.value}&${qs}`}
              aria-current={view === t.value ? 'page' : undefined}
              className={cn('rounded px-3 py-1.5 text-sm font-medium', view === t.value ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground')}
            >
              {t.label}
            </Link>
          ))}
        </nav>
        {view === 'overview' && (
          <Button asChild variant="outline" size="sm">
            <a href={`/api/v1/analytics/export?${qs}`} download>
              <Download className="me-1.5 h-4 w-4" /> Export CSV
            </a>
          </Button>
        )}
      </div>
      {report && <AnalyticsOverview report={report} compare={compare} insightsHref={`/analytics?view=insights&${qs}`} />}
      {insights && (
        <InsightsView
          initial={insights}
          query={period.query}
          canEditKnowledge={hasPermission(ctx.role, 'knowledge:manage')}
          canInbox={hasPermission(ctx.role, 'inbox:access')}
        />
      )}
    </>
  );
}
