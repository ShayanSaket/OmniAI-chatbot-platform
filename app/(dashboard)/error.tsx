'use client';

import { useEffect } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
        <AlertTriangle className="h-6 w-6" />
      </span>
      <h1 className="mt-4 text-lg font-semibold">Something went wrong</h1>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        We couldn&apos;t load this page. Try again — if it keeps happening, contact support
        {error.digest ? (
          <>
            {' '}
            with reference <code className="rounded bg-muted px-1 py-0.5 text-xs">{error.digest}</code>
          </>
        ) : null}
        .
      </p>
      <Button onClick={reset} variant="outline" className="mt-5">
        <RotateCcw className="mr-2 h-4 w-4" /> Try again
      </Button>
    </div>
  );
}
