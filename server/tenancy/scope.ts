// Pure query-argument scoping used by the tenant Prisma client. Kept free of Prisma
// runtime imports so it is trivially unit-testable.

/** Models that carry `organizationId`. */
export const TENANT_MODELS = new Set([
  'Membership',
  'BotConfiguration',
  'PromptConfiguration',
  'BusinessHours',
  'Channel',
  'WhatsAppAccount',
  'Customer',
  'CustomerIdentity',
  'CustomerNote',
  'Tag',
  'CustomerTag',
  'Conversation',
  'ConversationAssignment',
  'Message',
  'ConversationSummary',
  'Lead',
  'Ticket',
  'KnowledgeDocument',
  'KnowledgeChunk',
  'ToolExecution',
  'UsageRecord',
  'AuditLog',
  'Automation',
  'Integration',
  'Product',
  'Appointment',
  'WhatsAppTemplate',
  'AutomationRun',
  'Notification',
  'InsightReport',
  'WebhookEndpoint',
  'WebhookDelivery',
]);

/** Models that are not tenant-owned and pass through unchanged. */
export const GLOBAL_MODELS = new Set(['User', 'InboundWebhookEvent', 'EmbeddingCache']);

const WHERE_OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
]);

const ORGANIZATION_ALLOWED_OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'update',
]);

export class TenantViolationError extends Error {
  constructor(message: string) {
    super(`Tenant isolation violation: ${message}`);
    this.name = 'TenantViolationError';
  }
}

type Args = Record<string, unknown> | undefined;
type Data = Record<string, unknown>;

function scopeWhere(where: unknown, key: string, organizationId: string, model: string): Data {
  const w = { ...((where as Data | undefined) ?? {}) };
  if (key in w && w[key] !== organizationId) {
    throw new TenantViolationError(`${model}.where.${key} targets another organization`);
  }
  w[key] = organizationId;
  return w;
}

function scopeCreateData(data: unknown, organizationId: string, model: string): Data {
  const d = { ...((data as Data | undefined) ?? {}) };
  if ('organization' in d) {
    throw new TenantViolationError(`${model}: use the organizationId scalar, not the organization relation`);
  }
  if ('organizationId' in d && d.organizationId !== organizationId) {
    throw new TenantViolationError(`${model}.data.organizationId targets another organization`);
  }
  d.organizationId = organizationId;
  return d;
}

function assertUpdateData(data: unknown, organizationId: string, model: string) {
  const d = (data as Data | undefined) ?? {};
  if ('organization' in d || ('organizationId' in d && d.organizationId !== organizationId)) {
    throw new TenantViolationError(`${model}: rows cannot be moved to another organization`);
  }
}

/**
 * Returns a copy of `args` constrained to `organizationId`.
 * Throws TenantViolationError for anything that could cross tenants, and for
 * unknown models (fail closed when a new model is added without classifying it).
 */
export function scopeArgs(model: string, operation: string, args: Args, organizationId: string): Args {
  if (GLOBAL_MODELS.has(model)) return args;

  if (model === 'Organization') {
    if (!ORGANIZATION_ALLOWED_OPS.has(operation)) {
      throw new TenantViolationError(`Organization.${operation} is not allowed through a tenant client`);
    }
    if (operation === 'update') assertNoIdChange(args);
    return { ...(args ?? {}), where: scopeWhere(args?.where, 'id', organizationId, model) };
  }

  if (!TENANT_MODELS.has(model)) {
    throw new TenantViolationError(`model ${model} is not classified as tenant or global`);
  }

  const next: Data = { ...(args ?? {}) };

  if (WHERE_OPS.has(operation)) {
    next.where = scopeWhere(next.where, 'organizationId', organizationId, model);
    if (operation.startsWith('update')) assertUpdateData(next.data, organizationId, model);
    return next;
  }

  switch (operation) {
    case 'create':
      next.data = scopeCreateData(next.data, organizationId, model);
      return next;
    case 'createMany':
    case 'createManyAndReturn': {
      const rows = Array.isArray(next.data) ? next.data : [next.data];
      next.data = rows.map((row) => scopeCreateData(row, organizationId, model));
      return next;
    }
    case 'upsert':
      next.where = scopeWhere(next.where, 'organizationId', organizationId, model);
      next.create = scopeCreateData(next.create, organizationId, model);
      assertUpdateData(next.update, organizationId, model);
      return next;
    default:
      throw new TenantViolationError(`operation ${model}.${operation} is not supported by the tenant client`);
  }
}

function assertNoIdChange(args: Args) {
  const data = (args?.data as Data | undefined) ?? {};
  if ('id' in data) throw new TenantViolationError('Organization id cannot be changed');
}
