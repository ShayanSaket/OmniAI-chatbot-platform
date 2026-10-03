import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { getRedis } from '@/server/redis';

export const dynamic = 'force-dynamic';

/** Liveness + dependency readiness. Reveals no configuration details. */
export async function GET() {
  const checks: Record<string, 'ok' | 'down' | 'disabled'> = {};

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = 'ok';
  } catch {
    checks.database = 'down';
  }

  const redis = getRedis();
  if (!redis) checks.redis = 'disabled';
  else {
    try {
      await redis.ping();
      checks.redis = 'ok';
    } catch {
      checks.redis = 'down';
    }
  }

  const healthy = checks.database === 'ok';
  return NextResponse.json({ status: healthy ? 'ok' : 'degraded', checks }, { status: healthy ? 200 : 503 });
}
