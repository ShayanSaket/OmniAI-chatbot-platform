/**
 * Seeds the NovaTech GmbH demo workspace. Idempotent: removes and recreates the demo
 * organization and demo users on every run. Never touches other organizations.
 *
 *   npm run db:seed
 */
import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient, type ChannelType, type Prisma, type SenderType } from '@prisma/client';
import { DEMO_ORG_SLUG, DEMO_PASSWORD } from '../lib/demo';
import { hashPassword } from '../server/auth/password';
import { chunkFaq, chunkText, parseFaqText } from '../server/modules/knowledge/chunker';
import { provisionOrganization } from '../server/modules/organizations/provisioning';
import {
  BUSINESS_IDENTITY,
  BUSINESS_RULES,
  KNOWLEDGE,
  NOVATECH,
  PRODUCTS,
  SCRIPTED,
  SHORT_EXCHANGES,
  TEAM,
  type Line,
  type ScriptedConversation,
} from './seed-data';

const prisma = new PrismaClient();

// Deterministic PRNG so every seed produces the same dataset shape.
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261003);
const between = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
const pick = <T,>(items: readonly T[]) => items[Math.floor(rand() * items.length)]!;

const MODEL = 'gpt-4o-mini';
const costUsd = (prompt: number, completion: number) => (prompt * 0.15 + completion * 0.6) / 1_000_000;

/** A moment `daysAgo` days back during typical (Berlin) business-ish hours, never in the future. */
function momentDaysAgo(daysAgo: number): Date {
  const now = new Date();
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(between(6, 18), between(0, 59), between(0, 59), 0);
  if (d.getTime() > now.getTime()) return new Date(now.getTime() - between(20, 180) * 60_000);
  return d;
}

const SENDER: Record<string, SenderType> = { customer: 'CUSTOMER', ai: 'AI', agent: 'AGENT', system: 'SYSTEM' };

async function reset() {
  const org = await prisma.organization.findUnique({ where: { slug: DEMO_ORG_SLUG } });
  if (org) {
    // Conversations restrict channel deletion, so remove them before the organization cascade.
    await prisma.conversation.deleteMany({ where: { organizationId: org.id } });
    await prisma.organization.delete({ where: { id: org.id } });
  }
  await prisma.user.deleteMany({ where: { email: { in: TEAM.map((t) => t.email) } } });
}

async function main() {
  console.log('Seeding NovaTech GmbH demo workspace…');
  await reset();

  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const users = await Promise.all(
    TEAM.map((t) => prisma.user.create({ data: { email: t.email, name: t.name, passwordHash } })),
  );
  const owner = users[0]!;

  const { organization, bot } = await prisma.$transaction((tx) =>
    provisionOrganization(tx, { name: NOVATECH.name, ownerUserId: owner.id, timezone: NOVATECH.timezone }),
  );
  const organizationId = organization.id;

  await prisma.organization.update({
    where: { id: organizationId },
    data: { slug: DEMO_ORG_SLUG, industry: NOVATECH.industry, website: NOVATECH.website, messageRetentionDays: 730 },
  });
  await prisma.membership.createMany({
    data: users.slice(1).map((u, i) => ({ organizationId, userId: u.id, role: TEAM[i + 1]!.role })),
  });

  await prisma.botConfiguration.update({
    where: { id: bot.id },
    data: {
      agentName: 'Nova',
      companyName: NOVATECH.name,
      businessDescription: NOVATECH.businessDescription,
      welcomeMessage: "Hi, I'm Nova from NovaTech 👋 Ask me about our AI chatbots, pricing or support — I'm happy to help.",
      tone: 'FRIENDLY',
      escalationBehavior: 'AUTOMATIC',
      // Complex technical questions stay with the AI (it can open a ticket); the rest escalate.
      behavior: { disabledTools: [], escalateOn: ['angry', 'complaint', 'legal', 'payment', 'safety'] },
      creativity: 0.3,
      quickReplies: ['Pricing', 'Book a demo', 'Support', 'Talk to a human'],
      allowedOrigins: ['http://localhost:3000', 'https://novatech.example'],
    },
  });
  await prisma.promptConfiguration.createMany({
    data: [
      { organizationId, botId: bot.id, layer: 'BUSINESS_IDENTITY', content: BUSINESS_IDENTITY },
      { organizationId, botId: bot.id, layer: 'BUSINESS_RULES', content: BUSINESS_RULES },
    ],
  });

  const websiteChannel = await prisma.channel.findFirstOrThrow({ where: { organizationId, type: 'WEBSITE' } });
  const whatsappChannel = await prisma.channel.create({
    data: {
      organizationId,
      botId: bot.id,
      type: 'WHATSAPP',
      name: 'WhatsApp Business',
      config: { displayPhoneNumber: '+49 30 1234 5672' },
    },
  });
  if (process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_BUSINESS_ACCOUNT_ID) {
    await prisma.whatsAppAccount.create({
      data: {
        organizationId,
        channelId: whatsappChannel.id,
        phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
        businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID,
      },
    });
  }
  const channelId: Record<string, string> = { WEBSITE: websiteChannel.id, WHATSAPP: whatsappChannel.id };

  // Knowledge sources, chunked. Embeddings are added by the backfill job once an
  // embedding provider (OPENAI_API_KEY) is configured; until then keyword search works.
  for (const k of KNOWLEDGE) {
    const faq = k.sourceType === 'FAQ' ? parseFaqText(k.text) : null;
    const chunks = faq ? chunkFaq(faq, { title: k.title }) : chunkText(k.text, { title: k.title });
    await prisma.knowledgeDocument.create({
      data: {
        organizationId,
        title: k.title,
        sourceType: k.sourceType,
        fileName: k.fileName,
        rawText: k.text,
        contentHash: createHash('sha256').update(k.text).digest('hex'),
        status: 'READY',
        chunkCount: chunks.length,
        tokenCount: chunks.reduce((n, c) => n + c.tokenCount, 0),
        createdById: owner.id,
        processedAt: new Date(),
        metadata: { seed: true, ...(faq ? { faq } : {}) } as unknown as Prisma.InputJsonValue,
        chunks: {
          create: chunks.map((c) => ({
            organizationId,
            chunkIndex: c.index,
            content: c.content,
            location: c.location,
            tokenCount: c.tokenCount,
          })),
        },
      },
    });
  }

  await prisma.product.createMany({
    data: PRODUCTS.map((p) => ({ organizationId, ...p, currency: 'EUR' })),
  });

  const tagNames = ['VIP', 'Pricing', 'Enterprise', 'Support', 'Real estate'];
  const tagColors = ['#a855f7', '#4f46e5', '#0ea5e9', '#f59e0b', '#10b981'];
  await prisma.tag.createMany({
    data: tagNames.map((name, i) => ({ organizationId, name, color: tagColors[i]! })),
  });
  const tags = await prisma.tag.findMany({ where: { organizationId } });
  const tagId = (name: string) => tags.find((t) => t.name === name)!.id;

  let messageCount = 0;

  async function createConversation(script: ScriptedConversation) {
    const c = script.customer;
    const identified = Boolean(c.email || c.phone);
    const createdAt = momentDaysAgo(script.daysAgo);

    const customer = await prisma.customer.create({
      data: {
        organizationId,
        name: c.name,
        email: c.email,
        phone: c.phone,
        company: c.company,
        language: c.language,
        isAnonymous: !identified,
        aiSummary: c.summary,
        createdAt,
        lastSeenAt: createdAt,
        consentAt: script.channel === 'WEBSITE' ? createdAt : null,
        identities: {
          create: {
            organizationId,
            channel: script.channel,
            externalId: script.channel === 'WHATSAPP' ? c.phone!.replace('+', '') : `visitor_${randomUUID()}`,
          },
        },
      },
    });
    if (c.tags?.length) {
      await prisma.customerTag.createMany({
        data: c.tags.map((t) => ({ organizationId, customerId: customer.id, tagId: tagId(t) })),
      });
    }
    if (c.note) {
      await prisma.customerNote.create({
        data: { organizationId, customerId: customer.id, authorId: users[1]!.id, content: c.note },
      });
    }

    // Timeline: customer messages followed by fast AI replies, slower human replies.
    let t = createdAt.getTime();
    const messages: Prisma.MessageCreateManyInput[] = [];
    let firstResponseAt: Date | null = null;
    let lastCustomerMessageAt: Date | null = null;
    let handoffAt: Date | null = null;
    const agent = script.agent !== undefined ? users[script.agent]! : undefined;

    for (const [i, [who, text]] of script.lines.entries()) {
      if (i > 0) t += who === 'ai' ? between(2, 7) * 1000 : who === 'agent' ? between(60, 900) * 1000 : between(20, 150) * 1000;
      const at = new Date(Math.min(t, Date.now() - 30_000));
      if (who === 'customer') lastCustomerMessageAt = at;
      if ((who === 'ai' || who === 'agent') && !firstResponseAt) firstResponseAt = at;
      if (who === 'system' && !handoffAt) handoffAt = at;
      messages.push({
        organizationId,
        conversationId: '',
        senderType: SENDER[who]!,
        senderUserId: who === 'agent' ? agent?.id : undefined,
        channel: script.channel,
        content: text,
        messageType: who === 'system' ? 'SYSTEM' : 'TEXT',
        externalMessageId: script.channel === 'WHATSAPP' && who !== 'system' ? `wamid.seed.${randomUUID()}` : undefined,
        status: who === 'customer' ? 'RECEIVED' : script.channel === 'WHATSAPP' ? 'READ' : 'DELIVERED',
        intent: who === 'customer' ? script.intent : undefined,
        createdAt: at,
      });
    }
    const last = messages[messages.length - 1]!;
    const lastAt = last.createdAt as Date;

    const conversation = await prisma.conversation.create({
      data: {
        organizationId,
        customerId: customer.id,
        channelId: channelId[script.channel]!,
        channel: script.channel,
        status: script.status,
        intent: script.intent,
        leadTemperature: script.lead?.temperature,
        assignedToId: agent?.id,
        unreadCount: script.unread ?? 0,
        lastMessageAt: lastAt,
        lastMessagePreview: (last.content ?? '').slice(0, 140),
        lastCustomerMessageAt,
        firstResponseAt,
        handoffRequestedAt: script.handoff ? (handoffAt ?? lastAt) : null,
        aiResolved: Boolean(script.aiResolved) && script.status === 'CLOSED',
        closedAt: script.status === 'CLOSED' ? new Date(lastAt.getTime() + 15 * 60_000) : null,
        createdAt,
      },
    });
    await prisma.message.createMany({ data: messages.map((m) => ({ ...m, conversationId: conversation.id })) });
    messageCount += messages.length;

    // Usage for each AI reply.
    const aiReplies = messages.filter((m) => m.senderType === 'AI');
    await prisma.usageRecord.createMany({
      data: aiReplies.map((m) => {
        const prompt = between(1100, 2600);
        const completion = between(60, 260);
        return {
          organizationId,
          conversationId: conversation.id,
          kind: 'CHAT' as const,
          model: MODEL,
          promptTokens: prompt,
          completionTokens: completion,
          costUsd: costUsd(prompt, completion),
          latencyMs: between(900, 3200),
          createdAt: m.createdAt,
        };
      }),
    });

    if (agent) {
      await prisma.conversationAssignment.create({
        data: {
          organizationId,
          conversationId: conversation.id,
          assigneeId: agent.id,
          assignedById: agent.id,
          createdAt: handoffAt ?? createdAt,
          endedAt: script.status === 'CLOSED' ? lastAt : null,
        },
      });
    }
    if (script.summary) {
      await prisma.conversationSummary.create({
        data: { organizationId, conversationId: conversation.id, summary: script.summary, messageCount: messages.length, createdAt: lastAt },
      });
    }
    if (script.lead) {
      await prisma.lead.create({
        data: {
          organizationId,
          customerId: customer.id,
          conversationId: conversation.id,
          assignedToId: script.lead.status === 'NEW' ? null : users[1]!.id,
          name: c.name,
          email: c.email,
          phone: c.phone,
          company: c.company,
          requestedService: script.lead.requestedService,
          message: script.lead.message,
          preferredContact: script.lead.preferredContact,
          status: script.lead.status,
          temperature: script.lead.temperature,
          intent: script.intent,
          source: script.channel,
          estimatedValue: script.lead.estimatedValue,
          createdAt: lastAt,
        },
      });
    }
    if (script.ticket) {
      await prisma.ticket.create({
        data: {
          organizationId,
          customerId: customer.id,
          conversationId: conversation.id,
          subject: script.ticket.subject,
          priority: script.ticket.priority,
          status: script.ticket.status,
          description: script.lines.filter(([w]) => w === 'customer').map(([, txt]) => txt).join('\n'),
          createdAt: handoffAt ?? lastAt,
        },
      });
    }
  }

  for (const script of SCRIPTED) await createConversation(script);

  // Volume: short anonymous exchanges spread over the last 30 days (denser recently).
  const VOLUME = 70;
  for (let i = 0; i < VOLUME; i++) {
    const ex = pick(SHORT_EXCHANGES);
    const daysAgo = Math.min(29, Math.floor(Math.pow(rand(), 1.4) * 30));
    const channel: ChannelType = rand() < 0.42 ? 'WHATSAPP' : 'WEBSITE';
    const phone = channel === 'WHATSAPP' ? `+49${between(1500000000, 1799999999)}` : undefined;
    const open = daysAgo === 0 && rand() < 0.5;
    const escalated = !open && rand() < 0.08;
    await createConversation({
      customer: { phone, language: ex.lang },
      channel,
      intent: ex.intent,
      daysAgo,
      status: open ? 'AI_ACTIVE' : 'CLOSED',
      aiResolved: !escalated,
      handoff: escalated,
      agent: escalated ? pick([2, 3]) : undefined,
      unread: open ? 1 : 0,
      lines: [
        ['customer', ex.q],
        ['ai', ex.a],
        ...(rand() < 0.5 ? [['customer', pick(['Thanks!', 'Danke!', 'Great, thank you.', 'ok 👍'])] as Line] : []),
      ],
    });
  }

  // Embedding usage for the initial knowledge import estimate.
  await prisma.usageRecord.create({
    data: {
      organizationId,
      kind: 'EMBEDDING',
      model: 'text-embedding-3-small',
      embeddingTokens: 4200,
      costUsd: (4200 * 0.02) / 1_000_000,
      createdAt: momentDaysAgo(29),
    },
  });

  await prisma.auditLog.createMany({
    data: [
      { organizationId, actorId: owner.id, action: 'organization.created', entityType: 'Organization', entityId: organizationId, createdAt: momentDaysAgo(30) },
      ...users.slice(1).map((u, i) => ({
        organizationId,
        actorId: owner.id,
        action: 'team.member_added',
        entityType: 'Membership',
        metadata: { email: u.email, role: TEAM[i + 1]!.role },
        createdAt: momentDaysAgo(29 - i),
      })),
    ],
  });

  const conversations = await prisma.conversation.count({ where: { organizationId } });
  const leads = await prisma.lead.count({ where: { organizationId } });
  console.log(`✔ ${NOVATECH.name}: ${conversations} conversations, ${messageCount} messages, ${leads} leads`);
  console.log(`✔ Sign in at http://localhost:3000/login with owner@novatech.demo / ${DEMO_PASSWORD}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
