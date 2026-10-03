import { NextResponse, type NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';

// Edge middleware: attaches a request id and keeps unauthenticated users out of the
// dashboard. This is a convenience gate only — every page and API handler performs
// its own authorization against the database.

const PROTECTED_PREFIXES = [
  '/dashboard',
  '/inbox',
  '/customers',
  '/leads',
  '/knowledge',
  '/agent',
  '/channels',
  '/automations',
  '/analytics',
  '/integrations',
  '/settings',
];

export async function middleware(req: NextRequest) {
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const headers = new Headers(req.headers);
  headers.set('x-request-id', requestId);

  const { pathname, search } = req.nextUrl;
  const isProtected = PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  // (Signed-in users visiting /login are redirected by the page itself, which can
  // verify the membership still exists — doing it here could loop.)
  if (isProtected) {
    const token = await getToken({ req, secret: process.env.AUTH_SECRET });
    if (!token) {
      const url = new URL('/login', req.url);
      url.searchParams.set('callbackUrl', `${pathname}${search}`);
      return NextResponse.redirect(url);
    }
  }

  const res = NextResponse.next({ request: { headers } });
  res.headers.set('x-request-id', requestId);
  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|js|css)$).*)'],
};
