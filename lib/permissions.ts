// Role-based access control shared by the server (enforcement) and the UI (display).
// The server is always authoritative; the UI uses this only to hide what it can't do.

export const ROLES = ['OWNER', 'ADMIN', 'AGENT'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'dashboard:view',
  'inbox:access',
  'conversations:reply',
  'conversations:manage',
  'customers:view',
  'customers:manage',
  'customers:delete',
  'leads:view',
  'leads:manage',
  'knowledge:manage',
  'bot:manage',
  'automations:manage',
  'analytics:view',
  'integrations:manage',
  'team:view',
  'team:manage',
  'organization:manage',
  'audit:view',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const AGENT_PERMISSIONS: readonly Permission[] = [
  'inbox:access',
  'conversations:reply',
  'customers:view',
];

const ADMIN_PERMISSIONS: readonly Permission[] = [
  ...AGENT_PERMISSIONS,
  'dashboard:view',
  'conversations:manage',
  'customers:manage',
  'customers:delete',
  'leads:view',
  'leads:manage',
  'knowledge:manage',
  'bot:manage',
  'automations:manage',
  'analytics:view',
  'team:view',
  'team:manage',
];

const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  OWNER: new Set(PERMISSIONS),
  ADMIN: new Set(ADMIN_PERMISSIONS),
  AGENT: new Set(AGENT_PERMISSIONS),
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

const ROLE_RANK: Record<Role, number> = { AGENT: 1, ADMIN: 2, OWNER: 3 };

export function roleAtLeast(role: Role, minimum: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

/** Landing page for a role (agents have no dashboard access). */
export function homePathForRole(role: Role): string {
  return hasPermission(role, 'dashboard:view') ? '/dashboard' : '/inbox';
}

export type MemberChangeDenial =
  | 'SELF_CHANGE'
  | 'INSUFFICIENT_ROLE'
  | 'CANNOT_GRANT_ROLE';

/**
 * Team-management rules:
 *  - nobody changes or removes their own membership here
 *  - OWNER manages everyone and may grant any role
 *  - ADMIN manages AGENTs only and may grant AGENT only
 *  - AGENT manages nobody
 * The "at least one OWNER" invariant needs DB state and is checked by the service.
 */
export function checkMemberChange(params: {
  actorRole: Role;
  actorIsTarget: boolean;
  targetRole: Role;
  newRole?: Role;
}): MemberChangeDenial | null {
  const { actorRole, actorIsTarget, targetRole, newRole } = params;
  if (actorIsTarget) return 'SELF_CHANGE';
  if (!hasPermission(actorRole, 'team:manage')) return 'INSUFFICIENT_ROLE';
  if (actorRole === 'OWNER') return null;
  if (targetRole !== 'AGENT') return 'INSUFFICIENT_ROLE';
  if (newRole && newRole !== 'AGENT') return 'CANNOT_GRANT_ROLE';
  return null;
}

export function canGrantRole(actorRole: Role, role: Role): boolean {
  if (!hasPermission(actorRole, 'team:manage')) return false;
  return actorRole === 'OWNER' || role === 'AGENT';
}
