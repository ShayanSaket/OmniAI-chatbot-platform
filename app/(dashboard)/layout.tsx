import { AppShell } from '@/components/layout/app-shell';
import { Providers } from '@/components/providers';
import { requirePageAuth } from '@/server/auth/session';

export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requirePageAuth();
  return (
    <Providers>
      <AppShell user={ctx.user} organizationName={ctx.organization.name} role={ctx.role}>
        {children}
      </AppShell>
    </Providers>
  );
}
