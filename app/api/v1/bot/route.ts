import { NextResponse } from 'next/server';
import { botUpdateSchema } from '@/lib/validation';
import { requireApiAuth } from '@/server/auth/session';
import { parseJson, route } from '@/server/http';
import { getPrimaryBot, updateBot } from '@/server/modules/bot/bot-service';

export const GET = route(async () => {
  const ctx = await requireApiAuth('bot:manage');
  return NextResponse.json({ data: await getPrimaryBot(ctx) });
});

export const PATCH = route(async (req) => {
  const ctx = await requireApiAuth('bot:manage');
  const input = await parseJson(req, botUpdateSchema);
  return NextResponse.json({ data: await updateBot(ctx, input) });
});
