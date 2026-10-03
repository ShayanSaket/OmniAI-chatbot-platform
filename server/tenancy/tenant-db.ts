import 'server-only';
import { prisma } from '../db';
import { scopeArgs } from './scope';

/**
 * Prisma client whose every model query is constrained to one organization.
 *
 * - `where` clauses get `organizationId` injected (or rejected if they target another org)
 * - creates must pass `organizationId` (the types require it); a mismatch throws.
 *   Use scalar FKs (e.g. `customerId`), not `connect`.
 * - updates cannot move rows to another organization
 * - unclassified models throw (fail closed)
 *
 * Raw SQL (`$queryRaw`) is NOT scoped: always filter by `organizationId` explicitly.
 */
export function tenantDb(organizationId: string) {
  return prisma.$extends({
    name: 'tenant-scope',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          return query(scopeArgs(model, operation, args as Record<string, unknown>, organizationId) as typeof args);
        },
      },
    },
  });
}

export type TenantDb = ReturnType<typeof tenantDb>;
