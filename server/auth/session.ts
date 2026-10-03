import 'server-only';
import { cache } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { hasPermission, homePathForRole, type Permission, type Role } from '@/lib/permissions';
import { prisma } from '../db';
import { AppError } from '../errors';
import { clientIp, requestId, userAgent } from '../request';
import { tenantDb } from '../tenancy/tenant-db';
import type { ServiceContext } from '../context';
import { authOptions } from './options';

export interface AuthContext extends ServiceContext {
  user: { id: string; email: string; name: string | null };
  organization: {
    id: string;
    name: string;
    slug: string;
    timezone: string;
    defaultLanguage: string;
  };
  memberships: { organizationId: string; organizationName: string; role: Role }[];
}

/**
 * Resolves the signed-in user and their active membership. The role always comes
 * from the database (never from the token), so role changes and removals apply
 * on the next request. Memoized per request.
 */
export const getAuthContext = cache(async (): Promise<AuthContext | null> => {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;
  if (!userId) return null;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      memberships: {
        orderBy: { createdAt: 'asc' },
        select: {
          role: true,
          organization: {
            select: { id: true, name: true, slug: true, timezone: true, defaultLanguage: true },
          },
        },
      },
    },
  });
  if (!user || user.memberships.length === 0) return null;

  const active =
    user.memberships.find((m) => m.organization.id === session.organizationId) ?? user.memberships[0]!;
  const h = headers();

  return {
    organizationId: active.organization.id,
    userId: user.id,
    role: active.role,
    db: tenantDb(active.organization.id),
    requestId: requestId(h),
    ip: clientIp(h),
    userAgent: userAgent(h),
    user: { id: user.id, email: user.email, name: user.name },
    organization: active.organization,
    memberships: user.memberships.map((m) => ({
      organizationId: m.organization.id,
      organizationName: m.organization.name,
      role: m.role,
    })),
  };
});

/** For server components/pages: redirects instead of throwing. */
export async function requirePageAuth(permission?: Permission): Promise<AuthContext> {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');
  if (permission && !hasPermission(ctx.role, permission)) redirect(homePathForRole(ctx.role));
  return ctx;
}

/** For route handlers: throws 401/403 AppErrors. */
export async function requireApiAuth(permission?: Permission): Promise<AuthContext> {
  const ctx = await getAuthContext();
  if (!ctx) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
  if (permission && !hasPermission(ctx.role, permission)) {
    throw new AppError('FORBIDDEN', 'You do not have permission to do that.');
  }
  return ctx;
}
