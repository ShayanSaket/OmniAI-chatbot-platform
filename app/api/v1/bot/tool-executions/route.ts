import { NextResponse } from 'next/server';
import { requireApiAuth } from '@/server/auth/session';
import { route } from '@/server/http';
import { listToolExecutions } from '@/server/modules/bot/bot-service';

export const GET = route(async (req) => {
  const ctx = await requireApiAuth('bot:manage');
  const limit = Number(req.nextUrl.searchParams.get('limit') ?? 25) || 25;
  return NextResponse.json({ data: await listToolExecutions(ctx, limit) });
});
