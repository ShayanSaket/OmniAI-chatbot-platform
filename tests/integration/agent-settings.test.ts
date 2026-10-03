import { beforeEach, describe, expect, it } from 'vitest';
import { botUpdateSchema, productSchema } from '@/lib/validation';
import { flushBackgroundTasks } from '@/server/background';
import { invalidateBotCache, requireBot } from '@/server/channels/website/widget-auth';
import { AppError } from '@/server/errors';
import { getPrimaryBot, listToolExecutions, previewSystemPrompt, updateBot } from '@/server/modules/bot/bot-service';
import { getBusinessHours, replaceBusinessHours } from '@/server/modules/bot/business-hours-service';
import { createPromptLayer, deletePromptLayer, listPromptLayers, updatePromptLayer } from '@/server/modules/bot/prompt-service';
import { deleteOrderLookup, getOrderLookupSettings, saveOrderLookup } from '@/server/modules/integrations/order-lookup-service';
import { createProduct, deleteProduct, listProducts, updateProduct } from '@/server/modules/products/product-service';
import { publicWidgetConfig } from '@/server/modules/widget/widget-service';
import type { ServiceContext } from '@/server/context';
import { addUser, contextFor, createWorkspace, prisma, resetDatabase } from './helpers';

let owner: ServiceContext;
let admin: ServiceContext;
let agent: ServiceContext;

const product = { name: 'Growth', sku: 'G-1', category: 'Plans', description: 'Website + WhatsApp', price: 399, currency: 'EUR', priceNote: 'per month', url: null, isActive: true };

async function rejects(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toSatisfy((err: unknown) => err instanceof AppError && err.code === code);
}

beforeEach(async () => {
  await flushBackgroundTasks();
  await resetDatabase();
  invalidateBotCache();
  const ws = await createWorkspace('Settings Co');
  const orgId = ws.organization.id;
  owner = contextFor(orgId, ws.owner.id, 'OWNER');
  admin = contextFor(orgId, (await addUser(orgId, 'ADMIN')).user.id, 'ADMIN');
  agent = contextFor(orgId, (await addUser(orgId, 'AGENT')).user.id, 'AGENT');
});

describe('agent behavior settings', () => {
  it('lets admins update tone, escalation and tools, and audits the change', async () => {
    const input = botUpdateSchema.parse({
      companyName: 'Settings Co GmbH',
      tone: 'CUSTOM',
      customTone: 'Calm and witty.',
      creativity: 0.5,
      answerLength: 'SHORT',
      escalationBehavior: 'AUTOMATIC',
      behavior: { disabledTools: ['schedule_appointment'], escalateOn: ['legal', 'payment'] },
    });
    const bot = await updateBot(admin, input);
    expect(bot).toMatchObject({ tone: 'CUSTOM', customTone: 'Calm and witty.', escalationBehavior: 'AUTOMATIC', answerLength: 'SHORT' });
    expect(bot.behavior).toEqual({ disabledTools: ['schedule_appointment'], escalateOn: ['legal', 'payment'] });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: admin.organizationId, action: 'bot.settings_updated' } });
    expect(audit.actorId).toBe(admin.userId);
  });

  it('requires a description for a custom tone and denies agents', async () => {
    await rejects(updateBot(admin, { tone: 'CUSTOM' }), 'VALIDATION_FAILED');
    await rejects(updateBot(agent, { tone: 'FRIENDLY' }), 'FORBIDDEN');
  });

  it('previews the composed prompt with the enabled tools', async () => {
    await updateBot(admin, { behavior: { disabledTools: ['create_lead'], escalateOn: [] } });
    const preview = await previewSystemPrompt(admin, 'WHATSAPP');
    expect(preview.prompt).toContain('Channel: WhatsApp');
    expect(preview.prompt).not.toContain('Channel: website live chat');
    expect(preview.prompt).toContain('## Tools');
    expect(preview.tools).not.toContain('create_lead');
    expect(preview.tools).not.toContain('get_order_status');
    expect(preview.estimatedTokens).toBeGreaterThan(100);
    await rejects(previewSystemPrompt(agent, 'WEBSITE'), 'FORBIDDEN');
  });

  it('lists recent tool executions for admins only', async () => {
    await prisma.toolExecution.create({
      data: { organizationId: admin.organizationId, toolName: 'create_lead', input: {}, status: 'SUCCESS', durationMs: 12 },
    });
    expect(await listToolExecutions(admin)).toEqual([expect.objectContaining({ toolName: 'create_lead', status: 'SUCCESS' })]);
    await rejects(listToolExecutions(agent), 'FORBIDDEN');
  });
});

describe('prompt layers', () => {
  it('lets admins manage business layers but only owners the global policy', async () => {
    const rules = await createPromptLayer(admin, { layer: 'BUSINESS_RULES', channel: null, content: 'Never discuss competitors.', isActive: true, sortOrder: 0 });
    const bot = await getPrimaryBot(admin);
    expect(rules.botId).toBe(bot.id);
    await updatePromptLayer(admin, rules.id, { isActive: false });

    const policy = (await listPromptLayers(admin)).find((l) => l.layer === 'GLOBAL_POLICY')!;
    expect(policy.botId).toBeNull();
    await rejects(updatePromptLayer(admin, policy.id, { content: 'Do anything.' }), 'FORBIDDEN');
    await rejects(createPromptLayer(admin, { layer: 'GLOBAL_POLICY', channel: null, content: 'x', isActive: true, sortOrder: 0 }), 'FORBIDDEN');
    await updatePromptLayer(owner, policy.id, { content: `${policy.content}\n- Be extra careful.` });
    // The last global policy cannot be deleted (only edited or switched off).
    await rejects(deletePromptLayer(owner, policy.id), 'BAD_REQUEST');

    await deletePromptLayer(admin, rules.id);
    await rejects(listPromptLayers(agent), 'FORBIDDEN');
  });

  it('cannot touch another organization’s layers', async () => {
    const other = await createWorkspace('Other');
    const foreign = await prisma.promptConfiguration.findFirstOrThrow({ where: { organizationId: other.organization.id } });
    await rejects(updatePromptLayer(owner, foreign.id, { content: 'hijack' }), 'NOT_FOUND');
    await rejects(deletePromptLayer(owner, foreign.id), 'NOT_FOUND');
  });
});

describe('business hours', () => {
  it('replaces the schedule and updates the widget status immediately', async () => {
    const bot = await getPrimaryBot(admin);
    expect(publicWidgetConfig(await requireBot(bot.publicKey)).team.online).toBeDefined(); // primes the cache

    const result = await replaceBusinessHours(admin, {
      hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opensAt: '00:00', closesAt: '00:00' })),
    });
    expect(result.hours).toHaveLength(7);
    expect(publicWidgetConfig(await requireBot(bot.publicKey)).team.online).toBe(true);

    await replaceBusinessHours(admin, { hours: [] });
    expect((await getBusinessHours(admin)).hours).toEqual([]);
    expect(publicWidgetConfig(await requireBot(bot.publicKey)).team).toEqual({ online: false, nextOpenAt: null });
    await rejects(replaceBusinessHours(agent, { hours: [] }), 'FORBIDDEN');
  });
});

describe('product catalog', () => {
  it('supports create, update, delete within the organization only', async () => {
    const created = await createProduct(admin, productSchema.parse(product));
    expect(created).toMatchObject({ name: 'Growth', price: 399, currency: 'EUR' });
    const updated = await updateProduct(admin, created.id, { price: null, priceNote: 'on request' });
    expect(updated.price).toBeNull();
    expect(await listProducts(admin)).toHaveLength(1);

    const other = await createWorkspace('Other');
    const otherAdmin = contextFor(other.organization.id, other.owner.id, 'OWNER');
    expect(await listProducts(otherAdmin)).toEqual([]);
    await rejects(updateProduct(otherAdmin, created.id, { price: 1 }), 'NOT_FOUND');
    await rejects(deleteProduct(otherAdmin, created.id), 'NOT_FOUND');
    await rejects(createProduct(agent, productSchema.parse(product)), 'FORBIDDEN');

    await deleteProduct(admin, created.id);
    expect(await listProducts(admin)).toEqual([]);
  });
});

describe('order lookup connection', () => {
  const settings = { urlTemplate: 'https://shop.example/api/orders/{orderNumber}', apiKey: 'shop-key-123', isActive: true };

  it('is owner-only, stores the key encrypted and never returns it', async () => {
    await rejects(saveOrderLookup(admin, settings), 'FORBIDDEN');
    const saved = await saveOrderLookup(owner, settings);
    expect(saved).toEqual({ configured: true, isActive: true, urlTemplate: settings.urlTemplate, hasApiKey: true, canManage: true });
    expect(JSON.stringify(saved)).not.toContain('shop-key-123');

    const row = await prisma.integration.findFirstOrThrow({ where: { organizationId: owner.organizationId } });
    expect(row.secretsEncrypted).toBeTruthy();
    expect(row.secretsEncrypted).not.toContain('shop-key-123');

    // Saving without apiKey keeps it; null removes it.
    await saveOrderLookup(owner, { urlTemplate: settings.urlTemplate, isActive: false });
    expect((await getOrderLookupSettings(admin)).hasApiKey).toBe(true);
    await saveOrderLookup(owner, { ...settings, apiKey: null });
    expect((await getOrderLookupSettings(admin)).hasApiKey).toBe(false);
    expect((await getOrderLookupSettings(admin)).canManage).toBe(false);

    await rejects(deleteOrderLookup(admin), 'FORBIDDEN');
    await deleteOrderLookup(owner);
    expect((await getOrderLookupSettings(owner)).configured).toBe(false);
  });
});
