import { NextResponse } from 'next/server';
import { whatsappTemplateSendSchema } from '@/lib/validation';
import { requireApiAuth } from '@/server/auth/session';
import { parseJson, route } from '@/server/http';
import { sendWhatsAppTemplate, whatsappWindowState } from '@/server/modules/whatsapp/whatsapp-service';

type Params = { conversationId: string };

/** Whether free-form replies are possible (24-hour customer service window). */
export const GET = route<Params>(async (_req, { params }) => {
  const ctx = await requireApiAuth('inbox:access');
  return NextResponse.json({ data: await whatsappWindowState(ctx, params.conversationId) });
});

/** Sends an approved template (works outside the 24-hour window). */
export const POST = route<Params>(async (req, { params }) => {
  const ctx = await requireApiAuth('conversations:reply');
  const input = await parseJson(req, whatsappTemplateSendSchema);
  return NextResponse.json({ data: await sendWhatsAppTemplate(ctx, params.conversationId, input) });
});
