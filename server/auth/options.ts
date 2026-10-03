import 'server-only';
import type { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import { loginSchema } from '@/lib/validation';
import { prisma } from '../db';
import { AppError } from '../errors';
import { logger } from '../logger';
import { enforceRateLimit, isRateLimited, RATE_LIMITS, recordRateLimitHit } from '../rate-limit';
import { clientIp, userAgent } from '../request';
import { recordAudit } from '../modules/audit/audit-service';
import { verifyPassword } from './password';

const SESSION_MAX_AGE = 7 * 24 * 60 * 60;

export const authOptions: NextAuthOptions = {
  // Read directly (not via env()) so `next build` can import this module without secrets.
  secret: process.env.AUTH_SECRET,
  session: { strategy: 'jwt', maxAge: SESSION_MAX_AGE },
  pages: { signIn: '/login', error: '/login' },
  providers: [
    CredentialsProvider({
      name: 'Email and password',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials, req) {
        const parsed = loginSchema.safeParse(credentials);
        if (!parsed.success) return null;
        const { email, password } = parsed.data;
        const ip = clientIp(req?.headers);
        const ua = userAgent(req?.headers);

        // Per IP: every attempt counts. Per account: only failures count, so a user signing
        // in on several devices is never locked out, while password guessing still is.
        try {
          await enforceRateLimit(RATE_LIMITS.loginPerIp, ip);
        } catch (err) {
          if (err instanceof AppError) throw new Error('RATE_LIMITED');
          throw err;
        }
        if (await isRateLimited(RATE_LIMITS.loginPerAccount, email)) throw new Error('RATE_LIMITED');

        const user = await prisma.user.findUnique({
          where: { email },
          select: {
            id: true,
            email: true,
            name: true,
            passwordHash: true,
            memberships: { select: { organizationId: true }, orderBy: { createdAt: 'asc' }, take: 1 },
          },
        });
        const valid = await verifyPassword(password, user?.passwordHash);
        const organizationId = user?.memberships[0]?.organizationId;

        if (!user || !valid) {
          await recordRateLimitHit(RATE_LIMITS.loginPerAccount, email);
          if (user && organizationId) {
            await recordAudit({ organizationId, actorId: user.id, action: 'auth.login_failed', ipAddress: ip, userAgent: ua });
          }
          logger.info('login failed', { ip });
          return null;
        }

        await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
        if (organizationId) {
          await recordAudit({ organizationId, actorId: user.id, action: 'auth.login', ipAddress: ip, userAgent: ua });
        }
        return { id: user.id, email: user.email, name: user.name, organizationId };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, trigger, session }) {
      if (user) {
        token.uid = user.id;
        token.orgId = user.organizationId;
      }
      // Organization switch: only to an organization the user actually belongs to.
      if (trigger === 'update' && token.uid && typeof session?.organizationId === 'string') {
        const membership = await prisma.membership.findUnique({
          where: { organizationId_userId: { organizationId: session.organizationId, userId: token.uid } },
          select: { organizationId: true },
        });
        if (membership) token.orgId = membership.organizationId;
      }
      return token;
    },
    async session({ session, token }) {
      if (token.uid) session.user.id = token.uid;
      session.organizationId = token.orgId;
      return session;
    },
  },
};
