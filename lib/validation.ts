// Zod schemas shared by forms (client) and route handlers (server).
import { z } from 'zod';
import { agentBehaviorPatchSchema } from './agent-tools';
import { EVENT_TYPES } from './events';
import { isValidOriginPattern } from './origins';
import { ROLES } from './permissions';

export const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address').max(254);

export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(128, 'Use at most 128 characters')
  .regex(/[a-zA-Z]/, 'Include at least one letter')
  .regex(/[0-9]/, 'Include at least one number');

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password').max(128),
});

export const registerSchema = z.object({
  name: z.string().trim().min(2, 'Enter your name').max(100),
  email: emailSchema,
  password: passwordSchema,
  organizationName: z.string().trim().min(2, 'Enter your company name').max(100),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
  { code: 'fa', label: 'فارسی (Persian)' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
] as const;

const languageCodes = SUPPORTED_LANGUAGES.map((l) => l.code) as [string, ...string[]];

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const organizationUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    industry: z.string().trim().max(100).nullable(),
    website: z
      .string()
      .trim()
      .max(300)
      .url('Enter a full URL, e.g. https://example.com')
      .refine((v) => /^https?:\/\//.test(v), 'Only http(s) URLs are allowed')
      .nullable(),
    timezone: z.string().refine(isValidTimeZone, 'Unknown time zone'),
    defaultLanguage: z.enum(languageCodes),
    messageRetentionDays: z.number().int().min(30).max(3650).nullable(),
  })
  .partial();
export type OrganizationUpdateInput = z.infer<typeof organizationUpdateSchema>;

export const roleSchema = z.enum(ROLES);

export const addMemberSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: emailSchema,
  role: roleSchema,
  password: passwordSchema,
});
export type AddMemberInput = z.infer<typeof addMemberSchema>;

export const updateMemberSchema = z.object({ role: roleSchema });

export const ANALYTICS_RANGES = ['today', '7d', '30d'] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];
export const analyticsRangeSchema = z.enum(ANALYTICS_RANGES).catch('7d');

const httpsUrl = z
  .string()
  .trim()
  .max(500)
  .url('Enter a full URL')
  .refine((v) => v.startsWith('https://'), 'Use an https:// URL');

export const WIDGET_POSITIONS = ['bottom-right', 'bottom-left'] as const;

export const botWidgetUpdateSchema = z
  .object({
    agentName: z.string().trim().min(1, 'Enter a name').max(60),
    welcomeMessage: z.string().trim().min(1, 'Enter a welcome message').max(500),
    primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex color like #4f46e5'),
    widgetPosition: z.enum(WIDGET_POSITIONS),
    quickReplies: z.array(z.string().trim().min(1).max(40, 'Keep quick replies under 40 characters')).max(6, 'Up to 6 quick replies'),
    allowAttachments: z.boolean(),
    showSourcesWebsite: z.boolean(),
    allowedOrigins: z
      .array(z.string().trim().refine(isValidOriginPattern, 'Use an origin like https://example.com or https://*.example.com'))
      .max(50),
    avatarUrl: httpsUrl.nullable(),
    isActive: z.boolean(),
  })
  .partial();
export type BotWidgetUpdateInput = z.infer<typeof botWidgetUpdateSchema>;

// ── AI agent settings (phase 3) ──────────────────────────────────────

export const TONES = ['PROFESSIONAL', 'FRIENDLY', 'CONCISE', 'SALES', 'TECHNICAL', 'CUSTOM'] as const;
export const ANSWER_LENGTHS = ['SHORT', 'MEDIUM', 'LONG'] as const;
export const ESCALATION_BEHAVIORS = ['SUGGEST', 'AUTOMATIC', 'DISABLED'] as const;

export const botAgentUpdateSchema = z
  .object({
    companyName: z.string().trim().min(1, 'Enter the company name').max(120),
    businessDescription: z.string().trim().max(2000, 'Keep it under 2,000 characters'),
    tone: z.enum(TONES),
    customTone: z.string().trim().max(500).nullable(),
    defaultLanguage: z.enum(languageCodes),
    creativity: z.number().min(0).max(1),
    answerLength: z.enum(ANSWER_LENGTHS),
    fallbackResponse: z.string().trim().min(1, 'Enter a fallback response').max(500),
    escalationBehavior: z.enum(ESCALATION_BEHAVIORS),
    model: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._:/-]{2,80}$/, 'Enter a model name like gpt-4o-mini'),
    showSourcesWhatsapp: z.boolean(),
    behavior: agentBehaviorPatchSchema,
  })
  .partial();

/** PATCH /api/v1/bot: widget appearance and agent behavior. */
export const botUpdateSchema = botWidgetUpdateSchema.merge(botAgentUpdateSchema).superRefine((v, ctx) => {
  if (v.tone === 'CUSTOM' && v.customTone !== undefined && !v.customTone) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['customTone'], message: 'Describe the custom tone' });
  }
});
export type BotUpdateInput = z.infer<typeof botUpdateSchema>;

export const PROMPT_LAYERS = ['GLOBAL_POLICY', 'BUSINESS_IDENTITY', 'PERSONALITY', 'CHANNEL', 'BUSINESS_RULES'] as const;
export const PROMPT_CHANNELS = ['WEBSITE', 'WHATSAPP'] as const;

export const promptLayerCreateSchema = z
  .object({
    layer: z.enum(PROMPT_LAYERS),
    channel: z.enum(PROMPT_CHANNELS).nullable().default(null),
    content: z.string().trim().min(1, 'Enter the instructions').max(8000, 'Keep a layer under 8,000 characters'),
    isActive: z.boolean().default(true),
    sortOrder: z.number().int().min(0).max(100).default(0),
  })
  .superRefine((v, ctx) => {
    if (v.layer === 'CHANNEL' && !v.channel) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['channel'], message: 'Choose a channel' });
    if (v.layer !== 'CHANNEL' && v.channel) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['channel'], message: 'Only channel layers have a channel' });
  });
export type PromptLayerCreateInput = z.infer<typeof promptLayerCreateSchema>;

export const promptLayerUpdateSchema = z
  .object({
    content: z.string().trim().min(1, 'Enter the instructions').max(8000, 'Keep a layer under 8,000 characters'),
    isActive: z.boolean(),
    sortOrder: z.number().int().min(0).max(100),
  })
  .partial();
export type PromptLayerUpdateInput = z.infer<typeof promptLayerUpdateSchema>;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm');

export const businessHoursUpdateSchema = z.object({
  // closesAt ≤ opensAt runs past midnight; equal times mean open 24 hours.
  hours: z
    .array(z.object({ weekday: z.number().int().min(0).max(6), opensAt: hhmm, closesAt: hhmm }))
    .max(21, 'At most three time ranges per day'),
});
export type BusinessHoursUpdateInput = z.infer<typeof businessHoursUpdateSchema>;

export const productSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(120),
  sku: z.string().trim().max(60).nullable(),
  category: z.string().trim().max(60).nullable(),
  description: z.string().trim().max(2000, 'Keep it under 2,000 characters'),
  price: z
    .number()
    .min(0, 'Price cannot be negative')
    .max(10_000_000)
    .refine((p) => Math.abs(Math.round(p * 100) - p * 100) < 1e-6, 'Use at most two decimals')
    .nullable(),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code'),
  priceNote: z.string().trim().max(60).nullable(),
  url: httpsUrl.nullable(),
  isActive: z.boolean(),
});
export type ProductInput = z.infer<typeof productSchema>;
export const productUpdateSchema = productSchema.partial();
export type ProductUpdateInput = z.infer<typeof productUpdateSchema>;

export const orderLookupUpdateSchema = z.object({
  urlTemplate: z
    .string()
    .trim()
    .url('Enter a full URL')
    .max(500)
    .refine((u) => u.includes('{orderNumber}'), 'Include {orderNumber} where the order number goes'),
  /** undefined = keep the stored key, null or "" = remove it. */
  apiKey: z.string().trim().max(500).nullable().optional(),
  isActive: z.boolean(),
});
export type OrderLookupUpdateInput = z.infer<typeof orderLookupUpdateSchema>;

// ── Knowledge base (phase 4) ────────────────────────────────────────

export const KNOWLEDGE_MAX_FILE_BYTES = 20 * 1024 * 1024;

export const knowledgeWebsiteSchema = z.object({
  url: z
    .string()
    .trim()
    .url('Enter a full URL, e.g. https://www.example.com/faq')
    .refine((u) => /^https?:\/\//i.test(u), 'Use an http(s) URL'),
  crawl: z.boolean().default(false),
  maxPages: z.number().int().min(1).max(25).default(10),
});
export type KnowledgeWebsiteInput = z.infer<typeof knowledgeWebsiteSchema>;

export const faqEntrySchema = z.object({
  question: z.string().trim().min(3, 'Enter the question').max(500),
  answer: z.string().trim().min(1, 'Enter the answer').max(4000),
});

export const knowledgeFaqSchema = z.object({
  title: z.string().trim().min(1, 'Enter a title').max(200),
  entries: z.array(faqEntrySchema).min(1, 'Add at least one question').max(300),
});
export type KnowledgeFaqInput = z.infer<typeof knowledgeFaqSchema>;

export const knowledgeTextSchema = z.object({
  title: z.string().trim().min(1, 'Enter a title').max(200),
  content: z.string().trim().min(20, 'Add some content (at least 20 characters)').max(200_000),
});
export type KnowledgeTextInput = z.infer<typeof knowledgeTextSchema>;

export const knowledgeSearchSchema = z.object({ query: z.string().trim().min(2).max(500) });

// ── Webhooks & integrations (phase 9) ───────────────────────────────

export const WEBHOOK_PRESETS = ['custom', 'zapier', 'make', 'n8n'] as const;

export const webhookEndpointSchema = z.object({
  url: z
    .string()
    .trim()
    .url('Enter the full URL of your endpoint')
    .max(500)
    .refine((u) => /^https?:\/\//i.test(u), 'Use an http(s) URL'),
  events: z
    .array(z.enum([...EVENT_TYPES, '*'] as [string, ...string[]]))
    .min(1, 'Choose at least one event')
    .max(EVENT_TYPES.length + 1),
  description: z.string().trim().max(200).nullable().default(null),
  preset: z.enum(WEBHOOK_PRESETS).default('custom'),
});
export type WebhookEndpointInput = z.infer<typeof webhookEndpointSchema>;
export const webhookEndpointUpdateSchema = webhookEndpointSchema.partial().extend({ isActive: z.boolean().optional() });
export type WebhookEndpointUpdateInput = z.infer<typeof webhookEndpointUpdateSchema>;

export const hubspotConnectSchema = z.object({
  accessToken: z.string().trim().min(10, 'Paste the private app access token').max(500),
  syncLeads: z.boolean().default(true),
  syncCustomers: z.boolean().default(false),
});

// ── WhatsApp (phase 5) ──────────────────────────────────────────────

const metaId = z
  .string()
  .trim()
  .regex(/^\d{5,30}$/, 'Use the numeric ID from Meta Business Manager');

export const whatsappConnectSchema = z.object({
  phoneNumberId: metaId,
  businessAccountId: metaId,
  displayPhoneNumber: z.string().trim().max(40).nullable().optional(),
  /** undefined = keep the stored token, null or "" = use WHATSAPP_ACCESS_TOKEN from the environment. */
  accessToken: z.string().trim().max(1000).nullable().optional(),
});
export type WhatsAppConnectInput = z.infer<typeof whatsappConnectSchema>;

export const whatsappTemplateSendSchema = z.object({
  templateId: z.string().min(1).max(64),
  params: z.array(z.string().trim().min(1, 'Fill in every variable').max(1000)).max(20),
});
export type WhatsAppTemplateSendInput = z.infer<typeof whatsappTemplateSendSchema>;

export const orderLookupTestSchema = z.object({
  orderNumber: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9#_-]{2,64}$/, 'Enter an order number'),
  email: emailSchema,
});
