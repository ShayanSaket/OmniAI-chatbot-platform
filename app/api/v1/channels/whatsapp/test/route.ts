import { NextResponse } from 'next/server';
import { requireApiAuth } from '@/server/auth/session';
import { route } from '@/server/http';
import { enforceRateLimit, RATE_LIMITS } from '@/server/rate-limit';
import { testWhatsAppConnection } from '@/server/modules/whatsapp/whatsapp-service';

export const POST = route(async () => {
  const ctx = await requireApiAuth('bot:manage');
  await enforceRateLimit(RATE_LIMITS.widgetAction, `wa-test:${ctx.organizationId}`);
  return NextResponse.json({ data: await testWhatsAppConnection(ctx) });
});
