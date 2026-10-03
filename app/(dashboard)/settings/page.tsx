import type { Metadata } from 'next';
import { PageHeader } from '@/components/common/page-header';
import { AuditLog } from '@/components/settings/audit-log';
import { OrganizationForm } from '@/components/settings/organization-form';
import { TeamManager } from '@/components/settings/team-manager';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { hasPermission } from '@/lib/permissions';
import { requirePageAuth } from '@/server/auth/session';
import { listAuditLogs } from '@/server/modules/audit/audit-service';
import { getOrganization } from '@/server/modules/organizations/organization-service';
import { listMembers } from '@/server/modules/team/team-service';

export const metadata: Metadata = { title: 'Settings' };

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border bg-card p-5 shadow-sm shadow-black/[0.02] sm:p-6">
      <div className="mb-6">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

export default async function SettingsPage({ searchParams }: { searchParams: { tab?: string } }) {
  const ctx = await requirePageAuth('team:view');
  const canSeeAudit = hasPermission(ctx.role, 'audit:view');

  const [organization, members, audit] = await Promise.all([
    getOrganization(ctx),
    listMembers(ctx),
    canSeeAudit ? listAuditLogs(ctx, { limit: 25 }) : null,
  ]);

  const tabs = ['organization', 'team', ...(canSeeAudit ? ['audit'] : [])];
  const tab = tabs.includes(searchParams.tab ?? '') ? searchParams.tab! : 'organization';

  return (
    <>
      <PageHeader title="Settings" description="Manage your workspace, team and security." />
      <Tabs defaultValue={tab} className="space-y-6">
        <TabsList>
          <TabsTrigger value="organization">Organization</TabsTrigger>
          <TabsTrigger value="team">Team</TabsTrigger>
          {canSeeAudit && <TabsTrigger value="audit">Audit log</TabsTrigger>}
        </TabsList>

        <TabsContent value="organization">
          <Section title="Organization" description="Basic details used across the dashboard and by your AI agent.">
            <OrganizationForm initial={organization} canEdit={hasPermission(ctx.role, 'organization:manage')} />
          </Section>
        </TabsContent>

        <TabsContent value="team">
          <Section title="Team" description="People who can access this workspace, and what they can do.">
            <TeamManager
              actorRole={ctx.role}
              actorUserId={ctx.userId}
              members={members.map((m) => ({
                ...m,
                createdAt: m.createdAt.toISOString(),
                user: { ...m.user, lastLoginAt: m.user.lastLoginAt?.toISOString() ?? null },
              }))}
            />
          </Section>
        </TabsContent>

        {audit && (
          <TabsContent value="audit">
            <Section title="Audit log" description="Security-relevant activity in this workspace.">
              <AuditLog
                initial={{
                  nextCursor: audit.nextCursor,
                  data: audit.data.map((r) => ({
                    id: r.id,
                    action: r.action,
                    entityType: r.entityType,
                    ipAddress: r.ipAddress,
                    createdAt: r.createdAt.toISOString(),
                    actor: r.actor ? { name: r.actor.name, email: r.actor.email } : null,
                  })),
                }}
              />
            </Section>
          </TabsContent>
        )}
      </Tabs>
    </>
  );
}
