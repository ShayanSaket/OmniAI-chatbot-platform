import 'server-only';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.string().url().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  DATABASE_URL: z.string().min(1),

  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
  ALLOW_REGISTRATION: bool.default('true'),
  ENCRYPTION_KEY: optionalString,

  OPENAI_API_KEY: optionalString,
  /** OpenAI-compatible endpoint (Azure/OpenAI proxies, local mocks). */
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  OPENAI_CHAT_MODEL: z.string().default('gpt-4o-mini'),
  OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  /** Speech-to-text for WhatsApp voice messages. */
  OPENAI_TRANSCRIPTION_MODEL: z.string().default('whisper-1'),

  WHATSAPP_ACCESS_TOKEN: optionalString,
  WHATSAPP_PHONE_NUMBER_ID: optionalString,
  WHATSAPP_BUSINESS_ACCOUNT_ID: optionalString,
  WHATSAPP_VERIFY_TOKEN: optionalString,
  WHATSAPP_APP_SECRET: optionalString,
  WHATSAPP_API_VERSION: z.string().default('v21.0'),
  /** Graph API base URL (override for tests or an egress proxy). */
  WHATSAPP_GRAPH_URL: z.string().url().default('https://graph.facebook.com'),

  /** HubSpot API base URL (override for tests). */
  HUBSPOT_API_URL: z.string().url().default('https://api.hubapi.com'),

  REDIS_URL: optionalString,

  S3_ENDPOINT: optionalString,
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: optionalString,
  S3_SECRET_KEY: optionalString,
  S3_BUCKET: optionalString,
  S3_FORCE_PATH_STYLE: bool.default('true'),

  SENTRY_DSN: optionalString,
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/**
 * Validated server environment. Lazy so `next build` can evaluate modules without
 * runtime secrets; the first real request fails fast with a readable message.
 */
export function env(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}\nSee .env.example.`);
  }
  cached = parsed.data;
  return cached;
}

/** For tests only. */
export function resetEnvCache() {
  cached = undefined;
}
