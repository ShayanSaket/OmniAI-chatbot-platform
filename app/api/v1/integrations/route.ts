import { NextResponse } from 'next/server';
import { requireApiAuth } from '@/server/auth/session';
import { route } from '@/server/http';
import { listIntegrations } from '@/server/modules/integrations/integration-service';

export const GET = route(async () => {
  const ctx = await requireApiAuth('integrations:manage');
  return NextResponse.json({ data: await listIntegrations(ctx) });
});
