import { NextResponse } from 'next/server';
import { hasPermission } from '@/lib/permissions';
import { whatsappTemplateSendSchema } from '@/lib/validation';
import { requireApiAuth } from '@/server/auth/session';
import { parseJson, route } from '@/server/http';
import { listSendableTemplates, sendWhatsAppTemplate, whatsappWindowState } from '@/server/modules/whatsapp/whatsapp-service';

type Params = { conversationId: string };

/** Whether free-form replies are possible (24-hour customer service window) and the templates that can be sent. */
export const GET = route<Params>(async (_req, { params }) => {
  const ctx = await requireApiAuth('inbox:access');
  const [window, templates] = await Promise.all([
    whatsappWindowState(ctx, params.conversationId),
    hasPermission(ctx.role, 'conversations:reply') ? listSendableTemplates(ctx) : Promise.resolve([]),
  ]);
  return NextResponse.json({ data: { ...window, templates } });
});

/** Sends an approved template (works outside the 24-hour window). */
export const POST = route<Params>(async (req, { params }) => {
  const ctx = await requireApiAuth('conversations:reply');
  const input = await parseJson(req, whatsappTemplateSendSchema);
  return NextResponse.json({ data: await sendWhatsAppTemplate(ctx, params.conversationId, input) });
});
