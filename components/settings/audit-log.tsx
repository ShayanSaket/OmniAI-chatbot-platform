'use client';

import { useState } from 'react';
import { format } from 'date-fns';
import { Loader2, ScrollText } from 'lucide-react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/common/empty-state';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api-client';
import type { Paginated } from '@/lib/types';

export interface AuditRow {
  id: string;
  action: string;
  entityType: string | null;
  ipAddress: string | null;
  createdAt: string;
  actor: { name: string | null; email: string } | null;
}

const ACTION_LABELS: Record<string, string> = {
  'auth.login': 'Signed in',
  'auth.login_failed': 'Failed sign-in attempt',
  'organization.created': 'Created the organization',
  'organization.updated': 'Updated organization settings',
  'team.member_added': 'Added a team member',
  'team.role_changed': 'Changed a member role',
  'team.member_removed': 'Removed a team member',
};

export function AuditLog({ initial }: { initial: Paginated<AuditRow> }) {
  const [rows, setRows] = useState(initial.data);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [loading, setLoading] = useState(false);

  async function loadMore() {
    if (!cursor) return;
    setLoading(true);
    try {
      const page = await api<Paginated<AuditRow>>(`/api/v1/audit-logs?cursor=${encodeURIComponent(cursor)}`);
      setRows((r) => [...r, ...page.data]);
      setCursor(page.nextCursor);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load more entries');
    } finally {
      setLoading(false);
    }
  }

  if (rows.length === 0) {
    return <EmptyState icon={ScrollText} title="No audit entries yet" description="Security-relevant activity will be recorded here." />;
  }

  return (
    <div>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2.5 text-left font-medium">Event</th>
              <th className="px-4 py-2.5 text-left font-medium">Actor</th>
              <th className="hidden px-4 py-2.5 text-left font-medium md:table-cell">IP address</th>
              <th className="px-4 py-2.5 text-right font-medium">When</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="px-4 py-2.5">
                  <p className="font-medium">{ACTION_LABELS[r.action] ?? r.action}</p>
                  <p className="font-mono text-[11px] text-muted-foreground">{r.action}</p>
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">{r.actor?.name ?? r.actor?.email ?? 'System'}</td>
                <td className="hidden px-4 py-2.5 font-mono text-xs text-muted-foreground md:table-cell">{r.ipAddress ?? '—'}</td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right text-xs tabular-nums text-muted-foreground">
                  {format(new Date(r.createdAt), 'd MMM yyyy, HH:mm')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cursor && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" size="sm" onClick={loadMore} disabled={loading}>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
