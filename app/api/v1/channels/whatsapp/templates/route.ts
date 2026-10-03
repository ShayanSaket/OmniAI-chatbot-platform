import { NextResponse } from 'next/server';
import { requireApiAuth } from '@/server/auth/session';
import { route } from '@/server/http';
import { enforceRateLimit, RATE_LIMITS } from '@/server/rate-limit';
import { getWhatsAppSettings, syncWhatsAppTemplates } from '@/server/modules/whatsapp/whatsapp-service';

export const GET = route(async () => {
  const ctx = await requireApiAuth('bot:manage');
  return NextResponse.json({ data: (await getWhatsAppSettings(ctx)).templates });
});

/** Syncs templates from Meta. */
export const POST = route(async () => {
  const ctx = await requireApiAuth('bot:manage');
  await enforceRateLimit(RATE_LIMITS.widgetAction, `wa-sync:${ctx.organizationId}`);
  return NextResponse.json({ data: await syncWhatsAppTemplates(ctx) });
});
