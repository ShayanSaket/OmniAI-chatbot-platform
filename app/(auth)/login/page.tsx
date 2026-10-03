import { Suspense } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/auth/login-form';
import { homePathForRole } from '@/lib/permissions';
import { getAuthContext } from '@/server/auth/session';
import { DEMO_PASSWORD } from '@/lib/demo';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage() {
  const ctx = await getAuthContext();
  if (ctx) redirect(homePathForRole(ctx.role));

  const showDemo = process.env.NODE_ENV !== 'production';
  const allowRegistration = process.env.ALLOW_REGISTRATION !== 'false';

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
        <p className="text-sm text-muted-foreground">Sign in to your workspace to manage conversations.</p>
      </div>
      <Suspense>
        <LoginForm />
      </Suspense>
      {allowRegistration && (
        <p className="text-center text-sm text-muted-foreground">
          New to OmniAI?{' '}
          <Link href="/register" className="font-medium text-primary underline-offset-4 hover:underline">
            Create a workspace
          </Link>
        </p>
      )}
      {showDemo && (
        <div className="rounded-lg border border-dashed bg-muted/40 p-4 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">
            Demo accounts <span className="font-normal">(after running the seed)</span>
          </p>
          <ul className="mt-2 space-y-1 font-mono">
            <li>owner@novatech.demo</li>
            <li>admin@novatech.demo</li>
            <li>agent@novatech.demo</li>
          </ul>
          <p className="mt-2">
            Password: <span className="font-mono">{DEMO_PASSWORD}</span>
          </p>
        </div>
      )}
    </div>
  );
}
