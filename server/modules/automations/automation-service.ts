import 'server-only';
import type { Automation, Prisma } from '@prisma/client';
import { parseActions, parseConditions, type AutomationInput } from '@/lib/automations';
import { hasPermission } from '@/lib/permissions';
import type { ServiceContext } from '../../context';
import { AppError, forbidden, notFound } from '../../errors';
import { auditFromContext } from '../audit/audit-service';

const MAX_AUTOMATIONS = 50;

function assertCanManage(ctx: ServiceContext) {
  if (!hasPermission(ctx.role, 'automations:manage')) throw forbidden();
}

function serialize(a: Automation & { runs?: { status: string; createdAt: Date }[] }) {
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    trigger: a.trigger,
    conditions: parseConditions(a.conditions),
    actions: parseActions(a.actions),
    isActive: a.isActive,
    runCount: a.runCount,
    lastRunAt: a.lastRunAt?.toISOString() ?? null,
    lastRunStatus: a.runs?.[0]?.status ?? null,
    createdAt: a.createdAt.toISOString(),
  };
}
export type AutomationDto = ReturnType<typeof serialize>;

/** References inside actions must point into this workspace. */
async function assertReferences(ctx: ServiceContext, input: AutomationInput) {
  for (const action of input.actions) {
    if (action.type === 'TRIGGER_WEBHOOK' && !(await ctx.db.webhookEndpoint.findUnique({ where: { id: action.endpointId }, select: { id: true } }))) {
      throw new AppError('VALIDATION_FAILED', 'The selected webhook endpoint does not exist.', { actions: ['Choose an existing webhook endpoint'] });
    }
    if (action.type === 'ASSIGN_AGENT' && action.mode === 'user' && !(await ctx.db.membership.findFirst({ where: { userId: action.userId }, select: { id: true } }))) {
      throw new AppError('VALIDATION_FAILED', 'The selected team member is not in this workspace.', { actions: ['Choose a team member'] });
    }
  }
}

export async function listAutomations(ctx: ServiceContext) {
  assertCanManage(ctx);
  const rows = await ctx.db.automation.findMany({
    orderBy: { createdAt: 'asc' },
    include: { runs: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true, createdAt: true } } },
  });
  return rows.map(serialize);
}

export async function createAutomation(ctx: ServiceContext, input: AutomationInput) {
  assertCanManage(ctx);
  if ((await ctx.db.automation.count()) >= MAX_AUTOMATIONS) throw new AppError('BAD_REQUEST', `A workspace can have up to ${MAX_AUTOMATIONS} automations.`);
  await assertReferences(ctx, input);
  const row = await ctx.db.automation.create({
    data: {
      organizationId: ctx.organizationId,
      name: input.name,
      description: input.description,
      trigger: input.trigger,
      conditions: input.conditions as Prisma.InputJsonValue,
      actions: input.actions as Prisma.InputJsonValue,
      isActive: input.isActive,
    },
  });
  await auditFromContext(ctx, 'automation.created', { type: 'Automation', id: row.id }, { name: input.name, trigger: input.trigger });
  return serialize(row);
}

async function find(ctx: ServiceContext, id: string) {
  const row = await ctx.db.automation.findUnique({ where: { id } });
  if (!row) throw notFound('Automation');
  return row;
}

export async function updateAutomation(ctx: ServiceContext, id: string, input: AutomationInput) {
  assertCanManage(ctx);
  await find(ctx, id);
  await assertReferences(ctx, input);
  const row = await ctx.db.automation.update({
    where: { id },
    data: {
      name: input.name,
      description: input.description,
      trigger: input.trigger,
      conditions: input.conditions as Prisma.InputJsonValue,
      actions: input.actions as Prisma.InputJsonValue,
      isActive: input.isActive,
    },
  });
  await auditFromContext(ctx, 'automation.updated', { type: 'Automation', id }, { name: input.name });
  return serialize(row);
}

export async function setAutomationActive(ctx: ServiceContext, id: string, isActive: boolean) {
  assertCanManage(ctx);
  await find(ctx, id);
  const row = await ctx.db.automation.update({ where: { id }, data: { isActive } });
  await auditFromContext(ctx, isActive ? 'automation.enabled' : 'automation.disabled', { type: 'Automation', id });
  return serialize(row);
}

export async function deleteAutomation(ctx: ServiceContext, id: string) {
  assertCanManage(ctx);
  const row = await find(ctx, id);
  await ctx.db.automation.delete({ where: { id } });
  await auditFromContext(ctx, 'automation.deleted', { type: 'Automation', id }, { name: row.name });
}

export async function listAutomationRuns(ctx: ServiceContext, automationId: string, limit = 30) {
  assertCanManage(ctx);
  await find(ctx, automationId);
  const runs = await ctx.db.automationRun.findMany({ where: { automationId }, orderBy: { createdAt: 'desc' }, take: Math.min(limit, 100) });
  return runs.map((r) => ({
    id: r.id,
    eventType: r.eventType,
    status: r.status,
    conversationId: r.conversationId,
    results: r.results as { type: string; ok: boolean; skipped?: boolean; detail: string }[],
    error: r.error,
    durationMs: r.durationMs,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Options for the builder: team members and webhook endpoints. */
export async function automationBuilderOptions(ctx: ServiceContext) {
  assertCanManage(ctx);
  const [members, endpoints] = await Promise.all([
    ctx.db.membership.findMany({ orderBy: { createdAt: 'asc' }, select: { userId: true, role: true, user: { select: { name: true, email: true } } } }),
    ctx.db.webhookEndpoint.findMany({ orderBy: { createdAt: 'asc' }, select: { id: true, url: true, description: true, isActive: true } }),
  ]);
  return {
    members: members.map((m) => ({ userId: m.userId, role: m.role, name: m.user.name ?? m.user.email })),
    endpoints: endpoints.map((e) => ({ id: e.id, label: e.description || new URL(e.url).host, isActive: e.isActive })),
  };
}
