import 'server-only';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { SUPPORTED_LANGUAGES } from '@/lib/validation';
import { channels, publish } from '../../../realtime/bus';
import { loadCustomerContext, mergeMemory, parseCustomerMemory } from '../memory';
import { defineTool, ToolError, type ToolContext } from './types';

const languageCodes = SUPPORTED_LANGUAGES.map((l) => l.code) as [string, ...string[]];

export const contactFields = {
  name: z.string().trim().min(1).max(100).optional().describe("Customer's name, as they wrote it."),
  email: z.string().trim().toLowerCase().email().max(200).optional().describe('Email exactly as the customer wrote it.'),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9][0-9 ()/-]{5,24}$/, 'Invalid phone number')
    .optional()
    .describe('Phone number exactly as the customer wrote it.'),
  company: z.string().trim().min(1).max(120).optional(),
};

export const preferredContactSchema = z.enum(['email', 'phone', 'whatsapp']);

const digits = (s: string) => s.replace(/\D/g, '');
const phoneCore = (s: string) => digits(s).replace(/^00/, '').replace(/^0/, '').slice(-8);

/**
 * Contact details must come from the customer, never from the model's imagination:
 * the value has to be on the profile already or appear in the customer's own messages.
 */
export async function assertCustomerProvided(ctx: ToolContext, field: 'email' | 'phone', value: string, known: string | null) {
  if (field === 'email') {
    if (known && known.toLowerCase() === value.toLowerCase()) return;
    if ((await ctx.customerTranscript()).toLowerCase().includes(value.toLowerCase())) return;
  } else {
    const core = phoneCore(value);
    if (known && phoneCore(known) === core) return;
    const numbers = (await ctx.customerTranscript()).match(/\+?\d[\d ()/-]{4,}\d/g) ?? [];
    if (core.length >= 6 && numbers.some((n) => phoneCore(n) === core)) return;
  }
  throw new ToolError(
    'unverified_contact',
    `The customer has not written this ${field} in the conversation. Ask the customer for their ${field} instead of assuming one.`,
  );
}

/**
 * Validates and saves contact details on the current customer. Returns the profile
 * after the update and the fields that changed.
 */
export async function saveContactDetails(
  ctx: ToolContext,
  input: { name?: string; email?: string; phone?: string; company?: string; language?: string },
) {
  const customer = await ctx.db.customer.findUniqueOrThrow({
    where: { id: ctx.customerId },
    select: { name: true, email: true, phone: true, company: true, language: true, isAnonymous: true },
  });
  if (input.email) await assertCustomerProvided(ctx, 'email', input.email, customer.email);
  if (input.phone) await assertCustomerProvided(ctx, 'phone', input.phone, customer.phone);

  const data: Prisma.CustomerUpdateInput = {};
  const changed: string[] = [];
  for (const key of ['name', 'email', 'phone', 'company', 'language'] as const) {
    const value = input[key];
    if (value && value !== customer[key]) {
      data[key] = value;
      changed.push(key);
    }
  }
  if ((input.email || input.phone) && customer.isAnonymous) data.isAnonymous = false;
  if (Object.keys(data).length) {
    await ctx.db.customer.update({ where: { id: ctx.customerId }, data });
    await publish(channels.inbox(ctx.organizationId), { type: 'customer.updated', customerId: ctx.customerId });
  }
  return {
    profile: {
      name: input.name ?? customer.name,
      email: input.email ?? customer.email,
      phone: input.phone ?? customer.phone,
      company: input.company ?? customer.company,
    },
    changed,
  };
}

export const getCustomerProfile = defineTool({
  name: 'get_customer_profile',
  status: 'searching',
  description:
    "Read the current customer's saved profile: contact details, interests, open sales requests, open tickets and appointments. Only this customer — there is no way to look up anyone else.",
  parameters: z.object({}),
  async execute(ctx) {
    const c = await loadCustomerContext(ctx.db, ctx.customerId);
    return {
      profile: c.profile,
      interests: c.memory.productInterests,
      preferences: c.memory.preferences,
      knownFacts: c.memory.facts,
      previousConversations: c.previousSummary,
      openSalesRequests: c.openLeads,
      openTickets: c.openTickets,
      appointments: c.appointments,
    };
  },
});

export const updateCustomerProfile = defineTool({
  name: 'update_customer_profile',
  status: 'working',
  description:
    'Save contact details or preferences the customer shared (name, email, phone, company, language, preferred contact channel). Only pass values the customer actually wrote.',
  parameters: z.object({
    ...contactFields,
    language: z.enum(languageCodes).optional().describe('Preferred language (ISO code).'),
    preferredContact: preferredContactSchema.optional(),
  }),
  async execute(ctx, input) {
    const { preferredContact, ...details } = input;
    if (!Object.values(input).some(Boolean)) {
      throw new ToolError('nothing_to_update', 'Pass at least one field the customer shared.');
    }
    const result = await saveContactDetails(ctx, details);
    if (preferredContact) {
      const current = await ctx.db.customer.findUniqueOrThrow({ where: { id: ctx.customerId }, select: { memory: true } });
      const memory = mergeMemory(parseCustomerMemory(current.memory), { preferences: [`Prefers contact via ${preferredContact}`] });
      await ctx.db.customer.update({ where: { id: ctx.customerId }, data: { memory: memory as unknown as Prisma.InputJsonValue } });
      result.changed.push('preferredContact');
    }
    return { status: 'saved', updatedFields: result.changed, profile: result.profile };
  },
});
