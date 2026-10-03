import { NextResponse } from 'next/server';
import { z } from 'zod';
import { PROMPT_CHANNELS } from '@/lib/validation';
import { requireApiAuth } from '@/server/auth/session';
import { route } from '@/server/http';
import { previewSystemPrompt } from '@/server/modules/bot/bot-service';

const channelSchema = z.enum(PROMPT_CHANNELS).catch('WEBSITE');

export const GET = route(async (req) => {
  const ctx = await requireApiAuth('bot:manage');
  const channel = channelSchema.parse(req.nextUrl.searchParams.get('channel'));
  return NextResponse.json({ data: await previewSystemPrompt(ctx, channel) });
});
