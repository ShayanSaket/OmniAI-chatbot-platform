import type { Role } from '@/lib/permissions';
import type { TenantDb } from './tenancy/tenant-db';

/** Everything a domain service needs to act on behalf of a member of an organization. */
export interface ServiceContext {
  organizationId: string;
  userId: string;
  role: Role;
  db: TenantDb;
  requestId?: string;
  ip?: string;
  userAgent?: string;
}
