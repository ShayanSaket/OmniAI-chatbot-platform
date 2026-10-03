'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { signIn } from 'next-auth/react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { AlertCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api-client';
import { registerSchema, type RegisterInput } from '@/lib/validation';

export function RegisterForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<RegisterInput>({
    resolver: zodResolver(registerSchema),
    defaultValues: { name: '', email: '', password: '', organizationName: '' },
  });

  async function onSubmit(values: RegisterInput) {
    setError(null);
    try {
      await api('/api/auth/register', { method: 'POST', json: values });
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors) {
        for (const [field, messages] of Object.entries(err.fieldErrors)) {
          if (messages?.[0]) form.setError(field as keyof RegisterInput, { message: messages[0] });
        }
      }
      setError(err instanceof Error ? err.message : 'Registration failed.');
      return;
    }
    const result = await signIn('credentials', { email: values.email, password: values.password, redirect: false });
    if (result?.error) {
      router.replace('/login');
      return;
    }
    router.replace('/dashboard');
    router.refresh();
  }

  const submitting = form.formState.isSubmitting;

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            {error}
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Your name</FormLabel>
                <FormControl>
                  <Input autoComplete="name" placeholder="Jane Doe" className="h-10" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="organizationName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Company</FormLabel>
                <FormControl>
                  <Input autoComplete="organization" placeholder="ACME GmbH" className="h-10" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Work email</FormLabel>
              <FormControl>
                <Input type="email" autoComplete="email" placeholder="you@company.com" className="h-10" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Password</FormLabel>
              <FormControl>
                <Input type="password" autoComplete="new-password" className="h-10" {...field} />
              </FormControl>
              <FormDescription>At least 10 characters, with a letter and a number.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" className="h-10 w-full" disabled={submitting}>
          {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Create workspace
        </Button>
      </form>
    </Form>
  );
}
