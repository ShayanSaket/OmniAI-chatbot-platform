import { NextResponse } from 'next/server';
import { requireVisitor } from '@/server/channels/website/widget-auth';
import { route } from '@/server/http';
import { enforceRateLimit, RATE_LIMITS } from '@/server/rate-limit';
import { restartConversation } from '@/server/modules/widget/widget-service';

export const dynamic = 'force-dynamic';

export const POST = route<{ botKey: string }>(async (req, { params }) => {
  const visitor = await requireVisitor(req, params.botKey);
  await enforceRateLimit(RATE_LIMITS.widgetAction, visitor.customerId);
  return NextResponse.json({ data: await restartConversation(visitor) });
});
