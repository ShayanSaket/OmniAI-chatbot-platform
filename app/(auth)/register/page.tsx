import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { RegisterForm } from '@/components/auth/register-form';
import { homePathForRole } from '@/lib/permissions';
import { getAuthContext } from '@/server/auth/session';

export const metadata: Metadata = { title: 'Create your workspace' };

export default async function RegisterPage() {
  const ctx = await getAuthContext();
  if (ctx) redirect(homePathForRole(ctx.role));

  if (process.env.ALLOW_REGISTRATION === 'false') {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Sign-up is invite-only</h1>
        <p className="text-sm text-muted-foreground">
          Ask an administrator of your organization to add you to the team.
        </p>
        <Link href="/login" className="text-sm font-medium text-primary hover:underline">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Create your workspace</h1>
        <p className="text-sm text-muted-foreground">
          Set up your AI agent for website chat and WhatsApp in a few minutes.
        </p>
      </div>
      <RegisterForm />
      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-primary underline-offset-4 hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
