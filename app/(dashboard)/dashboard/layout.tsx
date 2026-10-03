import { requirePageAuth } from '@/server/auth/session';

// Checked in the segment layout (not only the page) so the redirect happens before
// loading.tsx starts streaming — unauthorized roles get a real 307, not a client redirect.
export default async function DashboardSegmentLayout({ children }: { children: React.ReactNode }) {
  await requirePageAuth('dashboard:view');
  return children;
}
