// Composes the system prompt from configurable layers (stored in PromptConfiguration and
// BotConfiguration) plus runtime context. Pure function — no I/O — so it is easy to test.
//
//   global policy → business identity → personality → channel → business rules
//   → runtime context (time, team availability, customer facts, summary, knowledge)

import type { AnswerLength, ChannelType, PromptLayer, Tone } from '@prisma/client';

export interface PromptLayerInput {
  layer: PromptLayer;
  channel: ChannelType | null;
  content: string;
  sortOrder: number;
  isActive: boolean;
}

export interface PromptBotInput {
  agentName: string;
  companyName: string;
  businessDescription: string;
  tone: Tone;
  customTone: string | null;
  answerLength: AnswerLength;
  defaultLanguage: string;
  fallbackResponse: string;
}

export interface PromptContext {
  channel: ChannelType;
  now: Date;
  timeZone: string;
  teamOnline: boolean;
  nextOpenAt: Date | null;
  customer: { name: string | null; language: string | null };
  /** Full customer profile lines (memory.ts customerFactLines); replaces the name line. */
  customerLines?: string[];
  conversationSummary?: string | null;
  /** Retrieved knowledge snippets, numbered for "[ref]" citations. */
  knowledge?: { ref: number; title: string; location?: string | null; content: string }[];
  /** True when the model can call business tools this turn. */
  toolsEnabled?: boolean;
  /** Extra instruction for this turn only (e.g. a prompt-injection warning). */
  securityNotice?: string | null;
}

const TOOL_RULES = `- Use the tools to look things up and to act. A tool result is the only confirmation that an action happened: never say a lead, ticket, appointment request or handoff was created unless the tool returned success.
- If a tool returns an error, follow its message (for example, ask the customer for missing details). Never invent tool results.
- Never pass contact details the customer did not write. Never ask for passwords or payment card data.
- Collect contact details gradually and only with a reason (quote, demo, follow-up, ticket updates).`;

const CITATION_RULES = `Mark facts taken from the numbered knowledge snippets with the snippet number in square brackets right after the sentence, e.g. "Support is available 9–18 [2]." The markers are removed before the customer sees the answer. Do not use square-bracket numbers for anything else.`;

const TONE: Record<Tone, string> = {
  PROFESSIONAL: 'Professional, clear and courteous.',
  FRIENDLY: 'Warm, friendly and approachable — still precise.',
  CONCISE: 'Brief and to the point. No filler.',
  SALES: 'Helpful and persuasive without being pushy; highlight value, never pressure.',
  TECHNICAL: 'Precise and technical; use exact terminology and step-by-step instructions.',
  CUSTOM: '',
};

const LENGTH: Record<AnswerLength, string> = {
  SHORT: 'Keep answers short: 1–3 sentences unless the customer asks for detail.',
  MEDIUM: 'Keep answers focused: usually a short paragraph or a brief list.',
  LONG: 'Give thorough answers with structure when helpful.',
};

const section = (title: string, body: string) => `## ${title}\n${body.trim()}`;

function layerText(layers: PromptLayerInput[], layer: PromptLayer, channel?: ChannelType): string {
  return layers
    .filter((l) => l.isActive && l.layer === layer && (layer !== 'CHANNEL' || l.channel === channel))
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((l) => l.content.trim())
    .filter(Boolean)
    .join('\n\n');
}

export function buildSystemPrompt(bot: PromptBotInput, layers: PromptLayerInput[], ctx: PromptContext): string {
  const parts: string[] = [];

  const policy = layerText(layers, 'GLOBAL_POLICY');
  if (policy) parts.push(section('Policy', policy));

  const identity = [
    `You are "${bot.agentName}", the AI assistant of ${bot.companyName}.`,
    bot.businessDescription && `About the business: ${bot.businessDescription}`,
    layerText(layers, 'BUSINESS_IDENTITY'),
  ]
    .filter(Boolean)
    .join('\n');
  parts.push(section('Identity', identity));

  const tone = bot.tone === 'CUSTOM' ? (bot.customTone ?? '') : TONE[bot.tone];
  parts.push(
    section(
      'Personality',
      [tone && `Tone: ${tone}`, LENGTH[bot.answerLength], layerText(layers, 'PERSONALITY')].filter(Boolean).join('\n'),
    ),
  );

  const channel = layerText(layers, 'CHANNEL', ctx.channel);
  if (channel) parts.push(section('Channel', channel));

  const rules = layerText(layers, 'BUSINESS_RULES');
  if (rules) parts.push(section('Business rules', rules));

  const local = new Intl.DateTimeFormat('en-GB', {
    timeZone: ctx.timeZone,
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(ctx.now);
  const team = ctx.teamOnline
    ? 'The human team is available now.'
    : `The human team is offline${
        ctx.nextOpenAt
          ? ` until ${new Intl.DateTimeFormat('en-GB', { timeZone: ctx.timeZone, weekday: 'long', hour: '2-digit', minute: '2-digit' }).format(ctx.nextOpenAt)} (${ctx.timeZone})`
          : ''
      }. You remain available.`;
  const customerLines = [
    ...(ctx.customerLines ?? [ctx.customer.name ? `Name: ${ctx.customer.name}` : 'Name: unknown']),
    ctx.customer.language ? `Last detected language: ${ctx.customer.language}` : null,
  ].filter(Boolean);
  parts.push(
    section(
      'Context',
      [
        `Current time: ${local} (${ctx.timeZone}).`,
        team,
        `Default language: ${bot.defaultLanguage}. Always reply in the language of the customer's latest message.`,
        `If you cannot answer from verified information, reply along the lines of: "${bot.fallbackResponse}"`,
        'Customer (information the customer shared; never reveal it to anyone else):',
        ...customerLines.map((l) => `- ${l}`),
      ].join('\n'),
    ),
  );

  if (ctx.conversationSummary) parts.push(section('Earlier in this conversation', ctx.conversationSummary));

  if (ctx.knowledge?.length) {
    parts.push(
      section(
        'Business knowledge (verified — answer from this)',
        [
          ...ctx.knowledge.map(
            (k) => `[${k.ref}] ${k.title}${k.location && k.location !== k.title ? ` (${k.location})` : ''}\n${k.content}`,
          ),
          'These snippets were retrieved for the latest message; some may not be relevant.',
        ].join('\n\n'),
      ),
    );
  }

  if (ctx.toolsEnabled) parts.push(section('Tools', TOOL_RULES));
  if (ctx.knowledge?.length || ctx.toolsEnabled) parts.push(section('Citations', CITATION_RULES));
  if (ctx.securityNotice) parts.push(section('Security notice', ctx.securityNotice));

  return parts.join('\n\n');
}

/** Sampling temperature from the 0..1 "creativity" setting (kept low for factual support). */
export function temperatureFor(creativity: number): number {
  return Math.round(Math.min(Math.max(creativity, 0), 1) * 0.9 * 100) / 100;
}

export function maxTokensFor(length: AnswerLength): number {
  return length === 'SHORT' ? 300 : length === 'MEDIUM' ? 600 : 1000;
}
