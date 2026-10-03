import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { ZodError, type ZodType, type ZodTypeDef } from 'zod';
import { TenantViolationError } from './tenancy/scope';
import { AppError } from './errors';
import { logger, type Logger } from './logger';
import { requestId as readRequestId } from './request';

export interface RouteContext<P> {
  params: P;
  requestId: string;
  log: Logger;
}

type Handler<P> = (req: NextRequest, ctx: RouteContext<P>) => Promise<Response>;

interface RouteOptions {
  /** Same-origin check for state-changing requests (default true). Disable for provider webhooks. */
  csrf?: boolean;
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_JSON_BYTES = 1_000_000;

/**
 * Cookie-authenticated endpoints must only accept state changes from our own origin.
 * Browsers always send Origin (and Sec-Fetch-Site) on cross-origin unsafe requests.
 */
export function assertSameOrigin(req: Request) {
  const fetchSite = req.headers.get('sec-fetch-site');
  if (fetchSite === 'cross-site') throw new AppError('FORBIDDEN', 'Cross-site request blocked.');
  const origin = req.headers.get('origin');
  if (!origin) return;
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new AppError('FORBIDDEN', 'Invalid origin.');
  }
  if (!host || originHost !== host) throw new AppError('FORBIDDEN', 'Cross-origin request blocked.');
}

export function errorResponse(err: unknown, requestId: string, log: Logger): NextResponse {
  if (err instanceof AppError) {
    const res = NextResponse.json(
      { error: { code: err.code, message: err.message, requestId, details: err.details } },
      { status: err.status },
    );
    const retryAfter = (err.details as { retryAfter?: number } | undefined)?.retryAfter;
    if (retryAfter) res.headers.set('Retry-After', String(retryAfter));
    return res;
  }
  if (err instanceof ZodError) {
    return NextResponse.json(
      {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Some fields are invalid.',
          requestId,
          details: err.flatten().fieldErrors,
        },
      },
      { status: 422 },
    );
  }
  if (err instanceof TenantViolationError) {
    log.error('tenant violation', { err });
    return NextResponse.json({ error: { code: 'FORBIDDEN', message: 'Forbidden.', requestId } }, { status: 403 });
  }
  log.error('unhandled route error', { err });
  return NextResponse.json(
    { error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.', requestId } },
    { status: 500 },
  );
}

export function route<P = Record<string, never>>(handler: Handler<P>, options: RouteOptions = {}) {
  return async (req: NextRequest, { params }: { params: P }): Promise<Response> => {
    const requestId = readRequestId(req.headers);
    const log = logger.child({ requestId, method: req.method, path: req.nextUrl.pathname });
    const started = Date.now();
    try {
      if (options.csrf !== false && UNSAFE_METHODS.has(req.method)) assertSameOrigin(req);
      const res = await handler(req, { params, requestId, log });
      res.headers.set('x-request-id', requestId);
      log.debug('request completed', { status: res.status, durationMs: Date.now() - started });
      return res;
    } catch (err) {
      const res = errorResponse(err, requestId, log);
      res.headers.set('x-request-id', requestId);
      return res;
    }
  };
}

export async function parseJson<T>(req: Request, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
  const length = Number(req.headers.get('content-length') ?? 0);
  if (length > MAX_JSON_BYTES) throw new AppError('BAD_REQUEST', 'Request body is too large.');
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new AppError('BAD_REQUEST', 'Request body must be valid JSON.');
  }
  return schema.parse(body);
}
