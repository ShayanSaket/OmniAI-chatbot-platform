import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { GLOBAL_MODELS, scopeArgs, TENANT_MODELS, TenantViolationError } from '@/server/tenancy/scope';

const ORG = 'org_a';
const OTHER = 'org_b';

describe('tenant model classification', () => {
  it('classifies every Prisma model exactly once (fail-closed for new models)', () => {
    const models = Object.values(Prisma.ModelName).filter((m) => m !== 'Organization');
    for (const model of models) {
      expect(TENANT_MODELS.has(model) !== GLOBAL_MODELS.has(model), `${model} must be tenant XOR global`).toBe(true);
    }
  });

  it('classifies tenant models as exactly those with a required organizationId', () => {
    for (const model of Prisma.dmmf.datamodel.models) {
      if (model.name === 'Organization') continue;
      const orgId = model.fields.find((f) => f.name === 'organizationId');
      expect(TENANT_MODELS.has(model.name), model.name).toBe(Boolean(orgId?.isRequired));
      // An optional organizationId (routing info on system tables, e.g. inbound webhook
      // events) is only allowed on models deliberately declared global.
      if (orgId && !orgId.isRequired) expect(GLOBAL_MODELS.has(model.name), model.name).toBe(true);
    }
  });

  it('rejects unknown models', () => {
    expect(() => scopeArgs('BrandNewModel', 'findMany', {}, ORG)).toThrow(TenantViolationError);
  });
});

describe('scopeArgs', () => {
  it('injects organizationId into reads', () => {
    for (const op of ['findMany', 'findFirst', 'findUnique', 'count', 'aggregate', 'groupBy']) {
      expect(scopeArgs('Customer', op, { where: { email: 'x@y.z' } }, ORG)).toEqual({
        where: { email: 'x@y.z', organizationId: ORG },
      });
    }
  });

  it('adds a where clause when none is given', () => {
    expect(scopeArgs('Lead', 'findMany', undefined, ORG)).toEqual({ where: { organizationId: ORG } });
  });

  it('rejects reads that target another organization', () => {
    expect(() => scopeArgs('Customer', 'findMany', { where: { organizationId: OTHER } }, ORG)).toThrow(TenantViolationError);
    expect(() =>
      scopeArgs('Customer', 'findMany', { where: { organizationId: { in: [ORG, OTHER] } } }, ORG),
    ).toThrow(TenantViolationError);
  });

  it('scopes updates and deletes and forbids moving rows between tenants', () => {
    expect(scopeArgs('Conversation', 'update', { where: { id: 'c1' }, data: { status: 'CLOSED' } }, ORG)).toEqual({
      where: { id: 'c1', organizationId: ORG },
      data: { status: 'CLOSED' },
    });
    expect(scopeArgs('Message', 'deleteMany', { where: {} }, ORG)).toEqual({ where: { organizationId: ORG } });
    expect(() =>
      scopeArgs('Conversation', 'update', { where: { id: 'c1' }, data: { organizationId: OTHER } }, ORG),
    ).toThrow(TenantViolationError);
    expect(() =>
      scopeArgs('Conversation', 'updateMany', { where: {}, data: { organization: { connect: { id: OTHER } } } }, ORG),
    ).toThrow(TenantViolationError);
  });

  it('stamps organizationId on creates', () => {
    expect(scopeArgs('Tag', 'create', { data: { name: 'VIP' } }, ORG)).toEqual({ data: { name: 'VIP', organizationId: ORG } });
    expect(scopeArgs('Tag', 'createMany', { data: [{ name: 'a' }, { name: 'b' }] }, ORG)).toEqual({
      data: [
        { name: 'a', organizationId: ORG },
        { name: 'b', organizationId: ORG },
      ],
    });
    expect(() => scopeArgs('Tag', 'create', { data: { name: 'x', organizationId: OTHER } }, ORG)).toThrow(TenantViolationError);
    expect(() =>
      scopeArgs('Tag', 'create', { data: { name: 'x', organization: { connect: { id: OTHER } } } }, ORG),
    ).toThrow(TenantViolationError);
  });

  it('scopes upserts on both sides', () => {
    expect(
      scopeArgs('Tag', 'upsert', { where: { id: 't1' }, create: { name: 'a' }, update: { name: 'b' } }, ORG),
    ).toEqual({
      where: { id: 't1', organizationId: ORG },
      create: { name: 'a', organizationId: ORG },
      update: { name: 'b' },
    });
  });

  it('restricts Organization access to the current tenant', () => {
    expect(scopeArgs('Organization', 'findUnique', { where: { id: ORG } }, ORG)).toEqual({ where: { id: ORG } });
    expect(() => scopeArgs('Organization', 'findUnique', { where: { id: OTHER } }, ORG)).toThrow(TenantViolationError);
    expect(() => scopeArgs('Organization', 'findMany', {}, ORG)).toThrow(TenantViolationError);
    expect(() => scopeArgs('Organization', 'delete', { where: { id: ORG } }, ORG)).toThrow(TenantViolationError);
    expect(() => scopeArgs('Organization', 'update', { where: { id: ORG }, data: { id: 'x' } }, ORG)).toThrow(TenantViolationError);
  });

  it('passes global models through untouched', () => {
    const args = { where: { email: 'a@b.c' } };
    expect(scopeArgs('User', 'findUnique', args, ORG)).toBe(args);
  });

  it('does not mutate the caller arguments', () => {
    const args = { where: { email: 'x' } };
    scopeArgs('Customer', 'findMany', args, ORG);
    expect(args).toEqual({ where: { email: 'x' } });
  });
});
