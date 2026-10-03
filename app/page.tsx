import { redirect } from 'next/navigation';
import { homePathForRole } from '@/lib/permissions';
import { getAuthContext } from '@/server/auth/session';

export default async function Home() {
  const ctx = await getAuthContext();
  redirect(ctx ? homePathForRole(ctx.role) : '/login');
}
