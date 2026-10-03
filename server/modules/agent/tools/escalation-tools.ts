import 'server-only';
import { z } from 'zod';
import { isWithinBusinessHours, nextOpening } from '@/lib/business-hours';
import { lookupOrder, OrderLookupUnavailableError } from '../../../integrations/order-lookup';
import { saveSummary } from '../memory';
import { assertCustomerProvided } from './customer-tools';
import { defineTool, ToolError } from './types';

export const getOrderStatus = defineTool({
  name: 'get_order_status',
  status: 'searching',
  description:
    "Look up the status of the customer's order. Needs the order number AND the email used for the order, both written by the customer. Report only what this returns; never guess a status or delivery date.",
  parameters: z.object({
    orderNumber: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9#_-]{2,64}$/, 'Invalid order number')
      .describe('Order number as the customer wrote it.'),
    email: z.string().trim().toLowerCase().email().max(200),
  }),
  isAvailable: (ctx) => ctx.orderLookup !== null,
  async execute(ctx, { orderNumber, email }) {
    const customer = await ctx.db.customer.findUniqueOrThrow({ where: { id: ctx.customerId }, select: { email: true } });
    await assertCustomerProvided(ctx, 'email', email, customer.email);
    if (!ctx.orderLookup) throw new ToolError('not_configured', 'Order lookup is not available.');
    try {
      const order = await lookupOrder(ctx.orderLookup, orderNumber.replace(/^#/, ''), email);
      if (!order) {
        return {
          found: false,
          note: 'No order matches this number and email. Ask the customer to double-check both; do not reveal anything else.',
        };
      }
      return { found: true, order };
    } catch (err) {
      if (err instanceof OrderLookupUnavailableError) {
        throw new ToolError('order_system_unavailable', 'The order system is not reachable right now. Apologize and offer a support ticket or the team.');
      }
      throw err;
    }
  },
});

const HANDOFF_REASONS = ['customer_request', 'angry', 'complaint', 'legal', 'payment', 'technical', 'safety', 'low_confidence', 'other'] as const;

export const requestHumanAgent = defineTool({
  name: 'request_human_agent',
  status: 'working',
  description:
    'Hand the conversation to a human team member. Use when the customer asks for a person, is upset, raises a serious complaint, a legal, payment or safety issue, needs complex technical help, or when you are not confident you can answer correctly.',
  parameters: z.object({
    reason: z.enum(HANDOFF_REASONS),
    summary: z.string().trim().min(3).max(600).describe('Brief context for the team member taking over.'),
  }),
  isAvailable: (ctx) => ctx.bot.escalationBehavior !== 'DISABLED',
  async execute(ctx, { reason, summary }) {
    // SUGGEST mode: only a direct customer request hands over; otherwise offer a button.
    if (ctx.bot.escalationBehavior === 'SUGGEST' && reason !== 'customer_request') {
      ctx.suggestHandoff = true;
      return {
        status: 'suggested',
        note: 'A "Talk to a human" button is shown under your reply. Let the customer know they can use it, and keep helping meanwhile.',
      };
    }
    const now = new Date();
    const online = isWithinBusinessHours(ctx.businessHours, ctx.timeZone, now);
    const next = online ? null : nextOpening(ctx.businessHours, ctx.timeZone, now);
    ctx.handoff = { reason, note: summary };
    return online
      ? {
          status: 'handoff_requested',
          teamOnline: true,
          note: 'A team member will join this chat shortly. Tell the customer briefly; a system notice follows your reply.',
        }
      : {
          status: 'handoff_requested',
          teamOnline: false,
          teamBackAt: next
            ? new Intl.DateTimeFormat('en-GB', { timeZone: ctx.timeZone, weekday: 'long', hour: '2-digit', minute: '2-digit' }).format(next)
            : null,
          note: 'The team is offline; the request is recorded for follow-up. Tell the customer when the team is back and keep helping if you can.',
        };
  },
});

export const saveConversationSummary = defineTool({
  name: 'save_conversation_summary',
  status: 'working',
  description:
    "Save a short summary of this conversation for the team (needs, what was answered, what is open). Use before a handoff or once a complex request is clear. Summaries are also created automatically, so don't call this every turn.",
  parameters: z.object({
    summary: z.string().trim().min(10).max(1500),
  }),
  async execute(ctx, { summary }) {
    const last = await ctx.db.message.findFirst({
      where: { conversationId: ctx.conversation.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    await saveSummary(ctx.db, {
      organizationId: ctx.organizationId,
      conversationId: ctx.conversation.id,
      summary,
      lastMessageId: last?.id ?? null,
    });
    return { status: 'saved' };
  },
});
