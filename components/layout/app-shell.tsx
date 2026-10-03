'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu } from 'lucide-react';
import { Logo } from '@/components/brand/logo';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import type { Role } from '@/lib/permissions';
import { cn } from '@/lib/utils';
import { navForRole } from './navigation';
import { NotificationBell } from './notification-bell';
import { ThemeToggle } from './theme-toggle';
import { UserMenu } from './user-menu';

export interface ShellUser {
  name: string | null;
  email: string;
}

interface AppShellProps {
  user: ShellUser;
  organizationName: string;
  role: Role;
  children: React.ReactNode;
}

function SidebarNav({ role, onNavigate }: { role: Role; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex-1 space-y-6 overflow-y-auto px-3 py-4 scrollbar-thin">
      {navForRole(role).map((section, i) => (
        <div key={section.label ?? i}>
          {section.label && (
            <p className="mb-1.5 px-3 text-[11px] font-medium uppercase tracking-wider text-sidebar-muted-foreground/80">
              {section.label}
            </p>
          )}
          <ul className="space-y-0.5">
            {section.items.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'group flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                      active
                        ? 'bg-accent text-accent-foreground'
                        : 'text-sidebar-muted-foreground hover:bg-sidebar-muted hover:text-sidebar-foreground',
                    )}
                  >
                    <Icon
                      className={cn(
                        'h-4 w-4 shrink-0 transition-colors',
                        active ? 'text-primary' : 'text-sidebar-muted-foreground group-hover:text-sidebar-foreground',
                      )}
                    />
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.comingSoon && (
                      <span className="rounded-full bg-sidebar-muted px-1.5 py-px text-[10px] font-medium text-sidebar-muted-foreground">
                        Soon
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function OrgBadge({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');
  return (
    <div className="mx-3 flex items-center gap-2.5 rounded-lg border border-sidebar-border bg-sidebar-muted/50 px-3 py-2">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-foreground text-[11px] font-semibold text-background">
        {initials}
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium leading-tight">{name}</p>
        <p className="text-[11px] text-sidebar-muted-foreground">Workspace</p>
      </div>
    </div>
  );
}

function SidebarContents({ role, organizationName, onNavigate }: { role: Role; organizationName: string; onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-16 items-center px-6">
        <Logo />
      </div>
      <OrgBadge name={organizationName} />
      <SidebarNav role={role} onNavigate={onNavigate} />
    </div>
  );
}

export function AppShell({ user, organizationName, role, children }: AppShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="min-h-screen bg-background">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
      >
        Skip to content
      </a>

      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:block">
        <SidebarContents role={role} organizationName={organizationName} />
      </aside>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-72 bg-sidebar p-0 text-sidebar-foreground">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SidebarContents role={role} organizationName={organizationName} onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur-md sm:px-6 lg:px-8">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation"
          >
            <Menu className="h-5 w-5" />
          </Button>
          <div className="lg:hidden">
            <Logo compact />
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <NotificationBell />
            <ThemeToggle />
            <UserMenu user={user} role={role} />
          </div>
        </header>
        <main id="main" className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
