import { describe, expect, it } from 'vitest';
import { canGrantRole, checkMemberChange, hasPermission, homePathForRole, PERMISSIONS, ROLES } from '@/lib/permissions';

describe('role permissions', () => {
  it('grants OWNER every permission', () => {
    for (const p of PERMISSIONS) expect(hasPermission('OWNER', p)).toBe(true);
  });

  it('limits AGENT to inbox and customer conversations', () => {
    const granted = PERMISSIONS.filter((p) => hasPermission('AGENT', p));
    expect(granted.sort()).toEqual(['conversations:reply', 'customers:view', 'inbox:access']);
  });

  it('lets ADMIN manage the chatbot, knowledge, customers, agents and analytics', () => {
    for (const p of ['bot:manage', 'knowledge:manage', 'customers:manage', 'team:manage', 'analytics:view'] as const) {
      expect(hasPermission('ADMIN', p)).toBe(true);
    }
  });

  it('reserves organization, integration and audit access for OWNER', () => {
    for (const p of ['organization:manage', 'integrations:manage', 'audit:view'] as const) {
      expect(hasPermission('ADMIN', p)).toBe(false);
      expect(hasPermission('AGENT', p)).toBe(false);
    }
  });

  it('sends agents to the inbox and others to the dashboard', () => {
    expect(homePathForRole('AGENT')).toBe('/inbox');
    expect(homePathForRole('ADMIN')).toBe('/dashboard');
    expect(homePathForRole('OWNER')).toBe('/dashboard');
  });
});

describe('team management rules', () => {
  it('never allows changing your own membership', () => {
    for (const role of ROLES) {
      expect(checkMemberChange({ actorRole: role, actorIsTarget: true, targetRole: role })).toBe('SELF_CHANGE');
    }
  });

  it('lets OWNER manage anyone and grant any role', () => {
    for (const target of ROLES) {
      for (const next of ROLES) {
        expect(checkMemberChange({ actorRole: 'OWNER', actorIsTarget: false, targetRole: target, newRole: next })).toBeNull();
      }
    }
    for (const r of ROLES) expect(canGrantRole('OWNER', r)).toBe(true);
  });

  it('lets ADMIN manage agents only, and only grant AGENT', () => {
    expect(checkMemberChange({ actorRole: 'ADMIN', actorIsTarget: false, targetRole: 'AGENT' })).toBeNull();
    expect(checkMemberChange({ actorRole: 'ADMIN', actorIsTarget: false, targetRole: 'ADMIN' })).toBe('INSUFFICIENT_ROLE');
    expect(checkMemberChange({ actorRole: 'ADMIN', actorIsTarget: false, targetRole: 'OWNER' })).toBe('INSUFFICIENT_ROLE');
    expect(
      checkMemberChange({ actorRole: 'ADMIN', actorIsTarget: false, targetRole: 'AGENT', newRole: 'ADMIN' }),
    ).toBe('CANNOT_GRANT_ROLE');
    expect(canGrantRole('ADMIN', 'AGENT')).toBe(true);
    expect(canGrantRole('ADMIN', 'ADMIN')).toBe(false);
    expect(canGrantRole('ADMIN', 'OWNER')).toBe(false);
  });

  it('lets AGENT manage nobody', () => {
    expect(checkMemberChange({ actorRole: 'AGENT', actorIsTarget: false, targetRole: 'AGENT' })).toBe('INSUFFICIENT_ROLE');
    for (const r of ROLES) expect(canGrantRole('AGENT', r)).toBe(false);
  });
});
