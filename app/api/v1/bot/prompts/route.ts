import { NextResponse } from 'next/server';
import { promptLayerCreateSchema } from '@/lib/validation';
import { requireApiAuth } from '@/server/auth/session';
import { parseJson, route } from '@/server/http';
import { createPromptLayer, listPromptLayers } from '@/server/modules/bot/prompt-service';

export const GET = route(async () => {
  const ctx = await requireApiAuth('bot:manage');
  return NextResponse.json({ data: await listPromptLayers(ctx) });
});

export const POST = route(async (req) => {
  const ctx = await requireApiAuth('bot:manage');
  const input = await parseJson(req, promptLayerCreateSchema);
  return NextResponse.json({ data: await createPromptLayer(ctx, input) }, { status: 201 });
});
