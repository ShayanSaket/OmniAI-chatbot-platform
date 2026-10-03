import { NextResponse } from 'next/server';
import { whatsappConnectSchema } from '@/lib/validation';
import { requireApiAuth } from '@/server/auth/session';
import { parseJson, route } from '@/server/http';
import { connectWhatsApp, disconnectWhatsApp, getWhatsAppSettings } from '@/server/modules/whatsapp/whatsapp-service';

export const GET = route(async () => {
  const ctx = await requireApiAuth('bot:manage');
  return NextResponse.json({ data: await getWhatsAppSettings(ctx) });
});

export const PUT = route(async (req) => {
  const ctx = await requireApiAuth('integrations:manage');
  const input = await parseJson(req, whatsappConnectSchema);
  return NextResponse.json({ data: await connectWhatsApp(ctx, input) });
});

export const DELETE = route(async () => {
  const ctx = await requireApiAuth('integrations:manage');
  await disconnectWhatsApp(ctx);
  return new NextResponse(null, { status: 204 });
});
