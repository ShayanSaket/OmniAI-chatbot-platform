import { Check, Hammer, type LucideIcon } from 'lucide-react';
import { PageHeader } from './page-header';

/**
 * Placeholder for modules scheduled in a later implementation phase. States plainly
 * that the module is not built yet and what it will contain — no fake data.
 */
export function ModuleRoadmap({
  title,
  description,
  icon: Icon,
  phase,
  capabilities,
}: {
  title: string;
  description: string;
  icon: LucideIcon;
  phase: number;
  capabilities: string[];
}) {
  return (
    <>
      <PageHeader title={title} description={description} />
      <div className="relative overflow-hidden rounded-xl border bg-card">
        <div className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative grid gap-8 p-6 sm:p-10 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div>
            <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent text-primary">
              <Icon className="h-6 w-6" />
            </span>
            <span className="mt-5 inline-flex items-center gap-1.5 rounded-full border bg-muted/60 px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
              <Hammer className="h-3 w-3" /> In development · Phase {phase}
            </span>
            <h2 className="mt-3 text-lg font-semibold tracking-tight">This module isn&apos;t available yet</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
              The data model and permissions for {title.toLowerCase()} are already in place. The working interface
              ships in phase {phase} of the build plan.
            </p>
          </div>
          <ul className="space-y-2.5 self-center">
            {capabilities.map((c) => (
              <li key={c} className="flex items-start gap-2.5 text-sm">
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <Check className="h-3 w-3" strokeWidth={3} />
                </span>
                {c}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </>
  );
}
