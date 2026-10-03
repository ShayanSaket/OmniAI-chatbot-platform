import Link from 'next/link';
import { Compass } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent text-primary">
        <Compass className="h-6 w-6" />
      </span>
      <h1 className="mt-4 text-lg font-semibold">Page not found</h1>
      <p className="mt-1 text-sm text-muted-foreground">The page you&apos;re looking for doesn&apos;t exist or was moved.</p>
      <Button asChild className="mt-5">
        <Link href="/">Go home</Link>
      </Button>
    </div>
  );
}
