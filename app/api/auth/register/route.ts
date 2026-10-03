import { NextResponse } from 'next/server';
import { registerSchema } from '@/lib/validation';
import { env } from '@/server/env';
import { AppError } from '@/server/errors';
import { parseJson, route } from '@/server/http';
import { enforceRateLimit, RATE_LIMITS } from '@/server/rate-limit';
import { clientIp, userAgent } from '@/server/request';
import { registerAccount } from '@/server/modules/organizations/provisioning';

export const POST = route(async (req, { log }) => {
  if (!env().ALLOW_REGISTRATION) {
    throw new AppError('REGISTRATION_DISABLED', 'Self-service sign-up is disabled. Ask an administrator for access.');
  }
  const ip = clientIp(req.headers);
  await enforceRateLimit(RATE_LIMITS.register, ip);

  const input = await parseJson(req, registerSchema);
  const { user, organization } = await registerAccount(input, { ip, userAgent: userAgent(req.headers) });
  log.info('account registered', { userId: user.id, organizationId: organization.id });

  return NextResponse.json({ data: { userId: user.id, organizationId: organization.id } }, { status: 201 });
});
