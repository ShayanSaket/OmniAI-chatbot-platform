import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireApiAuth } from '@/server/auth/session';
import { parseJson, route } from '@/server/http';
import { listNotifications, markNotificationsRead } from '@/server/modules/notifications/notification-service';

/** The signed-in member's notifications (any role). */
export const GET = route(async () => {
  const ctx = await requireApiAuth();
  return NextResponse.json({ data: await listNotifications(ctx) });
});

/** Mark read: { ids: string[] } or { all: true } */
export const PATCH = route(async (req) => {
  const ctx = await requireApiAuth();
  const input = await parseJson(req, z.union([z.object({ all: z.literal(true) }), z.object({ ids: z.array(z.string().max(64)).min(1).max(100) })]));
  return NextResponse.json({ data: await markNotificationsRead(ctx, 'all' in input ? 'all' : input.ids) });
});
