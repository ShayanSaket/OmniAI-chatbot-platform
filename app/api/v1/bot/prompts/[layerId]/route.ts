import { NextResponse } from 'next/server';
import { promptLayerUpdateSchema } from '@/lib/validation';
import { requireApiAuth } from '@/server/auth/session';
import { parseJson, route } from '@/server/http';
import { deletePromptLayer, updatePromptLayer } from '@/server/modules/bot/prompt-service';

type Params = { layerId: string };

export const PATCH = route<Params>(async (req, { params }) => {
  const ctx = await requireApiAuth('bot:manage');
  const input = await parseJson(req, promptLayerUpdateSchema);
  return NextResponse.json({ data: await updatePromptLayer(ctx, params.layerId, input) });
});

export const DELETE = route<Params>(async (_req, { params }) => {
  const ctx = await requireApiAuth('bot:manage');
  await deletePromptLayer(ctx, params.layerId);
  return new NextResponse(null, { status: 204 });
});
