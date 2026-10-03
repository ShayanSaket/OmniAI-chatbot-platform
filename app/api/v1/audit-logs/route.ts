import { NextResponse } from 'next/server';
import { requireApiAuth } from '@/server/auth/session';
import { route } from '@/server/http';
import { listAuditLogs } from '@/server/modules/audit/audit-service';

export const GET = route(async (req) => {
  const ctx = await requireApiAuth('audit:view');
  const params = req.nextUrl.searchParams;
  const result = await listAuditLogs(ctx, {
    cursor: params.get('cursor') ?? undefined,
    limit: Number(params.get('limit')) || undefined,
  });
  return NextResponse.json(result);
});
