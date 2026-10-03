import 'server-only';
import { z } from 'zod';
import { emitDomainEvent } from '../../../events/domain-events';
import { channels, publish } from '../../../realtime/bus';
import { ticketReference } from '../memory';
import { INTENTS, warmer } from '../signals';
import { contactFields, preferredContactSchema, saveContactDetails } from './customer-tools';
import { defineTool, ToolError } from './types';

const OPEN_LEAD = ['NEW', 'CONTACTED', 'QUALIFIED', 'PROPOSAL'] as const;
const reference = (prefix: string, id: string) => `${prefix}-${id.slice(-6).toUpperCase()}`;

function requireContact(profile: { email: string | null; phone: string | null }, purpose: string) {
  if (!profile.email && !profile.phone) {
    throw new ToolError(
      'missing_contact',
      `No email or phone number yet. Ask the customer how the team can reach them (${purpose}), then call this tool again.`,
    );
  }
}

export const createLead = defineTool({
  name: 'create_lead',
  status: 'working',
  description:
    'Record a sales lead when the customer shows buying interest (pricing, quote, demo, consultation, implementation) and has shared at least an email or phone number. Calling it again in the same conversation updates the existing lead. Do not ask for all details at once.',
  parameters: z.object({
    requestedService: z.string().trim().min(2).max(200).describe('What the customer is interested in.'),
    message: z.string().trim().max(1000).optional().describe("Short summary of the customer's needs in their words."),
    ...contactFields,
    preferredContact: preferredContactSchema.optional(),
    temperature: z.enum(['COLD', 'WARM', 'HOT']).default('WARM').describe('HOT = ready to buy / wants demo or quote.'),
    intent: z.enum(INTENTS).optional(),
  }),
  async execute(ctx, input) {
    const { profile } = await saveContactDetails(ctx, input);
    requireContact(profile, 'so sales can follow up');

    const data = {
      name: profile.name,
      email: profile.email,
      phone: profile.phone,
      company: profile.company,
      requestedService: input.requestedService,
      message: input.message ?? null,
      preferredContact: input.preferredContact ?? null,
      temperature: input.temperature,
      intent: input.intent ?? null,
    };
    const existing = await ctx.db.lead.findFirst({
      where: { conversationId: ctx.conversation.id, status: { in: [...OPEN_LEAD] } },
      orderBy: { createdAt: 'desc' },
    });
    const lead = existing
      ? await ctx.db.lead.update({
          where: { id: existing.id },
          data: { ...data, temperature: warmer(existing.temperature, input.temperature) ?? input.temperature },
        })
      : await ctx.db.lead.create({
          data: {
            ...data,
            organizationId: ctx.organizationId,
            customerId: ctx.customerId,
            conversationId: ctx.conversation.id,
            source: ctx.conversation.channel,
          },
        });

    const temperature = warmer(ctx.conversation.leadTemperature, lead.temperature);
    await ctx.db.conversation.update({ where: { id: ctx.conversation.id }, data: { leadTemperature: temperature } });
    ctx.conversation.leadTemperature = temperature;
    await publish(channels.inbox(ctx.organizationId), {
      type: existing ? 'lead.updated' : 'lead.created',
      leadId: lead.id,
      conversationId: ctx.conversation.id,
    });
    if (!existing) {
      emitDomainEvent({ type: 'lead.created', organizationId: ctx.organizationId, refs: { leadId: lead.id, customerId: ctx.customerId, conversationId: ctx.conversation.id }, data: { channel: ctx.conversation.channel } });
    }
    return {
      status: existing ? 'updated' : 'created',
      reference: reference('L', lead.id),
      savedContact: { email: Boolean(lead.email), phone: Boolean(lead.phone) },
      note: 'Saved for the sales team, who will follow up. Do not promise a specific response time unless the knowledge base states one.',
    };
  },
});

export const createSupportTicket = defineTool({
  name: 'create_support_ticket',
  status: 'working',
  description:
    'Open a support ticket for a problem the team must follow up on (bug, account problem, failed delivery, anything you cannot solve in chat). Calling it again in the same conversation adds to the open ticket.',
  parameters: z.object({
    subject: z.string().trim().min(3).max(140),
    description: z.string().trim().min(3).max(2000).describe('What happened, steps, error messages — from the customer.'),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
  }),
  async execute(ctx, input) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const existing = await ctx.db.ticket.findFirst({
      where: { conversationId: ctx.conversation.id, status: { in: ['OPEN', 'IN_PROGRESS'] }, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
    });
    const ticket = existing
      ? await ctx.db.ticket.update({
          where: { id: existing.id },
          data: {
            description: `${existing.description ?? ''}\n\n${input.description}`.trim().slice(0, 8000),
            priority: input.priority,
          },
        })
      : await ctx.db.ticket.create({
          data: {
            organizationId: ctx.organizationId,
            customerId: ctx.customerId,
            conversationId: ctx.conversation.id,
            subject: input.subject,
            description: input.description,
            priority: input.priority,
          },
        });
    await publish(channels.inbox(ctx.organizationId), {
      type: existing ? 'ticket.updated' : 'ticket.created',
      ticketId: ticket.id,
      conversationId: ctx.conversation.id,
    });
    if (!existing) {
      emitDomainEvent({ type: 'ticket.created', organizationId: ctx.organizationId, refs: { ticketId: ticket.id, customerId: ctx.customerId, conversationId: ctx.conversation.id }, data: { channel: ctx.conversation.channel } });
    }
    return {
      status: existing ? 'updated' : 'created',
      reference: ticketReference(ticket.id),
      priority: ticket.priority,
      note: 'Share the reference with the customer. The team handles it; do not promise a resolution time unless the knowledge base states one.',
    };
  },
});

export const scheduleAppointment = defineTool({
  name: 'schedule_appointment',
  status: 'working',
  description:
    'Record an appointment request (demo, consultation, call) with the times the customer prefers. This does NOT book anything: the team confirms the time afterwards. Requires an email or phone number. Calling it again updates the open request.',
  parameters: z.object({
    topic: z.string().trim().min(2).max(200),
    preferredTime: z.string().trim().min(2).max(300).describe("The customer's preferred day(s)/time(s), in their words."),
    notes: z.string().trim().max(1000).optional(),
    ...contactFields,
  }),
  async execute(ctx, input) {
    const { profile } = await saveContactDetails(ctx, input);
    requireContact(profile, 'to confirm the appointment');
    const existing = await ctx.db.appointment.findFirst({
      where: { conversationId: ctx.conversation.id, status: 'REQUESTED' },
      orderBy: { createdAt: 'desc' },
    });
    const data = {
      topic: input.topic,
      preferredTime: input.preferredTime,
      notes: input.notes ?? null,
      contactName: profile.name,
      email: profile.email,
      phone: profile.phone,
    };
    const appointment = existing
      ? await ctx.db.appointment.update({ where: { id: existing.id }, data })
      : await ctx.db.appointment.create({
          data: { ...data, organizationId: ctx.organizationId, customerId: ctx.customerId, conversationId: ctx.conversation.id },
        });
    await publish(channels.inbox(ctx.organizationId), {
      type: existing ? 'appointment.updated' : 'appointment.requested',
      appointmentId: appointment.id,
      conversationId: ctx.conversation.id,
    });
    if (!existing) {
      emitDomainEvent({ type: 'appointment.requested', organizationId: ctx.organizationId, refs: { appointmentId: appointment.id, customerId: ctx.customerId, conversationId: ctx.conversation.id }, data: { channel: ctx.conversation.channel } });
    }
    return {
      status: 'requested',
      confirmed: false,
      reference: reference('A', appointment.id),
      note: `Request recorded, NOT booked. Tell the customer the team will confirm the time via ${profile.email ? 'email' : 'phone'}.`,
    };
  },
});
