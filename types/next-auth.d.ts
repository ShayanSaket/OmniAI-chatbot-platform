import type { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface Session {
    user: { id: string } & DefaultSession['user'];
    organizationId?: string;
  }
  interface User {
    organizationId?: string;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    uid?: string;
    orgId?: string;
  }
}
