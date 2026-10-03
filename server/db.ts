import 'server-only';
import { PrismaClient } from '@prisma/client';

// Root (unscoped) client. Tenant data should be accessed through tenantDb()
// (server/tenancy) — use this directly only for cross-tenant concerns such as
// authentication, webhook routing and background jobs.

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
