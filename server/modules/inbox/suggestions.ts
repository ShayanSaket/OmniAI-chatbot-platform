import 'server-only';
import type { SuggestionInput } from '@/lib/inbox';
import { hasPermission } from '@/lib/permissions';
import { complete, ProviderError, ProviderNotConfiguredError, type ChatMessage } from '../../ai/provider';
import { recordUsage } from '../../ai/usage';
import type { ServiceContext } from '../../context';
import { prisma } from '../../db';
import { env } from '../../env';
import { AppError, forbidden, notFound } from '../../errors';
import { logger } from '../../logger';
import { customerFactLines, loadCustomerContext } from '../agent/memory';
import { searchKnowledge } from '../knowledge/retrieval';

// AI reply suggestions for team members (spec §35). Suggestions are only ever returned
// to the agent's composer — nothing here sends a message.

const HISTORY = 20;
const KNOWLEDGE_CHUNKS = 4;

const REWRITE: Record<'shorten' | 'friendlier' | 'professional', string> = {
  shorten: 'Make it noticeably shorter and more direct. Remove filler, keep every fact, question and commitment.',
  friendlier: 'Make it warmer and friendlier, still natural and not over the top. No extra exclamation marks or emojis unless the draft already uses them.',
  professional: 'Make it polished and professional: clear, courteous and precise. Avoid slang.',
};

const KEEP = 'Keep the meaning, names, numbers, prices, dates, links and any placeholders in [square brackets] exactly. Return only the rewritten message, no quotes or commentary.';

function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Removes wrappers models sometimes add ("Reply:", surrounding quotes). */
export function cleanSuggestion(text: string): string {
  let t = text.trim();
  t = t.replace(/^(?:here(?:'|’)s (?:a|the) [^:\n]{0,40}:|reply:|draft:|suggested reply:)\s*/i, '');
  if (/^["“].*["”]$/s.test(t)) t = t.slice(1, -1).trim();
  return t;
}

const lineFor = (m: { senderType: string; content: string; senderUser?: { name: string | null } | null }) => {
  const who = m.senderType === 'CUSTOMER' ? 'Customer' : m.senderType === 'AGENT' ? `Team member${m.senderUser?.name ? ` (${m.senderUser.name})` : ''}` : 'AI assistant';
  return `${who}: ${m.content.replace(/\s+/g, ' ').slice(0, 800)}`;
};

async function buildGenerateMessages(ctx: ServiceContext, conversationId: string, agentName: string | null): Promise<ChatMessage[]> {
  const conversation = await ctx.db.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, channel: true, customerId: true, summaries: { orderBy: { createdAt: 'desc' }, take: 1, select: { summary: true } } },
  });
  if (!conversation) throw notFound('Conversation');
  const [history, customer, bot, org, products] = await Promise.all([
    ctx.db.message
      .findMany({
        where: { conversationId, senderType: { in: ['CUSTOMER', 'AI', 'AGENT'] } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: HISTORY,
        select: { senderType: true, content: true, senderUser: { select: { name: true } } },
      })
      .then((rows) => rows.reverse()),
    loadCustomerContext(ctx.db, conversation.customerId),
    ctx.db.botConfiguration.findFirst({ orderBy: { createdAt: 'asc' }, select: { companyName: true, businessDescription: true, defaultLanguage: true, model: true } }),
    prisma.organization.findUnique({ where: { id: ctx.organizationId }, select: { name: true } }),
    ctx.db.product.findMany({ where: { isActive: true }, orderBy: { name: 'asc' }, take: 15, select: { name: true, price: true, currency: true, priceNote: true } }),
  ]);
  if (!history.length) throw new AppError('BAD_REQUEST', 'There are no messages to reply to yet.');
  const lastCustomer = [...history].reverse().find((m) => m.senderType === 'CUSTOMER');
  const knowledge = lastCustomer
    ? await searchKnowledge(ctx.organizationId, lastCustomer.content.slice(0, 500), { limit: KNOWLEDGE_CHUNKS }).catch((err) => {
        logger.warn('suggestion knowledge search failed', { conversationId, err: (err as Error).message });
        return [];
      })
    : [];
  const company = bot?.companyName || org?.name || 'the company';
  const language = customer.profile.language ?? bot?.defaultLanguage ?? 'en';

  const system = [
    `You draft replies for a human customer-support team member${agentName ? ` named ${agentName}` : ''} at ${company}.`,
    bot?.businessDescription ? `About the business: ${bot.businessDescription.slice(0, 600)}` : null,
    'The team member reviews and edits your draft before sending it. Write as that person, in first person, never as an AI.',
    `Write in ${languageName(language)} (the customer's language) unless the customer's latest message is clearly in another language — then use that language.`,
    'Answer the customer\'s latest message, using the conversation, the customer details, the knowledge excerpts and the product list below.',
    'Only state facts found there. If something needed is missing (a date, a price, a decision), insert a short placeholder in square brackets, e.g. [confirm delivery date], instead of inventing it.',
    'Never quote prices that are not in the product list. Never ask for passwords or full card numbers.',
    conversation.channel === 'WHATSAPP' ? 'This is WhatsApp: plain text, short paragraphs, no markdown headings or tables.' : 'This is website chat: short paragraphs; simple markdown lists are fine.',
    'Be concise (usually 1–4 sentences). Return only the reply text.',
  ]
    .filter(Boolean)
    .join('\n');

  const context = [
    'CUSTOMER DETAILS',
    ...customerFactLines(customer),
    conversation.summaries[0] ? `\nCONVERSATION SUMMARY\n${conversation.summaries[0].summary}` : null,
    knowledge.length ? `\nKNOWLEDGE EXCERPTS\n${knowledge.map((k, i) => `[${i + 1}] ${k.title}${k.location ? ` — ${k.location}` : ''}\n${k.content.slice(0, 1200)}`).join('\n\n')}` : '\nKNOWLEDGE EXCERPTS\n(none matched)',
    products.length
      ? `\nPRODUCTS\n${products.map((p) => `- ${p.name}: ${p.price !== null ? `${p.price.toString()} ${p.currency}${p.priceNote ? ` (${p.priceNote})` : ''}` : 'price on request'}`).join('\n')}`
      : null,
    `\nCONVERSATION (oldest first)\n${history.map(lineFor).join('\n')}`,
    '\nDraft the team member\'s next reply.',
  ]
    .filter((l) => l !== null)
    .join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: context },
  ];
}

export async function suggestReply(ctx: ServiceContext, conversationId: string, input: SuggestionInput): Promise<{ text: string }> {
  if (!hasPermission(ctx.role, 'conversations:reply')) throw forbidden();
  const conversation = await ctx.db.conversation.findUnique({ where: { id: conversationId }, select: { customer: { select: { language: true } } } });
  if (!conversation) throw notFound('Conversation');
  const bot = await ctx.db.botConfiguration.findFirst({ orderBy: { createdAt: 'asc' }, select: { model: true, defaultLanguage: true } });
  const model = bot?.model || env().OPENAI_CHAT_MODEL;

  let messages: ChatMessage[];
  if (input.action === 'generate') {
    const member = await ctx.db.membership.findFirst({ where: { userId: ctx.userId }, select: { user: { select: { name: true } } } });
    messages = await buildGenerateMessages(ctx, conversationId, member?.user.name ?? null);
  } else if (input.action === 'translate') {
    const target = input.language ?? conversation.customer.language ?? bot?.defaultLanguage ?? 'en';
    messages = [
      { role: 'system', content: `Translate the customer-support message into ${languageName(target)}. Natural, fluent wording for a customer. ${KEEP}` },
      { role: 'user', content: input.draft },
    ];
  } else {
    messages = [
      { role: 'system', content: `Rewrite the customer-support message drafted by a team member. ${REWRITE[input.action]} Keep the same language as the draft. ${KEEP}` },
      { role: 'user', content: input.draft },
    ];
  }

  const started = Date.now();
  let result;
  try {
    result = await complete({ model, messages, temperature: input.action === 'generate' ? 0.4 : 0.2, maxTokens: 700, signal: AbortSignal.timeout(45_000) });
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      throw new AppError('BAD_REQUEST', 'AI suggestions need an AI provider. Ask the workspace owner to configure OPENAI_API_KEY on the server.');
    }
    logger.warn('reply suggestion failed', { conversationId, action: input.action, err: (err as Error).message });
    throw new AppError('INTERNAL', err instanceof ProviderError && err.status === 429 ? 'The AI provider is busy. Try again in a moment.' : 'The AI could not create a suggestion right now. Please try again.');
  }
  await recordUsage(ctx.db, {
    organizationId: ctx.organizationId,
    conversationId,
    kind: 'SUGGESTION',
    model,
    usage: result.usage,
    latencyMs: Date.now() - started,
    estimate: { input: messages.map((m) => ('content' in m ? m.content : '')).join('\n'), output: result.text },
  });
  const text = cleanSuggestion(result.text);
  if (!text) throw new AppError('INTERNAL', 'The AI returned an empty suggestion. Please try again.');
  return { text };
}
